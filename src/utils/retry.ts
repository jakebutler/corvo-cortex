/**
 * Retry utilities with exponential backoff
 */

export interface RetryOptions {
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
  retryableStatuses?: number[];
  onRetry?: (attempt: number, error: Error) => void;
}

/**
 * Default retry configuration
 */
const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  baseDelay: 100,
  maxDelay: 10000,
  retryableStatuses: [408, 429, 500, 502, 503, 504],
  onRetry: () => {}
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

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);

      // Check if response status is retryable
      if (response.ok || !isRetryableStatus(response.status, opts.retryableStatuses)) {
        return response;
      }

      // Response failed with retryable status
      const errorText = await response.text();
      lastError = new Error(`HTTP ${response.status}: ${errorText}`);

      // Don't retry if this was the last attempt
      if (attempt === opts.maxRetries) {
        return response;
      }

      // Call onRetry callback
      opts.onRetry(attempt + 1, lastError);

      // Wait before retrying
      const delay = calculateDelay(attempt, opts.baseDelay, opts.maxDelay);
      await new Promise(resolve => setTimeout(resolve, delay));

    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry if error is not retryable or this was the last attempt
      if (!isRetryableError(error) || attempt === opts.maxRetries) {
        throw lastError;
      }

      // Call onRetry callback
      opts.onRetry(attempt + 1, lastError);

      // Wait before retrying
      const delay = calculateDelay(attempt, opts.baseDelay, opts.maxDelay);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // Should never reach here, but TypeScript needs it
  throw lastError || new Error('Max retries exceeded');
}
