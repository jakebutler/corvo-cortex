/**
 * Retry utilities with exponential backoff
 */

import { abortError } from './abort';

export interface RetryOptions {
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
  retryableStatuses?: number[];
  onRetry?: (attempt: number, error: Error) => void;
  /**
   * Abort signal threaded into every attempt and honored between retries
   * (client disconnects, request-scoped timeouts). Aborts never retry.
   */
  signal?: NonNullable<RequestInit['signal']>;
}

/**
 * Default retry configuration
 */
const DEFAULT_RETRY_OPTIONS = {
  maxRetries: 3,
  baseDelay: 100,
  maxDelay: 10000,
  retryableStatuses: [408, 429, 500, 502, 503, 504],
  onRetry: () => { }
};

/**
 * Calculate exponential backoff delay with jitter
 */
function calculateDelay(attempt: number, baseDelay: number, maxDelay: number): number {
  const exponentialDelay = baseDelay * Math.pow(2, attempt);
  const jitter = Math.random() * 100;
  return Math.min(exponentialDelay + jitter, maxDelay);
}

/**
 * Check if a response status is retryable
 */
function isRetryableStatus(status: number, retryableStatuses: number[]): boolean {
  return retryableStatuses.includes(status);
}

/**
 * Check if an error is retryable (network errors, timeouts)
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const retryableMessages = [
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ENOTFOUND',
      'EAI_AGAIN',
      'network',
      'timeout'
    ];
    return retryableMessages.some(msg =>
      error.message.toLowerCase().includes(msg.toLowerCase())
    );
  }
  return false;
}

const MAX_RETRY_AFTER_MS = 30_000;

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number.parseFloat(header);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

/**
 * Fetch with exponential backoff retry logic
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retryOpts: RetryOptions = {}
): Promise<Response> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...retryOpts };
  let lastError: Error | null = null;

  const throwIfAborted = (): void => {
    if (opts.signal?.aborted) {
      throw abortError();
    }
  };

  throwIfAborted();

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      const response = await fetch(url, { ...options, signal: opts.signal });

      // Check if response status is retryable
      if (response.ok || !isRetryableStatus(response.status, opts.retryableStatuses)) {
        return response;
      }

      // Response failed with retryable status
      const errorText = await response.clone().text();
      lastError = new Error(`HTTP ${response.status}: ${errorText}`);

      // Don't retry if this was the last attempt
      if (attempt === opts.maxRetries) {
        return response;
      }

      // Call onRetry callback
      opts.onRetry(attempt + 1, lastError);

      // Wait before retrying (respect Retry-After when the provider sends it)
      const delay = retryAfterMs(response) ?? calculateDelay(attempt, opts.baseDelay, opts.maxDelay);
      await new Promise(resolve => setTimeout(resolve, delay));
      throwIfAborted();

    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Aborts (client disconnects, timeouts) are never retried
      if (lastError.name === 'AbortError' || !isRetryableError(error) || attempt === opts.maxRetries) {
        throw lastError;
      }

      // Call onRetry callback
      opts.onRetry(attempt + 1, lastError);

      // Wait before retrying
      const delay = calculateDelay(attempt, opts.baseDelay, opts.maxDelay);
      await new Promise(resolve => setTimeout(resolve, delay));
      throwIfAborted();
    }
  }

  // Should never reach here, but TypeScript needs it
  throw lastError || new Error('Max retries exceeded');
}
