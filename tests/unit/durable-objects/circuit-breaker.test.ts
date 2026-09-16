import { describe, it, expect } from 'vitest';
import { CircuitBreaker, circuitBreakerInstanceId } from '../../../src/durable-objects/circuit-breaker';

function createMockDoState(): DurableObjectState {
    const store = new Map<string, unknown>();
    return {
        storage: {
            get: async <T>(key: string) => store.get(key) as T,
            put: async (key: string, value: unknown) => {
                store.set(key, value);
            },
            delete: async (key: string) => {
                store.delete(key);
            },
            list: async (options?: { prefix?: string }) => {
                const entries: Array<[string, unknown]> = [];
                for (const [key, value] of store) {
                    if (!options?.prefix || key.startsWith(options.prefix)) {
                        entries.push([key, value]);
                    }
                }
                return entries as unknown as Awaited<ReturnType<DurableObjectState['storage']['list']>>;
            }
        }
    } as unknown as DurableObjectState;
}

function check(ledger: CircuitBreaker, provider: string): Promise<Response> {
    return ledger.fetch(new Request('https://circuit-breaker/check', {
        method: 'POST',
        body: JSON.stringify({ provider })
    }));
}

function recordFailure(ledger: CircuitBreaker, provider: string): Promise<Response> {
    return ledger.fetch(new Request('https://circuit-breaker/recordFailure', {
        method: 'POST',
        body: JSON.stringify({ provider })
    }));
}

function recordSuccess(ledger: CircuitBreaker, provider: string): Promise<Response> {
    return ledger.fetch(new Request('https://circuit-breaker/recordSuccess', {
        method: 'POST',
        body: JSON.stringify({ provider })
    }));
}

describe('CircuitBreaker durable object', () => {
    it('opens after the failure threshold and reports state via /status', async () => {
        const storage = createMockDoState();
        const breaker = new CircuitBreaker(storage, {});

        for (let i = 0; i < 5; i++) {
            await recordFailure(breaker, 'anthropic-direct');
        }

        const checkResponse = await check(breaker, 'anthropic-direct');
        expect(checkResponse.status).toBe(503);
        const checkPayload = await checkResponse.json() as { allowed: boolean; state: string };
        expect(checkPayload.allowed).toBe(false);
        expect(checkPayload.state).toBe('open');

        const statusResponse = await breaker.fetch(new Request('https://circuit-breaker/status'));
        const status = await statusResponse.json() as { breakers: Array<{ provider: string; state: string; failureCount: number }> };
        expect(status.breakers).toHaveLength(1);
        expect(status.breakers[0].provider).toBe('anthropic-direct');
        expect(status.breakers[0].state).toBe('open');
        expect(status.breakers[0].failureCount).toBe(5);
    });

    it('persists breaker state across a restart (fresh instance, same storage)', async () => {
        const storage = createMockDoState();
        const first = new CircuitBreaker(storage, {});

        for (let i = 0; i < 5; i++) {
            await recordFailure(first, 'openai-direct');
        }
        expect((await check(first, 'openai-direct')).status).toBe(503);

        const restarted = new CircuitBreaker(storage, {});
        const checkResponse = await check(restarted, 'openai-direct');
        expect(checkResponse.status).toBe(503);
        const payload = await checkResponse.json() as { allowed: boolean; state: string };
        expect(payload.allowed).toBe(false);
        expect(payload.state).toBe('open');

        const statusResponse = await restarted.fetch(new Request('https://circuit-breaker/status'));
        const status = await statusResponse.json() as { breakers: Array<{ provider: string; state: string }> };
        expect(status.breakers.some((b) => b.provider === 'openai-direct' && b.state === 'open')).toBe(true);
    });

    it('transitions open -> half-open after the timeout and enforces halfOpenMaxCalls', async () => {
        const storage = createMockDoState();
        const breaker = new CircuitBreaker(storage, {});

        for (let i = 0; i < 5; i++) {
            await recordFailure(breaker, 'minimax');
        }

        await breaker.fetch(new Request('https://circuit-breaker/reset', {
            method: 'POST',
            body: JSON.stringify({ provider: 'minimax' })
        }));

        const hydrated = await storage.storage.get<{ nextAttemptTime: number | null }>('breaker:minimax');
        expect(hydrated).toBeDefined();
        if (hydrated) {
            hydrated.state = 'open';
            hydrated.nextAttemptTime = Date.now() - 1;
            await storage.storage.put('breaker:minimax', hydrated);
        }

        const restarted = new CircuitBreaker(storage, {});

        const firstProbe = await check(restarted, 'minimax');
        expect(firstProbe.status).toBe(200);
        const firstProbePayload = await firstProbe.json() as { allowed: boolean; state: string };
        expect(firstProbePayload.allowed).toBe(true);
        expect(firstProbePayload.state).toBe('half-open');

        const secondProbe = await check(restarted, 'minimax');
        expect(secondProbe.status).toBe(503);
        const secondProbePayload = await secondProbe.json() as { allowed: boolean; reason: string };
        expect(secondProbePayload.allowed).toBe(false);
        expect(secondProbePayload.reason).toContain('HALF_OPEN');
    });

    it('closes the circuit when a half-open probe succeeds and reopens when it fails', async () => {
        const storage = createMockDoState();
        const breaker = new CircuitBreaker(storage, {});

        for (let i = 0; i < 5; i++) {
            await recordFailure(breaker, 'z-ai-pro');
        }

        await storage.storage.put('breaker:z-ai-pro', {
            provider: 'z-ai-pro',
            state: 'open',
            failureCount: 5,
            lastFailureTime: Date.now(),
            nextAttemptTime: Date.now() - 1,
            halfOpenCalls: 0
        });

        const halfOpen = await new CircuitBreaker(storage, {});
        const probe = await check(halfOpen, 'z-ai-pro');
        expect(probe.status).toBe(200);

        await recordSuccess(halfOpen, 'z-ai-pro');

        const afterSuccess = await check(halfOpen, 'z-ai-pro');
        expect(afterSuccess.status).toBe(200);
        const afterSuccessPayload = await afterSuccess.json() as { state: string };
        expect(afterSuccessPayload.state).toBe('closed');

        await storage.storage.put('breaker:z-ai-pro', {
            provider: 'z-ai-pro',
            state: 'open',
            failureCount: 5,
            lastFailureTime: Date.now(),
            nextAttemptTime: Date.now() - 1,
            halfOpenCalls: 0
        });

        const reopened = new CircuitBreaker(storage, {});
        await check(reopened, 'z-ai-pro');
        await recordFailure(reopened, 'z-ai-pro');

        const afterFailedProbe = await check(reopened, 'z-ai-pro');
        expect(afterFailedProbe.status).toBe(503);
        const afterFailedProbePayload = await afterFailedProbe.json() as { state: string };
        expect(afterFailedProbePayload.state).toBe('open');
    });

    it('exposes a stable single-instance id used by all call sites', () => {
        expect(circuitBreakerInstanceId()).toBe('circuit-breaker:global');
    });
});
