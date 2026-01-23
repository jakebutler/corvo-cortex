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
    let balance = 0;
    let currency: 'USD' | 'credits' = 'USD';
    let configured = false;

    const mockStub = {
        fetch: async (request: Request) => {
            const url = new URL(request.url);
            const path = url.pathname;

            if (path === '/balance') {
                return new Response(JSON.stringify({
                    balance,
                    currency,
                    configured,
                    lastUpdated: new Date().toISOString()
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            if (path === '/set') {
                const body = await request.json() as { balance?: number; currency?: 'USD' | 'credits' };
                balance = body.balance ?? balance;
                currency = body.currency ?? currency;
                configured = true;
                return new Response(JSON.stringify({
                    balance,
                    currency,
                    configured,
                    lastUpdated: new Date().toISOString()
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            if (path === '/adjust') {
                const body = await request.json() as { delta?: number; currency?: 'USD' | 'credits' };
                balance += body.delta ?? 0;
                currency = body.currency ?? currency;
                configured = true;
                return new Response(JSON.stringify({
                    balance,
                    currency,
                    configured,
                    lastUpdated: new Date().toISOString()
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            if (path === '/deduct') {
                const body = await request.json() as { cost?: number };
                const cost = body.cost ?? 0;
                if (balance < cost) {
                    return new Response(JSON.stringify({ error: 'Insufficient credits' }), {
                        status: 402,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }
                balance -= cost;
                configured = true;
                return new Response(JSON.stringify({
                    balance,
                    currency,
                    configured,
                    lastUpdated: new Date().toISOString()
                }), {
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
