import { describe, it, expect, beforeEach } from 'vitest';
import { CircuitBreaker } from '../../src/durable-objects/circuit-breaker';

describe('CircuitBreaker', () => {
  let circuitBreaker: CircuitBreaker;
  let mockState: any;
  let mockEnv: any;

  beforeEach(() => {
    mockState = {
      storage: {
        put: async () => {},
        get: async () => null
      }
    };
    mockEnv = {};
    circuitBreaker = new CircuitBreaker(mockState, mockEnv);
  });

  it('should allow requests when circuit is closed', async () => {
    const request = new Request('https://circuit-breaker/check', {
      method: 'POST',
      body: JSON.stringify({ provider: 'anthropic-direct' })
    });

    const response = await circuitBreaker.fetch(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.allowed).toBe(true);
    expect(data.state).toBe('closed');
  });

  it('should open circuit after 5 failures', async () => {
    const provider = 'test-provider';

    // Record 5 failures
    for (let i = 0; i < 5; i++) {
      const request = new Request('https://circuit-breaker/recordFailure', {
        method: 'POST',
        body: JSON.stringify({ provider })
      });
      await circuitBreaker.fetch(request);
    }

    // Check that circuit is now open
    const checkRequest = new Request('https://circuit-breaker/check', {
      method: 'POST',
      body: JSON.stringify({ provider })
    });
    const response = await circuitBreaker.fetch(checkRequest);
    const data = await response.json();

    expect(response.status).toBe(503);
    expect(data.allowed).toBe(false);
    expect(data.reason).toContain('Circuit breaker is OPEN');
  });

  it('should reset circuit when reset is called', async () => {
    const provider = 'test-provider';

    // Open the circuit first
    for (let i = 0; i < 5; i++) {
      const request = new Request('https://circuit-breaker/recordFailure', {
        method: 'POST',
        body: JSON.stringify({ provider })
      });
      await circuitBreaker.fetch(request);
    }

    // Reset
    const resetRequest = new Request('https://circuit-breaker/reset', {
      method: 'POST',
      body: JSON.stringify({ provider })
    });
    await circuitBreaker.fetch(resetRequest);

    // Check that circuit is closed again
    const checkRequest = new Request('https://circuit-breaker/check', {
      method: 'POST',
      body: JSON.stringify({ provider })
    });
    const response = await circuitBreaker.fetch(checkRequest);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.allowed).toBe(true);
    expect(data.state).toBe('closed');
  });

  it('should get status of all breakers', async () => {
    const request = new Request('https://circuit-breaker/status', {
      method: 'GET'
    });
    const response = await circuitBreaker.fetch(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toHaveProperty('breakers');
    expect(Array.isArray(data.breakers)).toBe(true);
  });
});
