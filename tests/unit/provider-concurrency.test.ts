import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ProviderConcurrency } from '../../src/durable-objects/provider-concurrency';

describe('ProviderConcurrency', () => {
  let providerConcurrency: ProviderConcurrency;
  let mockState: DurableObjectState;

  beforeEach(() => {
    mockState = {
      storage: {
        put: async () => { }
      }
    } as unknown as DurableObjectState;

    providerConcurrency = new ProviderConcurrency(mockState, {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('blocks acquire when in-flight count reaches model limit', async () => {
    const firstAcquire = await providerConcurrency.fetch(
      new Request('https://provider-concurrency/acquire', {
        method: 'POST',
        body: JSON.stringify({ provider: 'z-ai-pro', model: 'glm-4.6', limit: 2 })
      })
    );
    const secondAcquire = await providerConcurrency.fetch(
      new Request('https://provider-concurrency/acquire', {
        method: 'POST',
        body: JSON.stringify({ provider: 'z-ai-pro', model: 'glm-4.6', limit: 2 })
      })
    );
    const thirdAcquire = await providerConcurrency.fetch(
      new Request('https://provider-concurrency/acquire', {
        method: 'POST',
        body: JSON.stringify({ provider: 'z-ai-pro', model: 'glm-4.6', limit: 2 })
      })
    );
    const thirdPayload = await thirdAcquire.json() as { acquired: boolean };

    expect(firstAcquire.status).toBe(200);
    expect(secondAcquire.status).toBe(200);
    expect(thirdAcquire.status).toBe(429);
    expect(thirdPayload.acquired).toBe(false);
  });

  it('frees an in-flight slot when lease is released', async () => {
    const acquire = await providerConcurrency.fetch(
      new Request('https://provider-concurrency/acquire', {
        method: 'POST',
        body: JSON.stringify({ provider: 'z-ai-pro', model: 'glm-4.6', limit: 1 })
      })
    );
    const acquirePayload = await acquire.json() as { leaseId: string };

    const blockedAcquire = await providerConcurrency.fetch(
      new Request('https://provider-concurrency/acquire', {
        method: 'POST',
        body: JSON.stringify({ provider: 'z-ai-pro', model: 'glm-4.6', limit: 1 })
      })
    );

    await providerConcurrency.fetch(
      new Request('https://provider-concurrency/release', {
        method: 'POST',
        body: JSON.stringify({ leaseId: acquirePayload.leaseId })
      })
    );

    const acquireAfterRelease = await providerConcurrency.fetch(
      new Request('https://provider-concurrency/acquire', {
        method: 'POST',
        body: JSON.stringify({ provider: 'z-ai-pro', model: 'glm-4.6', limit: 1 })
      })
    );

    expect(blockedAcquire.status).toBe(429);
    expect(acquireAfterRelease.status).toBe(200);
  });

  it('expires stale leases based on ttl', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1000);

    await providerConcurrency.fetch(
      new Request('https://provider-concurrency/acquire', {
        method: 'POST',
        body: JSON.stringify({ provider: 'z-ai-pro', model: 'glm-4.6', limit: 1, ttlMs: 10 })
      })
    );

    nowSpy.mockReturnValue(1011);

    const acquireAfterExpiry = await providerConcurrency.fetch(
      new Request('https://provider-concurrency/acquire', {
        method: 'POST',
        body: JSON.stringify({ provider: 'z-ai-pro', model: 'glm-4.6', limit: 1, ttlMs: 10 })
      })
    );

    expect(acquireAfterExpiry.status).toBe(200);
  });
});
