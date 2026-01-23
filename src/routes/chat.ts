import { Hono } from 'hono';
import type { Env } from '../types';
import { authMiddleware } from '../middleware/auth';
import { rateLimitCheckMiddleware, rateLimitIncrementMiddleware } from '../middleware/rate-limit';
import { telemetryMiddleware, updateTelemetryMetadata, storeResponseData } from '../middleware/telemetry';
import { determineProvider } from '../services/router';
import { estimateCostFromUsage } from '../services/pricing';
import { getCreditBalance, deductCredits } from '../services/credits';
import { getAdapterForProvider } from '../utils/transform';
import { createStreamingResponseWithUsage } from '../utils/streaming';
import { fetchWithRetry } from '../utils/retry';
import { chatCompletionRequestSchema } from '../schemas/chat';
import { chatCompletionResponseSchema } from '../schemas/response';

const chatApp = new Hono<{ Bindings: Env }>();

// Apply middleware in order
chatApp.use('*', authMiddleware);
chatApp.use('*', rateLimitCheckMiddleware);
chatApp.use('*', telemetryMiddleware);
chatApp.use('*', rateLimitIncrementMiddleware);

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

  const stub = env.CIRCUIT_BREAKER.get(env.CIRCUIT_BREAKER.idFromName(provider));
  const response = await stub.fetch(
    new Request('https://circuit-breaker/check', {
      method: 'POST',
      body: JSON.stringify({ provider })
    })
  );

  if (!response.ok) {
    return { allowed: true }; // Allow on error to avoid blocking all traffic
  }

  const data = await response.json() as { allowed: boolean; reason?: string };
  return data;
}

/**
 * Record success in circuit breaker
 */
async function recordCircuitBreakerSuccess(env: Env, provider: string): Promise<void> {
  if (!env.CIRCUIT_BREAKER) return;

  const stub = env.CIRCUIT_BREAKER.get(env.CIRCUIT_BREAKER.idFromName(provider));
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

  const stub = env.CIRCUIT_BREAKER.get(env.CIRCUIT_BREAKER.idFromName(provider));
  await stub.fetch(
    new Request('https://circuit-breaker/recordFailure', {
      method: 'POST',
      body: JSON.stringify({ provider })
    })
  );
}

/**
 * POST /v1/chat/completions
 * Main endpoint for LLM chat completions with intelligent routing
 */
chatApp.post('/', async (c) => {
  const client = c.get('client');
  const rawBody = await c.req.json();

  // Store request body for rate limit token estimation
  c.set('requestBody', rawBody);

  // Validate request with Zod
  const validationResult = chatCompletionRequestSchema.safeParse(rawBody);
  if (!validationResult.success) {
    return c.json({
      error: 'Invalid request',
      details: validationResult.error.errors
    }, 400);
  }

  const body = validationResult.data;

  // Determine which provider to use
  const model = body.model || client.defaultModel || 'gpt-4o';
  let route;
  try {
    route = await determineProvider(model, client, c.env);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Payment Required')) {
      return c.json({
        error: 'Payment Required',
        message: error.message
      }, 402);
    }
    return c.json({ error: 'Internal server error' }, 500);
  }

  // Update telemetry metadata
  updateTelemetryMetadata(c, route.provider, model, rawBody);

  // Check circuit breaker
  const circuitCheck = await checkCircuitBreaker(c.env, route.provider);
  if (!circuitCheck.allowed) {
    return c.json({
      error: 'Service temporarily unavailable',
      reason: circuitCheck.reason || 'Circuit breaker is open',
      provider: route.provider
    }, 503);
  }

  // Skip provider if configured credits are depleted
  const preBalance = await getCreditBalance(c.env, route.provider);
  if (preBalance.configured && preBalance.balance <= 0 && route.provider !== 'openrouter') {
    if (client.fallbackStrategy === 'fail-fast') {
      return c.json({
        error: 'Payment Required',
        message: 'Provider credits exhausted. Fail-fast policy enabled.',
        provider: route.provider
      }, 402);
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
  const finalBalance = await getCreditBalance(c.env, route.provider);

  // Transform request to provider format
  const providerRequest = adapter.transformRequest({ ...body, model });

  try {
    // Execute request to provider with retry logic
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
      // Record failure in circuit breaker
      await recordCircuitBreakerFailure(c.env, route.provider);

      const errorText = await response.text();
      return c.json({
        error: 'Provider error',
        provider: route.provider,
        details: errorText
      }, response.status as 400 | 500 | 502 | 503);
    }

    // Record success in circuit breaker
    await recordCircuitBreakerSuccess(c.env, route.provider);

    // Set response headers indicating provider/fallback
    c.header('X-Corvo-Provider', route.provider);
    c.header('X-Corvo-Fallback', route.fallback ? 'true' : 'false');
    if (route.fallback) {
      c.header('X-Corvo-Fallback-Reason', route.fallback.reason);
    }

    // Handle streaming response
    if (body.stream) {
      const streamingResponse = await createStreamingResponseWithUsage(response, {
        onUsage: async (usage) => {
          if (!finalBalance.configured) return;
          const cost = await estimateCostFromUsage({
            env: c.env,
            provider: route.provider,
            model,
            promptTokens: usage.prompt_tokens || 0,
            completionTokens: usage.completion_tokens || 0
          });
          await deductCredits(c.env, route.provider, cost);
        }
      });
      streamingResponse.headers.set('X-Corvo-Provider', route.provider);
      streamingResponse.headers.set('X-Corvo-Fallback', route.fallback ? 'true' : 'false');
      if (route.fallback) {
        streamingResponse.headers.set('X-Corvo-Fallback-Reason', route.fallback.reason);
      }
      return streamingResponse;
    }

    // Handle non-streaming response
    const responseData = await response.json();

    // Validate response (optional - can be disabled for performance)
    const responseValidation = chatCompletionResponseSchema.safeParse(responseData);
    if (!responseValidation.success) {
      console.warn('Response validation failed:', responseValidation.error.errors);
      // Continue anyway - provider might have extra fields
    }

    const openaiResponse = adapter.transformResponse(responseData, model);

    // Store response data for telemetry
    storeResponseData(c, openaiResponse);

    // Deduct credits for successful responses if ledger configured
    if (finalBalance.configured && openaiResponse.usage) {
      const cost = await estimateCostFromUsage({
        env: c.env,
        provider: route.provider,
        model,
        promptTokens: openaiResponse.usage.prompt_tokens || 0,
        completionTokens: openaiResponse.usage.completion_tokens || 0
      });
      await deductCredits(c.env, route.provider, cost);
    }

    return c.json(openaiResponse);

  } catch (error) {
    // Record failure in circuit breaker
    await recordCircuitBreakerFailure(c.env, route.provider);

    return c.json({
      error: 'Failed to complete request',
      provider: route.provider,
      details: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

export default chatApp;
