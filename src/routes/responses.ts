import { Hono } from 'hono';
import { z } from 'zod';
import type { Env, LLMProvider, Variables } from '../types';
import { authMiddleware } from '../middleware/auth';
import { requestBodyLimitMiddleware } from '../middleware/body-limit';
import { getMaxTokensCeiling } from '../utils/limits';
import { isModelAllowedForClient, modelAuthorizationErrorPayload } from '../services/model-authorization';
import { responsesRequestSchema } from '../schemas/responses';
import { buildCorvoCortexHeaders, CorvoCortexHeaderInput } from '../utils/corvo-cortex-headers';
import {
  telemetryMiddleware,
  updateTelemetryMetadata,
  storeResponseData,
  storeTelemetryUsage,
  storeTelemetryCost,
  setTelemetryCompletion
} from '../middleware/telemetry';
import { getCreditBalance, reserveCredits, settleCredits, releaseCreditsReservation } from '../services/credits';
import { estimateCostFromUsage, estimateRequestMaxCost } from '../services/pricing';
import { createStreamingResponseWithUsage } from '../utils/streaming';
import { fetchWithRetry } from '../utils/retry';
import { circuitBreakerInstanceId } from '../durable-objects/circuit-breaker';
import { buildUpstreamErrorEnvelope, classifyUnknownUpstreamError, logUpstreamError, logUpstreamException } from '../utils/error-sanitizer';
import { createAbortHandle } from '../utils/abort';

const responsesApp = new Hono<{ Bindings: Env; Variables: Variables }>();

const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;

responsesApp.use('*', authMiddleware);
responsesApp.use('*', requestBodyLimitMiddleware());
responsesApp.use('*', telemetryMiddleware);

function setCorvoHeaders(c: { header: (name: string, value: string) => void }, metadata: CorvoCortexHeaderInput): void {
  const headers = buildCorvoCortexHeaders(metadata);
  for (const [name, value] of Object.entries(headers)) {
    c.header(name, value);
  }
}

async function checkCircuitBreaker(
  env: Env,
  provider: string
): Promise<{ allowed: boolean; reason?: string }> {
  if (!env.CIRCUIT_BREAKER) {
    return { allowed: true };
  }

  const stub = env.CIRCUIT_BREAKER.get(env.CIRCUIT_BREAKER.idFromName(circuitBreakerInstanceId()));
  const response = await stub.fetch(
    new Request('https://circuit-breaker/check', {
      method: 'POST',
      body: JSON.stringify({ provider })
    })
  );

  try {
    return await response.json() as { allowed: boolean; reason?: string };
  } catch {
    return { allowed: true };
  }
}

async function recordCircuitBreakerSuccess(env: Env, provider: string): Promise<void> {
  if (!env.CIRCUIT_BREAKER) return;

  const stub = env.CIRCUIT_BREAKER.get(env.CIRCUIT_BREAKER.idFromName(circuitBreakerInstanceId()));
  await stub.fetch(
    new Request('https://circuit-breaker/recordSuccess', {
      method: 'POST',
      body: JSON.stringify({ provider })
    })
  );
}

async function recordCircuitBreakerFailure(env: Env, provider: string): Promise<void> {
  if (!env.CIRCUIT_BREAKER) return;

  const stub = env.CIRCUIT_BREAKER.get(env.CIRCUIT_BREAKER.idFromName(circuitBreakerInstanceId()));
  await stub.fetch(
    new Request('https://circuit-breaker/recordFailure', {
      method: 'POST',
      body: JSON.stringify({ provider })
    })
  );
}

