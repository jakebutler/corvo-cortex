import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { vi } from 'vitest';
import adminApp from '../../../src/routes/admin';
import { createMockKV, createMockClientConfig, createMockCreditLedger, TEST_API_KEY, ADMIN_API_KEY } from '../../mocks/env';
import type { Env, RateLimitUsage } from '../../../src/types';

vi.mock('../../../src/services/models-catalog', () => ({
    refreshAllModelCatalogs: vi.fn(async () => ({
        openai: { ok: true, count: 1 }
    }))
}));

describe('Admin Route - /admin', () => {
    let mockEnv: Env;
    const currentMinute = Math.floor(Date.now() / 60000);
    const usageKey = `ratelimit:${TEST_API_KEY}:${currentMinute}`;
    const usageData: RateLimitUsage = { requests: 5, tokens: 250 };

    function createMockEnv(overrides: Partial<Env> = {}): Env {
        return {
            CORTEX_CLIENTS: createMockKV({
                [TEST_API_KEY]: createMockClientConfig(),
                [ADMIN_API_KEY]: createMockClientConfig({ admin: true }),
                [usageKey]: usageData
            }),
            CORTEX_CONFIG: createMockKV(),
            ANTHROPIC_API_KEY: 'test',
            OPENAI_API_KEY: 'test',
            ZAI_API_KEY: 'test',
            OPENROUTER_API_KEY: 'test',
            MINIMAX_API_KEY: 'test',
            FIREWORKS_API_KEY: 'test',
            LANGFUSE_PUBLIC_KEY: 'test',
            LANGFUSE_SECRET_KEY: 'test',
            CIRCUIT_BREAKER: {} as unknown as DurableObjectNamespace,
            CREDIT_LEDGER: createMockCreditLedger(),
            ENVIRONMENT: 'test',
            ...overrides
        } as Env;
    }

    beforeEach(() => {
        mockEnv = createMockEnv();
    });

    describe('Authentication', () => {
        it('should return 401 when Authorization header is missing', async () => {
            const request = new Request('http://localhost/usage', {
                method: 'GET'
            });

            const response = await adminApp.fetch(request, mockEnv);

            expect(response.status).toBe(401);
        });

        it('should return 403 for non-admin API key', async () => {
            const request = new Request('http://localhost/usage', {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${TEST_API_KEY}` }
            });

            const response = await adminApp.fetch(request, mockEnv);

            expect(response.status).toBe(403);
        });

        it('should pass for admin API key', async () => {
            const request = new Request(`http://localhost/usage?key=${TEST_API_KEY}`, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${ADMIN_API_KEY}` }
            });

            const response = await adminApp.fetch(request, mockEnv);

            expect(response.status).toBe(200);
        });
    });

    describe('GET /usage', () => {
        it('should return usage for specific client', async () => {
            const request = new Request(`http://localhost/usage?key=${TEST_API_KEY}`, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${ADMIN_API_KEY}` }
            });

            const response = await adminApp.fetch(request, mockEnv);

            expect(response.status).toBe(200);
            const json = await response.json() as {
                apiKey: string;
                usage: RateLimitUsage;
                client: unknown;
            };
            expect(json.apiKey).toBe(TEST_API_KEY);
            expect(json.usage.requests).toBe(5);
            expect(json.usage.tokens).toBe(250);
            expect(json.client).toBeDefined();
        });

        it('should return empty usage for unknown client usage key', async () => {
            const request = new Request(`http://localhost/usage?key=${ADMIN_API_KEY}`, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${ADMIN_API_KEY}` }
            });

            const response = await adminApp.fetch(request, mockEnv);

            expect(response.status).toBe(200);
            const json = await response.json() as { usage: RateLimitUsage };
            expect(json.usage.requests).toBe(0);
        });
    });

    describe('GET /clients', () => {
        it('should return placeholder message', async () => {
            const request = new Request('http://localhost/clients', {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${ADMIN_API_KEY}` }
            });

            const response = await adminApp.fetch(request, mockEnv);

            expect(response.status).toBe(200);
            const json = await response.json() as { message: string };
            expect(json.message).toContain('Client listing requires a separate index');
        });
    });

    describe('POST /models/refresh', () => {
        it('should refresh model catalogs', async () => {
            const request = new Request('http://localhost/models/refresh', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${ADMIN_API_KEY}` },
                body: JSON.stringify({})
            });

            const response = await adminApp.fetch(request, mockEnv);

            expect(response.status).toBe(200);
            const json = await response.json() as { results: { openai: { ok: boolean; count: number } } };
            expect(json.results.openai.ok).toBe(true);
        });
    });

    describe('POST /credits/sync', () => {
        const originalFetch = globalThis.fetch;

        beforeEach(() => {
            globalThis.fetch = vi.fn().mockResolvedValue(
                new Response(JSON.stringify({
                    data: {
                        total_credits: 100,
                        total_usage: 12
                    }
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                })
            );
        });

        it('syncs openrouter credits and returns snapshot + ledger balance', async () => {
            const request = new Request('http://localhost/credits/sync', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${ADMIN_API_KEY}` },
                body: JSON.stringify({ provider: 'openrouter' })
            });

            const response = await adminApp.fetch(request, mockEnv);
            const json = await response.json() as {
                provider: string;
                snapshot: { remainingCredits: number };
                balance: { balance: number };
            };

            expect(response.status).toBe(200);
            expect(json.provider).toBe('openrouter');
            expect(json.snapshot.remainingCredits).toBe(88);
            expect(json.balance.balance).toBe(88);
        });

        afterEach(() => {
            globalThis.fetch = originalFetch;
        });
    });

    describe('Routing Policy Admin Endpoints', () => {
        it('should return active environment-scoped routing policy', async () => {
            const request = new Request('http://localhost/routing-policy', {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${ADMIN_API_KEY}` }
            });

            const response = await adminApp.fetch(request, mockEnv);
            const json = await response.json() as {
                key: string;
                policy: { version: string };
            };

            expect(response.status).toBe(200);
            expect(json.key).toBe('routing:kinisi-hints:test');
            expect(json.policy.version).toBeDefined();
        });

        it('should reject invalid routing policy payloads', async () => {
            const request = new Request('http://localhost/routing-policy', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${ADMIN_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    policy: {
                        version: 123,
                        matrix: null
                    }
                })
            });

            const response = await adminApp.fetch(request, mockEnv);

            expect(response.status).toBe(400);
            const json = await response.json() as { error: string };
            expect(json.error).toContain('Invalid routing policy payload');
        });

        it('should persist valid routing policy payloads', async () => {
            const policy = {
                version: 'override-v2',
                enabled: true,
                modelProfiles: {
                    fast_json_model: 'accounts/fireworks/models/override-fast',
                    balanced_json_model: 'openai/gpt-5-mini',
                    quality_json_model: 'openai/gpt-5',
                    safe_json_model: 'openai/gpt-5-mini'
                },
                matrix: {
                    week_1: {
                        speed: [{ provider: 'fireworks', modelProfile: 'fast_json_model' }],
                        balanced: [{ provider: 'openrouter', modelProfile: 'balanced_json_model' }],
                        quality: [{ provider: 'openrouter', modelProfile: 'quality_json_model' }]
                    },
                    week_n: {
                        speed: [{ provider: 'fireworks', modelProfile: 'fast_json_model' }],
                        balanced: [{ provider: 'openrouter', modelProfile: 'balanced_json_model' }],
                        quality: [{ provider: 'openrouter', modelProfile: 'quality_json_model' }]
                    },
                    refine_week_1: {
                        speed: [{ provider: 'openrouter', modelProfile: 'balanced_json_model' }],
                        balanced: [{ provider: 'openrouter', modelProfile: 'balanced_json_model' }],
                        quality: [{ provider: 'openrouter', modelProfile: 'quality_json_model' }]
                    }
                },
                hedge: {
                    week_n_speed: true,
                    week_1_speed: false,
                    delayMs: 250
                },
                retryPolicies: {
                    speed: { maxRetries: 1, baseDelayMs: 50, maxDelayMs: 250 },
                    balanced: { maxRetries: 2, baseDelayMs: 80, maxDelayMs: 1000 },
                    quality: { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 1500 }
                },
                latencyBudgetsMs: {
                    week_1: 45000,
                    week_n: 8000,
                    refine_week_1: 30000
                }
            };

            const postRequest = new Request('http://localhost/routing-policy', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${ADMIN_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ policy })
            });

            const postResponse = await adminApp.fetch(postRequest, mockEnv);
            expect(postResponse.status).toBe(200);

            const getRequest = new Request('http://localhost/routing-policy', {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${ADMIN_API_KEY}` }
            });
            const getResponse = await adminApp.fetch(getRequest, mockEnv);
            const json = await getResponse.json() as { policy: { version: string } };

            expect(getResponse.status).toBe(200);
            expect(json.policy.version).toBe('override-v2');
        });
    });
});
