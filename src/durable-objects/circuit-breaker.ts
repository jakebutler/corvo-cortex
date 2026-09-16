import type { CircuitState } from '../types';

/**
 * Circuit Breaker Durable Object
 * Manages provider health state to prevent cascading failures
 *
 * A single instance owns all providers; state is persisted to DO storage and
 * reloaded lazily so breaker state survives restarts and hibernation.
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Provider failing, fail-fast for timeout period
 * - HALF_OPEN: Testing if provider has recovered (at most halfOpenMaxCalls probes)
 */
export class CircuitBreaker implements DurableObject {
  private state: DurableObjectState;
  private env: unknown;

  // Circuit breaker configuration
  private failureThreshold = 5;
  private openTimeout = 60000; // 60 seconds
  private halfOpenMaxCalls = 1; // Number of concurrent probes allowed in half-open state

  // Per-provider state (lazily hydrated from storage)
  private breakerStates = new Map<string, CircuitBreakerData>();
  private loaded = false;

  constructor(state: DurableObjectState, env: unknown) {
    this.state = state;
    this.env = env;
  }

  /**
   * Handle incoming requests to the Circuit Breaker
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    try {
      if (pathname === '/check') {
        return await this.handleCheck(request);
      }
      if (pathname === '/recordSuccess') {
        return await this.handleRecordSuccess(request);
      }
      if (pathname === '/recordFailure') {
        return await this.handleRecordFailure(request);
      }
      if (pathname === '/reset') {
        return await this.handleReset(request);
      }
      if (pathname === '/status') {
        return await this.handleStatus();
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      return new Response(
        JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  /**
   * Check if a request should be allowed through
   */
  private async handleCheck(request: Request): Promise<Response> {
    const { provider } = await request.json() as { provider: string };
    const data = await this.getOrCreateState(provider);

    // Check if we should transition from OPEN to HALF_OPEN
    if (data.state === 'open' && data.nextAttemptTime !== null && Date.now() >= data.nextAttemptTime) {
      data.state = 'half-open';
      data.halfOpenCalls = 0;
      await this.saveState(provider, data);
    }

    // Fail fast if circuit is OPEN
    if (data.state === 'open') {
      return this.json({
        allowed: false,
        reason: 'Circuit breaker is OPEN',
        state: data.state
      }, 503);
    }

    // Enforce the probe budget in HALF_OPEN state
    if (data.state === 'half-open') {
      if ((data.halfOpenCalls || 0) >= this.halfOpenMaxCalls) {
        return this.json({
          allowed: false,
          reason: 'Circuit breaker is HALF_OPEN with the maximum number of probes in flight',
          state: data.state
        }, 503);
      }

      data.halfOpenCalls = (data.halfOpenCalls || 0) + 1;
      await this.saveState(provider, data);
    }

    return this.json({ allowed: true, state: data.state });
  }

  /**
   * Record a successful request
   */
  private async handleRecordSuccess(request: Request): Promise<Response> {
    const { provider } = await request.json() as { provider: string };
    const data = await this.getOrCreateState(provider);

    if (data.state === 'half-open') {
      // Successfully recovered, close the circuit
      data.state = 'closed';
      data.failureCount = 0;
      data.lastFailureTime = null;
      data.nextAttemptTime = null;
      data.halfOpenCalls = 0;
    } else if (data.state === 'closed') {
      // Reset failure count on success in closed state
      data.failureCount = 0;
    }

    await this.saveState(provider, data);

    return this.json({ success: true, state: data.state });
  }

  /**
   * Record a failed request
   */
  private async handleRecordFailure(request: Request): Promise<Response> {
    const { provider } = await request.json() as { provider: string };
    const data = await this.getOrCreateState(provider);

    data.failureCount++;
    data.lastFailureTime = Date.now();

    if (data.state === 'half-open') {
      // A failed probe is direct evidence the provider has not recovered
      data.state = 'open';
      data.nextAttemptTime = Date.now() + this.openTimeout;
      data.halfOpenCalls = 0;
    } else if (data.failureCount >= this.failureThreshold) {
      // Open the circuit if threshold reached
      data.state = 'open';
      data.nextAttemptTime = Date.now() + this.openTimeout;
    }

    await this.saveState(provider, data);

    return this.json({ success: true, state: data.state });
  }

  /**
   * Reset circuit breaker for a provider
   */
  private async handleReset(request: Request): Promise<Response> {
    const { provider } = await request.json() as { provider: string };
    const data = await this.getOrCreateState(provider);

    data.state = 'closed';
    data.failureCount = 0;
    data.lastFailureTime = null;
    data.nextAttemptTime = null;
    data.halfOpenCalls = 0;

    await this.saveState(provider, data);

    return this.json({ success: true, state: data.state });
  }

  /**
   * Get status of all circuit breakers
   */
  private async handleStatus(): Promise<Response> {
    await this.ensureLoaded();
    const status = Array.from(this.breakerStates.values());

    return this.json({ breakers: status });
  }

  /**
   * Hydrate in-memory state from DO storage (once per instance lifetime)
   */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;

    const entries = await this.state.storage.list({ prefix: `${STORAGE_KEY_PREFIX}:` });
    for (const [key, value] of entries) {
      const provider = key.slice(`${STORAGE_KEY_PREFIX}:`.length);
      const data = value as CircuitBreakerData;
      this.breakerStates.set(provider, { ...data, provider });
    }

    this.loaded = true;
  }

  /**
   * Get or create state for a provider
   */
  private async getOrCreateState(provider: string): Promise<CircuitBreakerData> {
    await this.ensureLoaded();

    const existing = this.breakerStates.get(provider);
    if (existing) return existing;

    const fresh: CircuitBreakerData = {
      provider,
      state: 'closed',
      failureCount: 0,
      lastFailureTime: null,
      nextAttemptTime: null,
      halfOpenCalls: 0
    };
    this.breakerStates.set(provider, fresh);
    return fresh;
  }

  /**
   * Persist state to Durable Object storage
   */
  private async saveState(provider: string, data: CircuitBreakerData): Promise<void> {
    this.breakerStates.set(provider, data);
    await this.state.storage.put(`${STORAGE_KEY_PREFIX}:${provider}`, data);
  }

  private json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

const STORAGE_KEY_PREFIX = 'breaker';

/**
 * All breaker traffic (checks, records, status, resets) must target this
 * single DO instance so state and health views agree.
 */
export function circuitBreakerInstanceId(): string {
  return 'circuit-breaker:global';
}

/**
 * Circuit breaker state data structure
 */
interface CircuitBreakerData {
  provider: string;
  state: CircuitState;
  failureCount: number;
  lastFailureTime: number | null;
  nextAttemptTime: number | null;
  halfOpenCalls?: number;
}
