import type { ClientConfig, RateLimitUsage } from '../types';

/**
 * Rate limit header interface
 */
export interface RateLimitHeaders {
  'RateLimit-Limit': string;
  'RateLimit-Remaining': string;
  'RateLimit-Reset': string;
  'RateLimit-Used': string;
}

/**
 * Generate rate limit headers for responses
 */
export function generateRateLimitHeaders(
  client: ClientConfig,
  currentUsage: RateLimitUsage,
  resetTime?: number
): RateLimitHeaders {
  const rateLimit = client.rateLimit || {
    requestsPerMinute: 100,
    tokensPerMinute: 50000
  };

  // Use requests as the primary limit (most clients care about request count)
  const limit = rateLimit.requestsPerMinute;
  const used = currentUsage.requests;
  const remaining = Math.max(0, limit - used);

  // Calculate reset time (end of current minute window)
  const now = Date.now();
  const currentMinute = Math.floor(now / 60000) * 60000;
  const reset = resetTime || (currentMinute + 60000);

  return {
    'RateLimit-Limit': String(limit),
    'RateLimit-Remaining': String(remaining),
    'RateLimit-Reset': String(reset),
    'RateLimit-Used': String(used)
  };
}

/**
 * Set rate limit headers on a Hono response
 */
export function setRateLimitHeaders(
  response: Response,
  headers: RateLimitHeaders
): Response {
  const newHeaders = new Headers(response.headers);

  for (const [key, value] of Object.entries(headers)) {
    newHeaders.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders
  });
}
