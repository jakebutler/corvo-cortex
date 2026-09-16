import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, ClientConfig, LLMProvider, RoutingProvider, Variables } from '../types';
import { authMiddleware } from '../middleware/auth';
import {
  telemetryMiddleware,
  updateTelemetryMetadata,
  storeResponseData,
  storeTelemetryUsage,
  setTelemetryCompletion
} from '../middleware/telemetry';
import { determineProvider } from '../services/router';
import { estimateCostFromUsage, estimateRequestMaxCost } from '../services/pricing';
import {
  getCreditBalance,
  isCreditExhaustionResponse,
  markProviderCreditsExhausted,
  reserveCredits,
  settleCredits,
  releaseCreditsReservation,
  resetCreditExhaustionTracking
} from '../services/credits';
import { getAdapterForProvider } from '../utils/transform';
import { resolveModelAlias } from '../utils/model-aliases';
import { createStreamingResponseWithUsage } from '../utils/streaming';
import { fetchWithRetry } from '../utils/retry';
import { createChatCompletionRequestSchema, ChatCompletionRequest } from '../schemas/chat';
import { chatCompletionResponseSchema } from '../schemas/response';
import { parseKinisiRoutingHints } from '../services/routing-hints';
import { getRoutingPolicy } from '../services/routing-policy';
import { isModelAllowedForClient, modelAuthorizationErrorPayload } from '../services/model-authorization';
import { getMaxTokensCeiling } from '../utils/limits';
import { requestBodyLimitMiddleware } from '../middleware/body-limit';
import { buildRoutePlan } from '../services/route-planner';
import {
  createFailureResult,
  createSuccessResult,
  executeRoutePlan
} from '../services/route-executor';
import {
  buildStrictSchemaContext,
  extractSchemaValidationPayload,
  validateStrictSchemaPayload
} from '../services/schema-validation';
import { buildCorvoCortexHeaders } from '../utils/corvo-cortex-headers';
import {
  acquireProviderConcurrencyLease,
  releaseProviderConcurrencyLease
} from '../services/provider-concurrency';
import { circuitBreakerInstanceId } from '../durable-objects/circuit-breaker';

const chatApp = new Hono<{ Bindings: Env; Variables: Variables }>();

type ChatContext = Context<{ Bindings: Env; Variables: Variables }>;

// Apply middleware in order
chatApp.use('*', authMiddleware);
chatApp.use('*', requestBodyLimitMiddleware());
chatApp.use('*', telemetryMiddleware);

interface HeaderMetadata {
  provider?: string;
  model?: string;
  routeId?: string;
  fallbackUsed?: boolean;
  hedgeUsed?: boolean;
  cacheHit?: boolean | 'unknown';
  ttftMs?: number;
  latencyMs?: number;
}

interface ProviderRouteConfig {
  provider: LLMProvider;
  url: string;
  headers: Record<string, string>;
}

/**
 * Check circuit breaker before allowing request
 */
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

/**
 * Record success in circuit breaker
 */
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

/**
 * Record failure in circuit breaker
 */
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

chatApp.post('/', async (c) => {
  const requestStart = Date.now();
  const client = c.get('client');

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    const errorPayload = { error: 'Invalid request', details: 'Request body must be valid JSON' };
    storeResponseData(c, errorPayload);
    setCorvoHeadersOnContext(c, {
      latencyMs: Date.now() - requestStart
    });
    return c.json(errorPayload, 400);
  }

  c.set('requestBody', rawBody);

  const rawModel = getRawModel(rawBody, client.defaultModel);
  updateTelemetryMetadata(c, 'unresolved', rawModel || 'unknown', rawBody);

  const validationResult = createChatCompletionRequestSchema(getMaxTokensCeiling(c.env)).safeParse(rawBody);
  if (!validationResult.success) {
    const errorPayload = {
      error: 'Invalid request',
      details: validationResult.error.errors
    };
    storeResponseData(c, errorPayload);
    setCorvoHeadersOnContext(c, {
      model: rawModel,
      latencyMs: Date.now() - requestStart
    });
    return c.json(errorPayload, 400);
  }

  const body = validationResult.data;
  const hints = parseKinisiRoutingHints(c.req.raw.headers);

  if (hints.enabled) {
    return handleHeaderDrivenRequest(c, body, rawBody, client, hints, requestStart);
  }

  return handleLegacyRequest(c, body, rawBody, client, requestStart);
});

