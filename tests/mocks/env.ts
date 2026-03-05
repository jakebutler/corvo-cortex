/**
 * Test mock utilities for corvo-cortex
 * Provides standard mocks for KV, Durable Objects, and environment
 */

import type { Env, ClientConfig, RateLimitUsage } from '../../src/types';

/**
 * Default test client configuration
 */
export const DEFAULT_CLIENT_CONFIG: ClientConfig = {
    appId: 'test-app',
    name: 'Test App',
    defaultModel: 'gpt-4o',
    allowZai: true,
    fallbackStrategy: 'openrouter',
    rateLimit: {
        requestsPerMinute: 100,
        tokensPerMinute: 50000
    }
};

/**
 * Get the default mock client config as a function to ensure fresh copies
 */
export function createMockClientConfig(overrides?: Partial<ClientConfig>): ClientConfig {
    return { ...DEFAULT_CLIENT_CONFIG, ...overrides };
}

/**
 * Mock KV Namespace for CORTEX_CLIENTS
 */
export function createMockKV(data: Record<string, unknown> = {}): KVNamespace {
    const store = new Map<string, string>(
        Object.entries(data).map(([k, v]) => [k, JSON.stringify(v)])
    );

    return {
        get: async (key: string, options?: { type?: string }) => {
            const value = store.get(key);
            if (!value) return null;
            if (options?.type === 'json') {
                return JSON.parse(value);
            }
            return value;
        },
        put: async (key: string, value: string) => {
            store.set(key, value);
        },
        delete: async (key: string) => {
            store.delete(key);
        },
        list: async () => ({
            keys: Array.from(store.keys()).map(name => ({ name })),
            list_complete: true,
            cacheStatus: null
        }),
        getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null })
    } as unknown as KVNamespace;
}

/**
 * Mock Circuit Breaker Durable Object
 */
