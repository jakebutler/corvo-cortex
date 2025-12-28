import { MiddlewareHandler } from 'hono';
import type { Env, Variables, ClientConfig, RateLimitUsage } from '../types';

declare module 'hono' {
  interface ContextVariableMap extends Variables {}
}

/**
 * Get the current rate limit key based on API key and minute
 */
function getRateLimitKey(apiKey: string): string {
  const minute = Math.floor(Date.now() / 60000);
  return `ratelimit:${apiKey}:${minute}`;
}

/**
 * Estimate token count from text (rough approximation)
 */
function estimateTokens(text: string): number {
  // Rough estimate: ~1.3 tokens per word for English, or use character count / 4
  const words = text.split(/\s+/).length;
  return Math.floor(words * 1.3);
}

/**
 * Estimate tokens from a chat completion request
 */
function estimateRequestTokens(body: {
  messages?: Array<{ content: string }>;
}): number {
  if (!body.messages || !Array.isArray(body.messages)) {
    return 0;
  }

  const totalText = body.messages
    .map(m => m.content || '')
    .join(' ');

  return estimateTokens(totalText);
}

/**
 * Rate limit check middleware
 * Checks if the client has exceeded their rate limits before processing the request
 */
export const rateLimitCheckMiddleware: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  const client = c.get('client') as ClientConfig & { admin?: boolean };

  // Bypass rate limiting for admin keys
  if (client.admin) {
    await next();
    return;
  }

  // Get API key from Authorization header
  const authHeader = c.req.header('Authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || '';

  const rateLimitKey = getRateLimitKey(apiKey);

  // Get current usage
  const currentUsage = await c.env.CORTEX_CLIENTS.get(rateLimitKey, { type: 'json' }) as RateLimitUsage | null;
  const usage = currentUsage || { requests: 0, tokens: 0 };

  // Get rate limit configuration from client config
  const rateLimit = client.rateLimit || {
    requestsPerMinute: 100,
    tokensPerMinute: 50000
  };

  // Check request limit
  if (usage.requests >= rateLimit.requestsPerMinute) {
    return c.json({
      error: 'Rate limit exceeded',
      limit: rateLimit.requestsPerMinute,
      type: 'requests'
    }, 429);
  }

  // Check token limit
  if (usage.tokens >= rateLimit.tokensPerMinute) {
    return c.json({
      error: 'Rate limit exceeded',
      limit: rateLimit.tokensPerMinute,
      type: 'tokens'
    }, 429);
  }

  // Store rate limit info in context for later use
  c.set('rateLimitKey', rateLimitKey);
  c.set('currentUsage', usage);

  await next();
};

/**
 * Rate limit increment middleware
 * Increments the rate limit counters after a successful request
 * Must run AFTER the request is processed
 */
export const rateLimitIncrementMiddleware: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  const client = c.get('client') as ClientConfig & { admin?: boolean };

  // Bypass rate limiting for admin keys
  if (!client.admin) {
    // Store original response for later
    await next();

    const rateLimitKey = c.get('rateLimitKey');
    const requestBody = c.get('requestBody');

    if (rateLimitKey && requestBody) {
      // Get current usage
      const currentUsage = await c.env.CORTEX_CLIENTS.get(rateLimitKey, { type: 'json' }) as RateLimitUsage | null;
      const usage = currentUsage || { requests: 0, tokens: 0 };

      // Estimate tokens from request
      const estimatedTokens = estimateRequestTokens(requestBody as { messages?: Array<{ content: string }> });

      // Increment counters
      usage.requests++;
      usage.tokens += estimatedTokens;

      // Save to KV with 2 minute TTL (to allow for clock skew)
      await c.env.CORTEX_CLIENTS.put(rateLimitKey, JSON.stringify(usage), {
        expirationTtl: 120
      });

      // Calculate rate limit info for headers
      const rateLimit = client.rateLimit || {
        requestsPerMinute: 100,
        tokensPerMinute: 50000
      };

      const limit = rateLimit.requestsPerMinute;
      const used = usage.requests;
      const remaining = Math.max(0, limit - used);

      // Calculate reset time (end of current minute window)
      const now = Date.now();
      const currentMinute = Math.floor(now / 60000) * 60000;
      const reset = currentMinute + 60000;

      // Set rate limit headers on successful responses
      if (c.res.status < 400) {
        c.header('RateLimit-Limit', String(limit));
        c.header('RateLimit-Remaining', String(remaining));
        c.header('RateLimit-Reset', String(reset));
        c.header('RateLimit-Used', String(used));
      }
    }
  } else {
    await next();
  }
};