async function handleHeaderDrivenRequest(
  c: ChatContext,
  body: ChatCompletionRequest,
  rawBody: unknown,
  client: ClientConfig,
  hints: ReturnType<typeof parseKinisiRoutingHints>,
  requestStart: number
): Promise<Response> {
  const policy = await getRoutingPolicy(c.env);
  if (!policy.enabled) {
    return handleLegacyRequest(c, body, rawBody, client, requestStart);
  }

  const strictSchemaContext = buildStrictSchemaContext(rawBody);
  if (strictSchemaContext.enabled && body.stream) {
    const errorPayload = {
      error: {
        class: 'invalid_request',
        message: 'stream=true is not supported with response_format.json_schema strict mode'
      }
    };
    storeResponseData(c, errorPayload);
    setCorvoHeadersOnContext(c, {
      model: getRawModel(rawBody, client.defaultModel),
      latencyMs: Date.now() - requestStart
    });
    return c.json(errorPayload, 400);
  }

  const model = resolveModelAlias(hints.requestedModel || body.model || client.defaultModel || 'gpt-4o');

  if (!isModelAllowedForClient(client, model)) {
    const errorPayload = modelAuthorizationErrorPayload(model);
    storeResponseData(c, errorPayload);
    setCorvoHeadersOnContext(c, {
      model,
      latencyMs: Date.now() - requestStart
    });
    return c.json(errorPayload, 403);
  }

  const routePlan = buildRoutePlan(policy, hints, model);

  updateTelemetryMetadata(c, 'unresolved', routePlan.model || model, rawBody, {
    routing_stage: routePlan.stage,
    routing_strategy: routePlan.strategy,
    route_id: routePlan.routeId,
    request_role: routePlan.requestRole
  });

  let winnerReservation: { provider: LLMProvider; reservationId: string } | null = null;
  let reservationClaimed = false;
  const claimWinnerReservation = (): { provider: LLMProvider; reservationId: string } | null => {
    return winnerReservation;
  };

  const executionResult = await executeRoutePlan<unknown>({
    plan: routePlan,
    attempt: async (candidate, context) => {
      const route = resolveHeaderModeRoute(candidate.provider, c.env);

      const circuitCheck = await checkCircuitBreaker(c.env, route.provider);
      if (!circuitCheck.allowed) {
        return createFailureResult('upstream_5xx', circuitCheck.reason || 'Circuit breaker open', true);
      }

      const providerBalance = await getCreditBalance(c.env, route.provider);
      if (providerBalance.exhausted || (providerBalance.configured && providerBalance.available <= 0)) {
        return createFailureResult('upstream_5xx', 'Provider credits exhausted', false);
      }

      let reservationId: string | undefined;
      if (providerBalance.configured) {
        const estimate = await estimateRequestMaxCost({
          env: c.env,
          provider: route.provider,
          model: candidate.model,
          input: body.messages,
          maxTokens: body.max_tokens
        });
        const reservation = await reserveCredits(c.env, route.provider, estimate);
        if (!reservation.ok || !reservation.reservationId) {
          updateTelemetryMetadata(c, route.provider, candidate.model, rawBody, {
            credit_reservation_declined: reservation.reason || 'error'
          });
          return createFailureResult('upstream_5xx', 'Insufficient provider credits', false);
        }
        reservationId = reservation.reservationId;
      }

      const claimOrReleaseReservation = (): void => {
        if (!reservationId) return;
        if (!reservationClaimed) {
          reservationClaimed = true;
          winnerReservation = { provider: route.provider, reservationId };
          return;
        }
        void releaseCreditsReservation(c.env, route.provider, reservationId);
      };

      const adapter = getAdapterForProvider(route.provider);
      const providerRequest = adapter.transformRequest({ ...body, model: candidate.model });

      let response: Response;
      try {
        response = await fetch(route.url, {
          method: 'POST',
          headers: route.headers,
          body: JSON.stringify(providerRequest),
          signal: context.signal as RequestInit['signal']
        });
      } catch (error) {
        if (reservationId) void releaseCreditsReservation(c.env, route.provider, reservationId);
        await recordCircuitBreakerFailure(c.env, route.provider);
        return classifyUnknownFailure(error);
      }

      if (!response.ok) {
        if (reservationId) void releaseCreditsReservation(c.env, route.provider, reservationId);
        await recordCircuitBreakerFailure(c.env, route.provider);
        const details = await response.text().catch(() => 'Unknown upstream error');
        return classifyStatusFailure(response.status, details);
      }

      await recordCircuitBreakerSuccess(c.env, route.provider);
      resetCreditExhaustionTracking(route.provider);

      const cacheHit = toAttemptCacheHit(parseCacheHit(response.headers));
      const ttftMs = parseTtftMs(response.headers);

      if (body.stream) {
        claimOrReleaseReservation();
        return createSuccessResult({
          provider: candidate.provider,
          model: candidate.model,
          payload: response,
          cacheHit,
          ttftMs
        });
      }

      let upstreamJson: unknown;
      try {
        upstreamJson = await response.json();
      } catch (error) {
        if (reservationId) void releaseCreditsReservation(c.env, route.provider, reservationId);
        throw error;
      }
      const transformed = adapter.transformResponse(upstreamJson, candidate.model);

      claimOrReleaseReservation();

      return createSuccessResult({
        provider: candidate.provider,
        model: candidate.model,
        payload: transformed,
        cacheHit,
        ttftMs
      });
    },
    validate: strictSchemaContext.enabled && !body.stream
      ? async (payload) => {
          const schemaPayload = extractSchemaValidationPayload(payload);
          const validation = validateStrictSchemaPayload(schemaPayload, strictSchemaContext);
          return {
            valid: validation.valid,
            reason: validation.reason,
            message: validation.message
          };
        }
      : undefined
  });

  if (!executionResult.ok) {
    const status = executionResult.errorClass === 'schema_invalid' ? 422 : 503;
    const errorPayload = {
      error: {
        class: executionResult.errorClass,
        stage: routePlan.stage,
        strategy: routePlan.strategy,
        route_id: routePlan.routeId,
        reason_codes: executionResult.reasonCodes,
        message: executionResult.errorClass === 'schema_invalid'
          ? 'All candidate responses failed caller-provided JSON schema'
          : 'No upstream route satisfied constraints and schema guarantees'
      }
    };

    storeResponseData(c, errorPayload);
    setCorvoHeadersOnContext(c, {
      model: routePlan.model,
      routeId: routePlan.routeId,
      fallbackUsed: executionResult.fallbackUsed,
      hedgeUsed: executionResult.hedgeUsed,
      cacheHit: 'unknown',
      latencyMs: executionResult.latencyMs
    });

    updateTelemetryMetadata(c, 'unresolved', routePlan.model || model, rawBody, {
      routing_stage: routePlan.stage,
      routing_strategy: routePlan.strategy,
      route_id: routePlan.routeId,
      request_role: routePlan.requestRole,
      failure_reason_codes: executionResult.reasonCodes,
      fallback_used: executionResult.fallbackUsed,
      hedge_used: executionResult.hedgeUsed,
      schema_valid: executionResult.errorClass !== 'schema_invalid'
    });

    return c.json(errorPayload, status);
  }

  const winnerProvider = executionResult.winner.provider as LLMProvider;
  updateTelemetryMetadata(c, winnerProvider, executionResult.winner.model, rawBody, {
    routing_stage: routePlan.stage,
    routing_strategy: routePlan.strategy,
    route_id: routePlan.routeId,
    request_role: routePlan.requestRole,
    fallback_used: executionResult.fallbackUsed,
    hedge_used: executionResult.hedgeUsed,
    schema_valid: true
  });

  const claimedReservation = claimWinnerReservation();
  const winnerReservationId = claimedReservation?.reservationId;
  const finalBalance = await getCreditBalance(c.env, winnerProvider);
  let settled = false;

  const settleWinnerReservation = async (actualCost: number): Promise<void> => {
    if (!winnerReservationId) return;
    settled = true;
    const result = await settleCredits(c.env, winnerProvider, winnerReservationId, actualCost);
    if (!result.ok) {
      console.warn(`Credit settle declined for ${winnerProvider} (reservation ${winnerReservationId})`);
      updateTelemetryMetadata(c, winnerProvider, executionResult.winner.model, rawBody, {
        credit_settle_declined: true
      });
    }
  };

  if (body.stream) {
    const upstreamResponse = executionResult.value as Response;

    let resolveTelemetryCompletion: (() => void) | undefined;
    const telemetryCompletion = new Promise<void>((resolve) => {
      resolveTelemetryCompletion = resolve;
    });
    setTelemetryCompletion(c, telemetryCompletion);

    let streamUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
    let streamOutput = '';

    try {
      const streamingResponse = await createStreamingResponseWithUsage(upstreamResponse, {
        onChunk: (chunk) => {
          streamOutput += chunk;
        },
        onUsage: async (usage) => {
          streamUsage = usage;
          storeTelemetryUsage(c, usage);

          if (!finalBalance.configured) {
            await settleWinnerReservation(0);
            return;
          }

          const cost = await estimateCostFromUsage({
            env: c.env,
            provider: winnerProvider,
            model: executionResult.winner.model,
            promptTokens: usage.prompt_tokens || 0,
            completionTokens: usage.completion_tokens || 0
          });

          await settleWinnerReservation(cost);
        },
        onDone: async () => {
          if (!settled) {
            await settleWinnerReservation(0);
          }
          storeResponseData(c, {
            stream: true,
            output: streamOutput,
            usage: streamUsage
          });
          resolveTelemetryCompletion?.();
        },
        onError: async (error) => {
          if (!settled && winnerReservationId) {
            await releaseCreditsReservation(c.env, winnerProvider, winnerReservationId);
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

      setCorvoHeadersOnResponse(streamingResponse, {
        provider: winnerProvider,
        model: executionResult.winner.model,
        routeId: routePlan.routeId,
        fallbackUsed: executionResult.fallbackUsed,
        hedgeUsed: executionResult.hedgeUsed,
        cacheHit: executionResult.cacheHit,
        ttftMs: executionResult.ttftMs,
        latencyMs: executionResult.latencyMs
      });

      return streamingResponse;
    } catch (streamError) {
      resolveTelemetryCompletion?.();
      throw streamError;
    }
  }

  const responsePayload = executionResult.value as {
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    [key: string]: unknown;
  };

  storeResponseData(c, responsePayload);
  if (responsePayload.usage) {
    storeTelemetryUsage(c, responsePayload.usage);
  }

  if (finalBalance.configured && responsePayload.usage) {
    const cost = await estimateCostFromUsage({
      env: c.env,
      provider: winnerProvider,
      model: executionResult.winner.model,
      promptTokens: responsePayload.usage.prompt_tokens || 0,
      completionTokens: responsePayload.usage.completion_tokens || 0
    });
    await settleWinnerReservation(cost);
  } else {
    await settleWinnerReservation(0);
  }

  setCorvoHeadersOnContext(c, {
    provider: winnerProvider,
    model: executionResult.winner.model,
    routeId: routePlan.routeId,
    fallbackUsed: executionResult.fallbackUsed,
    hedgeUsed: executionResult.hedgeUsed,
    cacheHit: executionResult.cacheHit,
    ttftMs: executionResult.ttftMs,
    latencyMs: executionResult.latencyMs
  });

  return c.json(responsePayload);
}

async function handleLegacyRequest(
  c: ChatContext,
  body: ChatCompletionRequest,
  rawBody: unknown,
  client: ClientConfig,
  requestStart: number,
  hasRetriedCreditFallback = false
): Promise<Response> {
  const model = resolveModelAlias(body.model || client.defaultModel || 'gpt-4o');
  const routeId = createLegacyRouteId();

  if (!isModelAllowedForClient(client, model)) {
    const errorPayload = modelAuthorizationErrorPayload(model);
    storeResponseData(c, errorPayload);
    setCorvoHeadersOnContext(c, {
      model,
      routeId,
      fallbackUsed: false,
      hedgeUsed: false,
      latencyMs: Date.now() - requestStart
    });
    return c.json(errorPayload, 403);
  }

  let route: Awaited<ReturnType<typeof determineProvider>>;
  try {
    route = await determineProvider(model, client, c.env);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Payment Required')) {
      const errorPayload = {
        error: 'Payment Required',
        message: error.message
      };
      storeResponseData(c, errorPayload);
      setCorvoHeadersOnContext(c, {
        model,
        routeId,
        fallbackUsed: false,
        hedgeUsed: false,
        latencyMs: Date.now() - requestStart
      });
      return c.json(errorPayload, 402);
    }

    const errorPayload = { error: 'Internal server error' };
    storeResponseData(c, errorPayload);
    setCorvoHeadersOnContext(c, {
      model,
      routeId,
      fallbackUsed: false,
      hedgeUsed: false,
      latencyMs: Date.now() - requestStart
    });
    return c.json(errorPayload, 500);
  }

  updateTelemetryMetadata(c, route.provider, model, rawBody);

  const circuitCheck = await checkCircuitBreaker(c.env, route.provider);
  if (!circuitCheck.allowed) {
    const errorPayload = {
      error: 'Service temporarily unavailable',
      reason: circuitCheck.reason || 'Circuit breaker is open',
      provider: route.provider
    };
    storeResponseData(c, errorPayload);
    setCorvoHeadersOnContext(c, {
      provider: route.provider,
      model,
      routeId,
      fallbackUsed: Boolean(route.fallback),
      hedgeUsed: false,
      latencyMs: Date.now() - requestStart
    });
    return c.json(errorPayload, 503);
  }

  const preBalance = await getCreditBalance(c.env, route.provider);
  if ((preBalance.exhausted || (preBalance.configured && preBalance.available <= 0)) && route.provider !== 'openrouter') {
    if (client.fallbackStrategy === 'fail-fast') {
      const errorPayload = {
        error: 'Payment Required',
        message: 'Provider credits exhausted. Fail-fast policy enabled.',
        provider: route.provider
      };
      storeResponseData(c, errorPayload);
      setCorvoHeadersOnContext(c, {
        provider: route.provider,
        model,
        routeId,
        fallbackUsed: false,
        hedgeUsed: false,
        latencyMs: Date.now() - requestStart
      });
      return c.json(errorPayload, 402);
    }

    route = {
      provider: 'openrouter',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${c.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://cortex.corvolabs.com',
        'X-Title': 'Corvo Cortex'
      },
      fallback: { reason: 'insufficient_credits', from: route.provider }
    };
  }

  const adapter = getAdapterForProvider(route.provider);
  let finalBalance = await getCreditBalance(c.env, route.provider);
  let providerRequest = adapter.transformRequest({ ...body, model });
  const concurrency = await acquireProviderConcurrencyLease(c.env, route.provider, model);

  if (!concurrency.allowed) {
    const errorPayload = {
      error: 'Provider concurrency limit reached',
      provider: route.provider,
      details: `Z.ai concurrency limit reached for model ${model}: ${concurrency.inFlight}/${concurrency.limit} in-flight`
    };
    storeResponseData(c, errorPayload);
    setCorvoHeadersOnContext(c, {
      provider: route.provider,
      model,
      routeId,
      fallbackUsed: Boolean(route.fallback),
      hedgeUsed: false,
      latencyMs: Date.now() - requestStart
    });
    return c.json(errorPayload, 429);
  }

  let concurrencyLease = concurrency.lease;
  let leaseReleasedByStreamLifecycle = false;

  const releaseConcurrencyLease = async (): Promise<void> => {
    if (!concurrencyLease) return;
    const leaseToRelease = concurrencyLease;
    concurrencyLease = undefined;
    await releaseProviderConcurrencyLease(c.env, leaseToRelease);
  };

  let reservationId: string | undefined;
  let estimateForReservation = 0;
  if (finalBalance.configured && route.provider !== 'openrouter') {
    const estimate = await estimateRequestMaxCost({
      env: c.env,
      provider: route.provider,
      model,
      input: body.messages,
      maxTokens: body.max_tokens
    });
    const reservation = await reserveCredits(c.env, route.provider, estimate);
    if (!reservation.ok || !reservation.reservationId) {
      await releaseConcurrencyLease();
      updateTelemetryMetadata(c, route.provider, model, rawBody, {
        credit_reservation_declined: reservation.reason || 'error'
      });

      if (client.fallbackStrategy === 'fail-fast') {
        const errorPayload = {
          error: 'Payment Required',
          message: 'Provider credits exhausted. Fail-fast policy enabled.',
          provider: route.provider
        };
        storeResponseData(c, errorPayload);
        setCorvoHeadersOnContext(c, {
          provider: route.provider,
          model,
          routeId,
          fallbackUsed: false,
          hedgeUsed: false,
          latencyMs: Date.now() - requestStart
        });
        return c.json(errorPayload, 402);
      }

      route = {
        provider: 'openrouter',
        url: 'https://openrouter.ai/api/v1/chat/completions',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${c.env.OPENROUTER_API_KEY}`,
          'HTTP-Referer': 'https://cortex.corvolabs.com',
          'X-Title': 'Corvo Cortex'
        },
        fallback: { reason: 'insufficient_credits', from: route.provider }
      };
      finalBalance = await getCreditBalance(c.env, route.provider);
      providerRequest = getAdapterForProvider(route.provider).transformRequest({ ...body, model });
    } else {
      reservationId = reservation.reservationId;
      estimateForReservation = estimate;
    }
  }

  let settled = false;
  const settleReservation = async (actualCost: number): Promise<void> => {
    if (!reservationId) return;
    const id = reservationId;
    reservationId = undefined;
    settled = true;
    const result = await settleCredits(c.env, route.provider, id, actualCost);
    if (!result.ok) {
      console.warn(`Credit settle declined for ${route.provider} (reservation ${id})`);
      updateTelemetryMetadata(c, route.provider, model, rawBody, {
        credit_settle_declined: true
      });
    }
  };

  try {
    const response = await fetchWithRetry(
      route.url,
      {
        method: 'POST',
        headers: route.headers,
        body: JSON.stringify(providerRequest)
      },
      {
        maxRetries: 3,
        baseDelay: 100,
        maxDelay: 10000,
        onRetry: (attempt, error) => {
          // nosemgrep: javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring
          console.warn(`Retry attempt ${attempt} for ${route.provider}:`, error.message);
        }
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      await settleReservation(0);

      if (
        !hasRetriedCreditFallback
        && route.provider !== 'openrouter'
        && client.fallbackStrategy !== 'fail-fast'
        && isCreditExhaustionResponse(route.provider, response.status, errorText)
      ) {
        await markProviderCreditsExhausted(c.env, route.provider);
        await releaseConcurrencyLease();
        return handleLegacyRequest(c, body, rawBody, client, requestStart, true);
      }

      await recordCircuitBreakerFailure(c.env, route.provider);

      const errorPayload = {
        error: 'Provider error',
        provider: route.provider,
        details: errorText
      };
      storeResponseData(c, errorPayload);
      setCorvoHeadersOnContext(c, {
        provider: route.provider,
        model,
        routeId,
        fallbackUsed: Boolean(route.fallback),
        hedgeUsed: false,
        cacheHit: parseCacheHit(response.headers),
        ttftMs: parseTtftMs(response.headers),
        latencyMs: Date.now() - requestStart
      });
      return c.json(errorPayload, response.status as 400 | 500 | 502 | 503);
    }

    await recordCircuitBreakerSuccess(c.env, route.provider);
    resetCreditExhaustionTracking(route.provider);

    if (body.stream) {
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

            if (!finalBalance.configured) {
              await settleReservation(0);
              return;
            }

            const cost = await estimateCostFromUsage({
              env: c.env,
              provider: route.provider,
              model,
              promptTokens: usage.prompt_tokens || 0,
              completionTokens: usage.completion_tokens || 0
            });
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
            await releaseConcurrencyLease();
            resolveTelemetryCompletion?.();
          },
          onError: async (error) => {
            if (!settled && reservationId) {
              await releaseCreditsReservation(c.env, route.provider, reservationId);
              reservationId = undefined;
              settled = true;
            }
            storeResponseData(c, {
              stream: true,
              output: streamOutput,
              usage: streamUsage,
              error: error instanceof Error ? error.message : 'Stream processing error'
            });
            await releaseConcurrencyLease();
            resolveTelemetryCompletion?.();
          }
        });

        const contentType = streamingResponse.headers.get('Content-Type') || '';
        leaseReleasedByStreamLifecycle = contentType.includes('text/event-stream');
        if (!leaseReleasedByStreamLifecycle) {
          await releaseConcurrencyLease();
        }

        setCorvoHeadersOnResponse(streamingResponse, {
          provider: route.provider,
          model,
          routeId,
          fallbackUsed: Boolean(route.fallback),
          hedgeUsed: false,
          cacheHit: parseCacheHit(response.headers),
          ttftMs: parseTtftMs(response.headers),
          latencyMs: Date.now() - requestStart
        });

        return streamingResponse;
      } catch (streamError) {
        resolveTelemetryCompletion?.();
        throw streamError;
      }
    }

    const responseData = await response.json();

    const responseValidation = chatCompletionResponseSchema.safeParse(responseData);
    if (!responseValidation.success) {
      console.warn('Response validation failed:', responseValidation.error.errors);
    }

    const openaiResponse = adapter.transformResponse(responseData, model);
    storeResponseData(c, openaiResponse);
    if (openaiResponse.usage) {
      storeTelemetryUsage(c, openaiResponse.usage);
    }

    if (finalBalance.configured && openaiResponse.usage) {
      const cost = await estimateCostFromUsage({
        env: c.env,
        provider: route.provider,
        model,
        promptTokens: openaiResponse.usage.prompt_tokens || 0,
        completionTokens: openaiResponse.usage.completion_tokens || 0
      });
      await settleReservation(cost);
    } else {
      await settleReservation(0);
    }

    setCorvoHeadersOnContext(c, {
      provider: route.provider,
      model,
      routeId,
      fallbackUsed: Boolean(route.fallback),
      hedgeUsed: false,
      cacheHit: parseCacheHit(response.headers),
      ttftMs: parseTtftMs(response.headers),
      latencyMs: Date.now() - requestStart
    });

    return c.json(openaiResponse);
  } catch (error) {
    await settleReservation(estimateForReservation);
    await recordCircuitBreakerFailure(c.env, route.provider);

    const errorPayload = {
      error: 'Failed to complete request',
      provider: route.provider,
      details: error instanceof Error ? error.message : 'Unknown error'
    };
    storeResponseData(c, errorPayload);
    setCorvoHeadersOnContext(c, {
      provider: route.provider,
      model,
      routeId,
      fallbackUsed: Boolean(route.fallback),
      hedgeUsed: false,
      latencyMs: Date.now() - requestStart
    });
    return c.json(errorPayload, 500);
  } finally {
    if (!leaseReleasedByStreamLifecycle) {
      await releaseConcurrencyLease();
    }
  }
}

function resolveHeaderModeRoute(provider: RoutingProvider, env: Env): ProviderRouteConfig {
  if (provider === 'fireworks') {
    return {
      provider: 'fireworks',
      url: 'https://api.fireworks.ai/inference/v1/chat/completions',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.FIREWORKS_API_KEY}`
      }
    };
  }

  return {
    provider: 'openrouter',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://cortex.corvolabs.com',
      'X-Title': 'Corvo Cortex'
    }
  };
}

function classifyStatusFailure(status: number, details: string) {
  if (status === 429) {
    return createFailureResult('throttled', details, true, status);
  }

  if (status === 408 || status === 504) {
    return createFailureResult('timeout', details, true, status);
  }

  if (status >= 500) {
    return createFailureResult('upstream_5xx', details, true, status);
  }

  if (status >= 400) {
    return createFailureResult('upstream_4xx', details, false, status);
  }

  return createFailureResult('upstream_5xx', details, true, status);
}

function classifyUnknownFailure(error: unknown) {
  if (error instanceof Error) {
    const message = error.message || 'Unknown upstream error';
    if (message.toLowerCase().includes('timeout') || message.toLowerCase().includes('abort')) {
      return createFailureResult('timeout', message, true);
    }

    return createFailureResult('upstream_5xx', message, true);
  }

  return createFailureResult('upstream_5xx', 'Unknown upstream error', true);
}

function setCorvoHeadersOnContext(c: { header: (name: string, value: string) => void }, metadata: HeaderMetadata): void {
  const headers = buildCorvoCortexHeaders(metadata);
  for (const [name, value] of Object.entries(headers)) {
    c.header(name, value);
  }
}

function setCorvoHeadersOnResponse(response: Response, metadata: HeaderMetadata): void {
  const headers = buildCorvoCortexHeaders(metadata);
  for (const [name, value] of Object.entries(headers)) {
    response.headers.set(name, value);
  }
}

function parseCacheHit(headers: Headers): boolean | 'unknown' {
  const values = [
    headers.get('x-cache-hit'),
    headers.get('x-cache'),
    headers.get('cf-cache-status')
  ].filter((value): value is string => Boolean(value));

  if (!values.length) return 'unknown';

  const normalized = values.join(' ').toLowerCase();
  if (normalized.includes('hit')) return true;
  if (normalized.includes('miss')) return false;
  return 'unknown';
}

function toAttemptCacheHit(value: boolean | 'unknown'): boolean | undefined {
  if (value === 'unknown') {
    return undefined;
  }
  return value;
}

function parseTtftMs(headers: Headers): number | undefined {
  const raw = headers.get('x-ttft-ms')
    || headers.get('x-openrouter-ttft-ms')
    || headers.get('ttft-ms');

  if (!raw) return undefined;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

function getRawModel(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const model = (body as { model?: unknown }).model;
    if (typeof model === 'string' && model.trim().length > 0) {
      return model;
    }
  }

  return fallback;
}

function createLegacyRouteId(): string {
  const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (webCrypto && typeof webCrypto.randomUUID === 'function') {
    return `legacy-${webCrypto.randomUUID()}`;
  }

  return `legacy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default chatApp;
