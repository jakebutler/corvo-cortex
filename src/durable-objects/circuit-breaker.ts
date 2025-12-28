import type { CircuitState, CircuitBreakerState } from '../types';

/**
 * Circuit Breaker Durable Object
 * Manages provider health state to prevent cascading failures
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Provider failing, fail-fast for timeout period
 * - HALF_OPEN: Testing if provider has recovered
 */
export class CircuitBreaker implements DurableObject {
  private state: DurableObjectState;
  private env: unknown;

  // Circuit breaker configuration
  private failureThreshold = 5;
  private openTimeout = 60000; // 60 seconds
  private halfOpenMaxCalls = 1; // Number of calls to test in half-open state

  // Per-provider state
  private breakerStates = new Map<string, CircuitBreakerData>();

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
        return this.handleCheck(request);
      }
      if (pathname === '/recordSuccess') {
        return this.handleRecordSuccess(request);
      }
      if (pathname === '/recordFailure') {
        return this.handleRecordFailure(request);
      }
      if (pathname === '/reset') {
        return this.handleReset(request);
      }
      if (pathname === '/status') {
        return this.handleStatus();
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
    const data = this.getOrCreateState(provider);

    // Check if we should transition from OPEN to HALF_OPEN
    if (data.state === 'open' && Date.now() >= data.nextAttemptTime!) {
      data.state = 'half-open';
      data.halfOpenCalls = 0;
      this.saveState(provider, data);
    }

    // Fail fast if circuit is OPEN
    if (data.state === 'open') {
      return new Response(
        JSON.stringify({
          allowed: false,
          reason: 'Circuit breaker is OPEN',
          state: data.state
        }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Track the call in HALF_OPEN state
    if (data.state === 'half-open') {
      data.halfOpenCalls = (data.halfOpenCalls || 0) + 1;
      this.saveState(provider, data);
    }

    return new Response(
      JSON.stringify({ allowed: true, state: data.state }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  /**
   * Record a successful request
   */
  private async handleRecordSuccess(request: Request): Promise<Response> {
    const { provider } = await request.json() as { provider: string };
    const data = this.getOrCreateState(provider);

    if (data.state === 'half-open') {
      // Successfully recovered, close the circuit
      data.state = 'closed';
      data.failureCount = 0;
      data.lastFailureTime = null;
      data.nextAttemptTime = null;
    } else if (data.state === 'closed') {
      // Reset failure count on success in closed state
      data.failureCount = 0;
    }

    this.saveState(provider, data);

    return new Response(
      JSON.stringify({ success: true, state: data.state }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  /**
   * Record a failed request
   */
  private async handleRecordFailure(request: Request): Promise<Response> {
    const { provider } = await request.json() as { provider: string };
    const data = this.getOrCreateState(provider);

    data.failureCount++;
    data.lastFailureTime = Date.now();

    // Open the circuit if threshold reached
    if (data.failureCount >= this.failureThreshold) {
      data.state = 'open';
      data.nextAttemptTime = Date.now() + this.openTimeout;
    }

    this.saveState(provider, data);

    return new Response(
      JSON.stringify({ success: true, state: data.state }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  /**
   * Reset circuit breaker for a provider
   */
  private async handleReset(request: Request): Promise<Response> {
    const { provider } = await request.json() as { provider: string };
    const data = this.getOrCreateState(provider);

    data.state = 'closed';
    data.failureCount = 0;
    data.lastFailureTime = null;
    data.nextAttemptTime = null;

    this.saveState(provider, data);

    return new Response(
      JSON.stringify({ success: true, state: data.state }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  /**
   * Get status of all circuit breakers
   */
  private async handleStatus(): Promise<Response> {
    const status = Array.from(this.breakerStates.values());

    return new Response(
      JSON.stringify({ breakers: status }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  /**
   * Get or create state for a provider
   */
  private getOrCreateState(provider: string): CircuitBreakerData {
    if (!this.breakerStates.has(provider)) {
      this.breakerStates.set(provider, {
        provider,
        state: 'closed',
        failureCount: 0,
        lastFailureTime: null,
        nextAttemptTime: null,
        halfOpenCalls: 0
      });
    }
    return this.breakerStates.get(provider)!;
  }

  /**
   * Persist state to Durable Object storage
   */
  private saveState(provider: string, data: CircuitBreakerData): void {
    this.breakerStates.set(provider, data);
    // Persist to DO storage for recovery across restarts
    this.state.storage.put(`breaker:${provider}`, data);
  }
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
