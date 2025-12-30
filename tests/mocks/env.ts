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
        LANGFUSE_PUBLIC_KEY: 'test-langfuse-public',
        LANGFUSE_SECRET_KEY: 'test-langfuse-secret',
        CIRCUIT_BREAKER: createMockCircuitBreaker(),
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