export function createMockCircuitBreaker(): DurableObjectNamespace {
    const mockStub = {
        fetch: async (request: Request) => {
            const url = new URL(request.url);
            const path = url.pathname;

            if (path === '/check') {
                return new Response(JSON.stringify({ allowed: true, state: 'closed' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            if (path === '/status') {
                return new Response(JSON.stringify({ breakers: [] }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            if (path === '/recordSuccess' || path === '/recordFailure' || path === '/reset') {
                return new Response(JSON.stringify({ success: true }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            return new Response('Not found', { status: 404 });
        }
    };

    return {
        get: () => mockStub,
        idFromName: () => ({ toString: () => 'mock-id' }),
        idFromString: () => ({ toString: () => 'mock-id' }),
        newUniqueId: () => ({ toString: () => 'mock-id' })
    } as unknown as DurableObjectNamespace;
}

/**
 * Mock Credit Ledger Durable Object
 */
export function createMockCreditLedger(): DurableObjectNamespace {
    type LedgerState = {
        balance: number;
        currency: 'USD' | 'credits';
        configured: boolean;
    };

    const stateById = new Map<string, LedgerState>();
    const getState = (id: string): LedgerState => {
        const existing = stateById.get(id);
        if (existing) return existing;

        const initial: LedgerState = { balance: 0, currency: 'USD', configured: false };
        stateById.set(id, initial);
        return initial;
    };

    const createStub = (id: string) => ({
        fetch: async (request: Request) => {
            const url = new URL(request.url);
            const path = url.pathname;
            const current = getState(id);

            if (path === '/balance') {
                return new Response(JSON.stringify({
                    balance: current.balance,
                    currency: current.currency,
                    configured: current.configured,
                    lastUpdated: new Date().toISOString()
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            if (path === '/set') {
                const body = await request.json() as { balance?: number; currency?: 'USD' | 'credits' };
                current.balance = body.balance ?? current.balance;
                current.currency = body.currency ?? current.currency;
                current.configured = true;
                return new Response(JSON.stringify({
                    balance: current.balance,
                    currency: current.currency,
                    configured: current.configured,
                    lastUpdated: new Date().toISOString()
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            if (path === '/adjust') {
                const body = await request.json() as { delta?: number; currency?: 'USD' | 'credits' };
                current.balance += body.delta ?? 0;
                current.currency = body.currency ?? current.currency;
                current.configured = true;
                return new Response(JSON.stringify({
                    balance: current.balance,
                    currency: current.currency,
                    configured: current.configured,
                    lastUpdated: new Date().toISOString()
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            if (path === '/deduct') {
                const body = await request.json() as { cost?: number };
                const cost = body.cost ?? 0;
                if (current.balance < cost) {
                    return new Response(JSON.stringify({ error: 'Insufficient credits' }), {
                        status: 402,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }
                current.balance -= cost;
                current.configured = true;
                return new Response(JSON.stringify({
                    balance: current.balance,
                    currency: current.currency,
                    configured: current.configured,
                    lastUpdated: new Date().toISOString()
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            return new Response('Not found', { status: 404 });
        }
    });

    return {
        get: (id: { toString: () => string }) => createStub(id.toString()),
        idFromName: (name: string) => ({ toString: () => name }),
        idFromString: () => ({ toString: () => 'mock-id' }),
        newUniqueId: () => ({ toString: () => 'mock-id' })
    } as unknown as DurableObjectNamespace;
}

/**
 * Mock Provider Concurrency Durable Object
 */
export function createMockProviderConcurrency(overrides?: {
    acquireStatus?: number;
    acquirePayload?: Record<string, unknown>;
}): DurableObjectNamespace {
    const activeLeases = new Set<string>();

    const stub = {
        fetch: async (request: Request) => {
            const url = new URL(request.url);
            const path = url.pathname;

            if (path === '/acquire') {
                const status = overrides?.acquireStatus ?? 200;
                if (status !== 200) {
                    return new Response(JSON.stringify(
                        overrides?.acquirePayload ?? { acquired: false, limit: 3, inFlight: 3 }
                    ), {
                        status,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }

                const leaseId = `lease-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                activeLeases.add(leaseId);
                return new Response(JSON.stringify({
                    acquired: true,
                    leaseId,
                    limit: 3,
                    inFlight: 1
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            if (path === '/release') {
                const body = await request.json() as { leaseId?: string };
                if (body.leaseId) {
                    activeLeases.delete(body.leaseId);
                }
                return new Response(JSON.stringify({ released: true }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            if (path === '/status') {
                return new Response(JSON.stringify({
                    counters: [],
                    leases: activeLeases.size
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            if (path === '/reset') {
                activeLeases.clear();
                return new Response(JSON.stringify({ reset: true }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            return new Response('Not found', { status: 404 });
        }
    };

    return {
        get: () => stub,
        idFromName: () => ({ toString: () => 'mock-provider-concurrency-id' }),
        idFromString: () => ({ toString: () => 'mock-provider-concurrency-id' }),
        newUniqueId: () => ({ toString: () => 'mock-provider-concurrency-id' })
    } as unknown as DurableObjectNamespace;
}

/**
 * Default test API key
 */
export const TEST_API_KEY = 'sk-corvo-test-123';
export const ADMIN_API_KEY = 'sk-corvo-admin-456';

/**
 * Create a complete mock environment for testing
 */
export function createMockEnv(overrides?: Partial<Env>): Env {
    return {
        CORTEX_CLIENTS: createMockKV({
            [TEST_API_KEY]: createMockClientConfig()
        }),
        CORTEX_CONFIG: createMockKV(),
        ANTHROPIC_API_KEY: 'test-anthropic-key',
        OPENAI_API_KEY: 'test-openai-key',
        ZAI_API_KEY: 'test-zai-key',
        OPENROUTER_API_KEY: 'test-openrouter-key',
        MINIMAX_API_KEY: 'test-minimax-key',
        FIREWORKS_API_KEY: 'test-fireworks-key',
        LANGFUSE_PUBLIC_KEY: 'test-langfuse-public',
        LANGFUSE_SECRET_KEY: 'test-langfuse-secret',
        CIRCUIT_BREAKER: createMockCircuitBreaker(),
        CREDIT_LEDGER: createMockCreditLedger(),
        PROVIDER_CONCURRENCY: createMockProviderConcurrency(),
        ENVIRONMENT: 'test',
        ...overrides
    } as Env;
}

/**
 * Create a mock rate limit usage object
 */
export function createMockRateLimitUsage(requests = 0, tokens = 0): RateLimitUsage {
    return { requests, tokens };
}