responsesApp.post('/', async (c) => {
  const requestStart = Date.now();

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    const errorPayload = { error: 'Invalid request', details: 'Request body must be valid JSON' };
    storeResponseData(c, errorPayload);
    setCorvoHeaders(c, { provider: 'fireworks', latencyMs: Date.now() - requestStart });
    return c.json(errorPayload, 400);
  }
  c.set('requestBody', rawBody);
  const bodyRecord = rawBody as Record<string, unknown>;

  const validationResult = responsesRequestSchema(getMaxTokensCeiling(c.env)).safeParse(rawBody);
  if (!validationResult.success) {
    const errorPayload = {
      error: 'Invalid request',
      details: validationResult.error.errors
    };
    storeResponseData(c, errorPayload);
    setCorvoHeaders(c, { provider: 'fireworks', latencyMs: Date.now() - requestStart });
    return c.json(errorPayload, 400);
  }

  const body = validationResult.data;
  const model = body.model;

  const client = c.get('client');
  if (!isModelAllowedForClient(client, model)) {
    const errorPayload = modelAuthorizationErrorPayload(model);
    storeResponseData(c, errorPayload);
    setCorvoHeaders(c, { provider: 'fireworks', model, latencyMs: Date.now() - requestStart });
    return c.json(errorPayload, 403);
  }

  const maxTokensCheck = z.number().int().positive().max(getMaxTokensCeiling(c.env))
    .safeParse(bodyRecord?.max_tokens);
  if (bodyRecord?.max_tokens !== undefined && !maxTokensCheck.success) {
    const errorPayload = {
      error: 'Invalid request',
      details: `max_tokens must be a positive integer not exceeding ${getMaxTokensCeiling(c.env)}`
    };
    storeResponseData(c, errorPayload);
    setCorvoHeaders(c, { provider: 'fireworks', model, latencyMs: Date.now() - requestStart });
    return c.json(errorPayload, 400);
  }

  const provider: LLMProvider = 'fireworks';
  updateTelemetryMetadata(c, provider, model, rawBody);

  const circuitCheck = await checkCircuitBreaker(c.env, provider);
  if (!circuitCheck.allowed) {
    const errorPayload = {
      error: 'Service temporarily unavailable',
      reason: circuitCheck.reason || 'Circuit breaker is open',
      provider
    };
    storeResponseData(c, errorPayload);
    setCorvoHeaders(c, { provider, model, fallbackUsed: false, hedgeUsed: false, latencyMs: Date.now() - requestStart });
    return c.json(errorPayload, 503);
  }

  const balance = await getCreditBalance(c.env, provider);
  if (balance.exhausted || (balance.configured && balance.available <= 0)) {
    setCorvoHeaders(c, { provider, model, fallbackUsed: false, latencyMs: Date.now() - requestStart });
    c.header('X-Corvo-Provider', provider);
    setCorvoHeaders(c, { provider, model, fallbackUsed: false, latencyMs: Date.now() - requestStart });
    c.header('X-Corvo-Provider', provider);
    c.header('X-Corvo-Fallback', 'false');
    c.header('X-Corvo-Fallback-Reason', 'insufficient_credits');
    const errorPayload = {
      error: 'Payment Required',
      message: 'Provider credits exhausted.',
      provider
    };
    storeResponseData(c, errorPayload);
    return c.json(errorPayload, 402);
  }

  let reservationId: string | undefined;
  let estimateForReservation = 0;
  if (balance.configured) {
    const rawRecord = rawBody as Record<string, unknown>;
    const estimate = await estimateRequestMaxCost({
      env: c.env,
      provider,
      model,
      input: rawRecord?.input ?? rawRecord?.messages,
      maxTokens: typeof rawRecord?.max_tokens === 'number' ? rawRecord.max_tokens : undefined
    });
    const reservation = await reserveCredits(c.env, provider, estimate);
    if (!reservation.ok || !reservation.reservationId) {
      c.header('X-Corvo-Provider', provider);
      c.header('X-Corvo-Fallback', 'false');
      c.header('X-Corvo-Fallback-Reason', 'insufficient_credits');
      const errorPayload = {
        error: 'Payment Required',
        message: 'Insufficient provider credits.',
        provider
      };
      storeResponseData(c, errorPayload);
      return c.json(errorPayload, 402);
    }
    reservationId = reservation.reservationId;
    estimateForReservation = estimate;
  }

  let settled = false;
  const settleReservation = async (actualCost: number): Promise<void> => {
    if (!reservationId) return;
    const id = reservationId;
    reservationId = undefined;
    settled = true;
    const result = await settleCredits(c.env, provider, id, actualCost);
    if (!result.ok) {
      console.warn(`Credit settle declined for ${provider} (reservation ${id})`);
      updateTelemetryMetadata(c, provider, model, rawBody, {
        credit_settle_declined: true
      });
    }
  };

  const route = {
    provider,
    url: 'https://api.fireworks.ai/inference/v1/responses',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${c.env.FIREWORKS_API_KEY}`
    }
  };

  const upstreamController = createAbortHandle();
  const upstreamTimeout = setTimeout(() => upstreamController?.abort(), DEFAULT_PROVIDER_TIMEOUT_MS);
  try {
    const response = await fetchWithRetry(
      route.url,
      {
        method: 'POST',
        headers: route.headers,
        body: JSON.stringify(body)
      },
      {
        maxRetries: 3,
        baseDelay: 100,
        maxDelay: 10000,
        signal: upstreamController?.signal,
        onRetry: (attempt, error) => {
          // nosemgrep: javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring
          console.warn(`Retry attempt ${attempt} for ${route.provider}:`, error.message);
        }
      }
    );
    clearTimeout(upstreamTimeout);

    if (!response.ok) {
      await recordCircuitBreakerFailure(c.env, route.provider);
      await settleReservation(0);

      const errorText = await response.text();
      logUpstreamError(route.provider, response.status, errorText);
      updateTelemetryMetadata(c, route.provider, model, rawBody, {
        upstream_error: errorText.slice(0, 2000)
      });
      const errorPayload = {
        error: 'Provider error',
        provider: route.provider,
        details: buildUpstreamErrorEnvelope(route.provider, response.status)
      };
      storeResponseData(c, errorPayload);
      return c.json(errorPayload, response.status as 400 | 500 | 502 | 503);
    }

    await recordCircuitBreakerSuccess(c.env, route.provider);

    const isStreaming = body.stream === true;
    if (isStreaming) {
      let resolveTelemetryCompletion: (() => void) | undefined;
      const telemetryCompletion = new Promise<void>((resolve) => {
        resolveTelemetryCompletion = resolve;
      });
      setTelemetryCompletion(c, telemetryCompletion);

      let streamUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
      let streamOutput = '';

      try {
        const streamingResponse = await createStreamingResponseWithUsage(response, {
          onChunk: (chunk) => {
            streamOutput += chunk;
          },
          onUsage: async (usage) => {
            streamUsage = usage;
            storeTelemetryUsage(c, usage);

            if (!balance.configured) {
              await settleReservation(0);
              return;
            }
            const cost = await estimateCostFromUsage({
              env: c.env,
              provider,
              model,
              promptTokens: usage.prompt_tokens || 0,
              completionTokens: usage.completion_tokens || 0
            });
            storeTelemetryCost(c, cost);
            await settleReservation(cost);
          },
          onDone: async () => {
            if (!settled) {
              await settleReservation(0);
            }
            storeResponseData(c, {
              stream: true,
              output: streamOutput,
              usage: streamUsage
            });
            resolveTelemetryCompletion?.();
          },
          onError: async (error) => {
            if (!settled && reservationId) {
              await releaseCreditsReservation(c.env, provider, reservationId);
              reservationId = undefined;
              settled = true;
            }
            storeResponseData(c, {
              stream: true,
              output: streamOutput,
              usage: streamUsage,
              error: error instanceof Error ? error.message : 'Stream processing error'
            });
            resolveTelemetryCompletion?.();
          }
        });
        const streamHeaders = buildCorvoCortexHeaders({
          provider,
          model,
          fallbackUsed: false,
          hedgeUsed: false,
          latencyMs: Date.now() - requestStart
        });
        for (const [name, value] of Object.entries(streamHeaders)) {
          streamingResponse.headers.set(name, value);
        }
        streamingResponse.headers.set('X-Corvo-Provider', provider);
        streamingResponse.headers.set('X-Corvo-Fallback', 'false');
        return streamingResponse;
      } catch (streamError) {
        resolveTelemetryCompletion?.();
        throw streamError;
      }
    }

    const responseData = await response.json() as {
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      [key: string]: unknown;
    };
    storeResponseData(c, responseData);
    if (responseData?.usage) {
      storeTelemetryUsage(c, responseData.usage);
    }

    if (balance.configured && responseData?.usage) {
      const cost = await estimateCostFromUsage({
        env: c.env,
        provider,
        model,
        promptTokens: responseData.usage.prompt_tokens || 0,
        completionTokens: responseData.usage.completion_tokens || 0
      });
      storeTelemetryCost(c, cost);
      await settleReservation(cost);
    } else {
      await settleReservation(0);
    }

    setCorvoHeaders(c, { provider, model, fallbackUsed: false, hedgeUsed: false, latencyMs: Date.now() - requestStart });
    c.header('X-Corvo-Provider', provider);
    c.header('X-Corvo-Fallback', 'false');

    return c.json(responseData);

  } catch (error) {
    await settleReservation(estimateForReservation);
    await recordCircuitBreakerFailure(c.env, provider);

    logUpstreamException(provider, error);
    updateTelemetryMetadata(c, provider, model, rawBody, {
      upstream_error: (error instanceof Error ? error.message : String(error)).slice(0, 2000)
    });

    const errorPayload = {
      error: 'Failed to complete request',
      provider,
      details: classifyUnknownUpstreamError(error)
    };
    storeResponseData(c, errorPayload);
    return c.json(errorPayload, 500);
  }
});

export default responsesApp;
