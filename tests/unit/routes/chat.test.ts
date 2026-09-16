import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import chatApp from '../../../src/routes/chat';
import { setCreditBalance, getCreditBalance } from '../../../src/services/credits';
import {
    createMockKV,
    createMockClientConfig,
    createMockCircuitBreaker,
    createMockCreditLedger,
    createMockProviderConcurrency,
    TEST_API_KEY
} from '../../mocks/env';
import type { Env, Variables } from '../../../src/types';

// Mock the fetch function for provider calls
const originalFetch = globalThis.fetch;

describe('Chat Route - /v1/chat/completions', () => {
    let mockEnv: Env;

    function createMockEnv(overrides: Partial<Env> = {}): Env {
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
            CREDIT_LEDGER: createMockCreditLedger(),
            PROVIDER_CONCURRENCY: createMockProviderConcurrency(),
            ENVIRONMENT: 'test',
            CREDITS_OPENAI: 'true', // Enable direct OpenAI credits for testing
            ...overrides
        } as Env;
    }

    const mockExecutionCtx = {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn()
    } as unknown as ExecutionContext;

    beforeEach(() => {
        mockEnv = createMockEnv();

        // Mock fetch for provider calls
        globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
            if (url.includes('/api/v1/credits')) {
                return new Response(JSON.stringify({
                    data: {
                        total_credits: 100,
                        total_usage: 12
                    }
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }

            // Mock successful OpenAI response
            if (url.includes('openai.com')) {
                return new Response(JSON.stringify({
                    id: 'chatcmpl-test',
                    object: 'chat.completion',
                    created: Math.floor(Date.now() / 1000),
                    model: 'gpt-4o',
                    choices: [{
                        index: 0,
                        message: { role: 'assistant', content: 'Hello! How can I help?' },
                        finish_reason: 'stop'
                    }],
                    usage: {
                        prompt_tokens: 10,
                        completion_tokens: 5,
                        total_tokens: 15
                    }
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }

            // Mock OpenRouter fallback response
            if (url.includes('openrouter.ai')) {
                return new Response(JSON.stringify({
                    id: 'chatcmpl-router',
                    object: 'chat.completion',
                    created: Math.floor(Date.now() / 1000),
                    model: 'gpt-4o',
                    choices: [{
                        index: 0,
                        message: { role: 'assistant', content: 'Hello from OpenRouter!' },
                        finish_reason: 'stop'
                    }],
                    usage: {
                        prompt_tokens: 10,
                        completion_tokens: 5,
                        total_tokens: 15
                    }
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }

            // Mock Langfuse API
            if (url.includes('langfuse.com')) {
                return new Response(JSON.stringify({ success: true }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            return new Response('Not found', { status: 404 });
        });
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    describe('Authentication', () => {
        it('should return 401 when Authorization header is missing', async () => {
            const request = new Request('http://localhost/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'gpt-4o',
                    messages: [{ role: 'user', content: 'Hello' }]
                })
            });

            const response = await chatApp.fetch(request, mockEnv, mockExecutionCtx);

            expect(response.status).toBe(401);
            const json = await response.json() as { error: string };
            expect(json.error).toContain('Missing API key');
        });

        it('should return 401 for invalid API key', async () => {
            const request = new Request('http://localhost/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer invalid-key'
                },
                body: JSON.stringify({
                    model: 'gpt-4o',
                    messages: [{ role: 'user', content: 'Hello' }]
                })
            });

            const response = await chatApp.fetch(request, mockEnv, mockExecutionCtx);

            expect(response.status).toBe(401);
            const json = await response.json() as { error: string };
            expect(json.error).toBe('Invalid API Key');
        });
    });

    describe('Request Validation', () => {
        it('should return 400 for empty messages array', async () => {
            const request = new Request('http://localhost/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${TEST_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'gpt-4o',
                    messages: []
                })
            });

            const response = await chatApp.fetch(request, mockEnv, mockExecutionCtx);

            expect(response.status).toBe(400);
            const json = await response.json() as { error: string };
            expect(json.error).toBe('Invalid request');
        });

        it('should return 400 for invalid temperature', async () => {
            const request = new Request('http://localhost/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${TEST_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'gpt-4o',
                    messages: [{ role: 'user', content: 'Hello' }],
                    temperature: 3.0 // Invalid: max is 2.0
                })
            });

            const response = await chatApp.fetch(request, mockEnv, mockExecutionCtx);

            expect(response.status).toBe(400);
        });
    });

    describe('Successful Requests', () => {
        it('should complete a valid chat request', async () => {
            const request = new Request('http://localhost/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${TEST_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'gpt-4o',
                    messages: [{ role: 'user', content: 'Hello' }]
                })
            });

            const response = await chatApp.fetch(request, mockEnv, mockExecutionCtx);

            expect(response.status).toBe(200);
            const json = await response.json() as {
                id: string;
                choices: Array<{ message: { content: string } }>;
            };
            expect(json.id).toBe('chatcmpl-test');
            expect(json.choices[0].message.content).toBe('Hello! How can I help?');
        });

        it('should not include rate limit headers on successful responses', async () => {
            const request = new Request('http://localhost/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${TEST_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'gpt-4o',
                    messages: [{ role: 'user', content: 'Hello' }]
                })
            });

            const response = await chatApp.fetch(request, mockEnv, mockExecutionCtx);

            expect(response.status).toBe(200);
            expect(response.headers.get('RateLimit-Limit')).toBeNull();
            expect(response.headers.get('RateLimit-Remaining')).toBeNull();
            expect(response.headers.get('RateLimit-Reset')).toBeNull();
            expect(response.headers.get('RateLimit-Used')).toBeNull();
        });

        it('should use default model when not specified', async () => {
            const request = new Request('http://localhost/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${TEST_API_KEY}`
                },
                body: JSON.stringify({
                    messages: [{ role: 'user', content: 'Hello' }]
                })
            });

            const response = await chatApp.fetch(request, mockEnv, mockExecutionCtx);

            expect(response.status).toBe(200);
            // Verify fetch was called (provider routing worked)
            expect(globalThis.fetch).toHaveBeenCalled();
        });
    });

    describe('Provider Routing', () => {
        it('should return 429 when Z.ai model concurrency limit is reached', async () => {
            const envWithConcurrencyRejection = {
                ...mockEnv,
                PROVIDER_CONCURRENCY: createMockProviderConcurrency({
                    acquireStatus: 429,
                    acquirePayload: { acquired: false, limit: 3, inFlight: 3 }
                })
            } as Env;

            const request = new Request('http://localhost/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${TEST_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'glm-5',
                    messages: [{ role: 'user', content: 'Hello' }]
                })
            });

            const response = await chatApp.fetch(request, envWithConcurrencyRejection, mockExecutionCtx);
            const json = await response.json() as { error: string; provider: string };

            expect(response.status).toBe(429);
            expect(json.error).toBe('Provider concurrency limit reached');
            expect(json.provider).toBe('z-ai-pro');
        });

        it('should fallback to OpenRouter when direct credits exhausted', async () => {
            // Create env without direct credits
            const envNoCredits = createMockEnv({
                CREDITS_OPENAI: undefined,
                CREDITS_ANTHROPIC: undefined
            });

            const request = new Request('http://localhost/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${TEST_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'gpt-4o',
                    messages: [{ role: 'user', content: 'Hello' }]
                })
            });

            const response = await chatApp.fetch(request, envNoCredits, mockExecutionCtx);

            expect(response.status).toBe(200);
            // Should have called OpenRouter
            expect(globalThis.fetch).toHaveBeenCalledWith(
                expect.stringContaining('openrouter.ai'),
                expect.any(Object)
            );
        });

        it('should return 402 when fail-fast strategy and no credits', async () => {
            // Create client with fail-fast strategy
            const failFastEnv = {
                ...mockEnv,
                CORTEX_CLIENTS: createMockKV({
                    [TEST_API_KEY]: createMockClientConfig({ fallbackStrategy: 'fail-fast' })
                }),
                CREDITS_OPENAI: undefined,
                CREDITS_ANTHROPIC: undefined
            } as Env;

            const request = new Request('http://localhost/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${TEST_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'gpt-4o',
                    messages: [{ role: 'user', content: 'Hello' }]
                })
            });

            const response = await chatApp.fetch(request, failFastEnv, mockExecutionCtx);

            expect(response.status).toBe(402);
            const json = await response.json() as { error: string };
            expect(json.error).toBe('Payment Required');
        });

        it('should retry through OpenRouter when Anthropic responds with credit exhaustion', async () => {
            const anthropicCreditError = {
                ...createMockEnv({
                    CREDITS_ANTHROPIC: 'true',
                    CREDITS_OPENAI: undefined
                })
            };

            globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
                if (url.includes('/api/v1/credits')) {
                    return new Response(JSON.stringify({
                        data: { total_credits: 100, total_usage: 12 }
                    }), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }

                if (url.includes('anthropic.com')) {
                    return new Response(JSON.stringify({
                        error: {
                            type: 'insufficient_credits',
                            message: 'Insufficient credits'
                        }
                    }), {
                        status: 402,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }

                if (url.includes('openrouter.ai')) {
                    return new Response(JSON.stringify({
                        id: 'chatcmpl-router',
                        object: 'chat.completion',
                        created: Math.floor(Date.now() / 1000),
                        model: 'claude-3-5-sonnet',
                        choices: [{
                            index: 0,
                            message: { role: 'assistant', content: 'Fallback success' },
                            finish_reason: 'stop'
                        }],
                        usage: {
                            prompt_tokens: 10,
                            completion_tokens: 5,
                            total_tokens: 15
                        }
                    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
                }

                return new Response('Not found', { status: 404 });
            });

            const request = new Request('http://localhost/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${TEST_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'claude-sonnet-4-6',
                    messages: [{ role: 'user', content: 'Hello' }]
                })
            });

            const response = await chatApp.fetch(request, anthropicCreditError, mockExecutionCtx);
            const json = await response.json() as { choices: Array<{ message: { content: string } }> };

            expect(response.status).toBe(200);
            expect(json.choices[0].message.content).toBe('Fallback success');
            expect(globalThis.fetch).toHaveBeenCalledWith(
                expect.stringContaining('anthropic.com'),
                expect.any(Object)
            );
            expect(globalThis.fetch).toHaveBeenCalledWith(
                expect.stringContaining('openrouter.ai/api/v1/chat/completions'),
                expect.any(Object)
            );
            expect(response.headers.get('x-corvo-cortex-provider')).toBe('openrouter');
            expect(response.headers.get('x-corvo-cortex-fallback-used')).toBe('true');
        });
    });

    describe('Error Handling', () => {
        it('should handle provider errors gracefully', async () => {
            // Mock a provider error
            globalThis.fetch = vi.fn().mockResolvedValue(
                new Response(JSON.stringify({ error: 'Provider unavailable' }), {
                    status: 503,
                    headers: { 'Content-Type': 'application/json' }
                })
            );

            const request = new Request('http://localhost/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${TEST_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'gpt-4o',
                    messages: [{ role: 'user', content: 'Hello' }]
                })
            });

            const response = await chatApp.fetch(request, mockEnv, mockExecutionCtx);

            expect(response.status).toBe(503);
            const json = await response.json() as { error: string; provider: string };
            expect(json.error).toBe('Provider error');
            expect(json.provider).toBeDefined();
        });
        it('does not zero the ledger when a provider 400 mentions quota', async () => {
            const quotaEnv = createMockEnv({
                CREDITS_ANTHROPIC: 'true',
                CREDITS_OPENAI: undefined,
                CORTEX_CLIENTS: createMockKV({
                    [TEST_API_KEY]: createMockClientConfig({ fallbackStrategy: 'fail-fast' })
                })
            });
            await setCreditBalance(quotaEnv, 'anthropic-direct', 2.5, 'USD');

            globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
                if (url.includes('anthropic.com')) {
                    return new Response(JSON.stringify({
                        error: { type: 'quota_exceeded', message: 'Your quota is exhausted for this model' }
                    }), {
                        status: 400,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }
                return new Response('Not found', { status: 404 });
            });

            const request = new Request('http://localhost/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${TEST_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'claude-sonnet-4-6',
                    messages: [{ role: 'user', content: 'Hello' }]
                })
            });

            const response = await chatApp.fetch(request, quotaEnv, mockExecutionCtx);
            expect(response.status).toBe(400);

            const balance = await getCreditBalance(quotaEnv, 'anthropic-direct');
            expect(balance.balance).toBeCloseTo(2.5, 6);
            expect(balance.exhausted).toBe(false);
        });

        it('returns 402 when the reservation exceeds the available floor', async () => {
            const lowBalanceEnv = createMockEnv({
                CREDITS_OPENAI: 'true',
                CORTEX_CLIENTS: createMockKV({
                    [TEST_API_KEY]: createMockClientConfig({ fallbackStrategy: 'fail-fast' })
                })
            });
            await setCreditBalance(lowBalanceEnv, 'openai-direct', 0.001, 'USD');

            const request = new Request('http://localhost/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${TEST_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'gpt-4o',
                    messages: [{ role: 'user', content: 'Hello' }]
                })
            });

            const response = await chatApp.fetch(request, lowBalanceEnv, mockExecutionCtx);

            expect(response.status).toBe(402);
            const json = await response.json() as { error: string };
            expect(json.error).toBe('Payment Required');
            expect(globalThis.fetch).not.toHaveBeenCalledWith(expect.stringContaining('openai.com'), expect.anything());
        });

        it('falls back to OpenRouter when the reservation declines with a fallback strategy', async () => {
            const lowBalanceEnv = createMockEnv({
                CREDITS_OPENAI: 'true',
                CREDITS_ANTHROPIC: undefined
            });
            await setCreditBalance(lowBalanceEnv, 'openai-direct', 0.001, 'USD');

            const request = new Request('http://localhost/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${TEST_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'gpt-4o',
                    messages: [{ role: 'user', content: 'Hello' }]
                })
            });

            const response = await chatApp.fetch(request, lowBalanceEnv, mockExecutionCtx);

            expect(response.status).toBe(200);
            expect(globalThis.fetch).toHaveBeenCalledWith(
                expect.stringContaining('openrouter.ai'),
                expect.anything()
            );
        });

        it('returns a sanitized envelope instead of raw upstream error bodies', async () => {
            const secretUpstreamBody = 'org_id=acct_SECRET123 internal_req=req_ZZ9 limit=12%';
            const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
                if (url.includes('openai.com')) {
                    return new Response(JSON.stringify({ error: secretUpstreamBody }), {
                        status: 429,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }
                return new Response('Not found', { status: 404 });
            });

            const request = new Request('http://localhost/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${TEST_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'gpt-4o',
                    messages: [{ role: 'user', content: 'Hello' }]
                })
            });

            const response = await chatApp.fetch(request, mockEnv, mockExecutionCtx);
            const json = await response.json() as { details: { provider: string; status: number; class: string } };

            expect(response.status).toBe(429);
            expect(JSON.stringify(json)).not.toContain('acct_SECRET123');
            expect(JSON.stringify(json)).not.toContain('req_ZZ9');
            expect(json.details).toEqual({
                provider: 'openai-direct',
                status: 429,
                class: 'throttled'
            });

            const logged = consoleErrorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
            expect(logged).toContain('acct_SECRET123');
            consoleErrorSpy.mockRestore();
        });

        it('sanitizes exception messages on network failure paths', async () => {
            const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            globalThis.fetch = vi.fn().mockImplementation(async () => {
                throw new Error('connect ECONNREFUSED 10.1.2.3:443 secret-host.internal');
            });

            const request = new Request('http://localhost/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${TEST_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'gpt-4o',
                    messages: [{ role: 'user', content: 'Hello' }]
                })
            });

            const response = await chatApp.fetch(request, mockEnv, mockExecutionCtx);
            const json = await response.json() as { details: { status: number; class: string } };

            expect(response.status).toBe(500);
            expect(JSON.stringify(json)).not.toContain('ECONNREFUSED');
            expect(JSON.stringify(json)).not.toContain('secret-host.internal');
            expect(json.details.class).toBe('upstream_error');

            const logged = consoleErrorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
            expect(logged).toContain('ECONNREFUSED');
            consoleErrorSpy.mockRestore();
        });

        it('rejects image inputs routed to an adapter that cannot serve them', async () => {
            const anthropicEnv = createMockEnv({ CREDITS_ANTHROPIC: 'true' });
            globalThis.fetch = vi.fn().mockImplementation(async () => new Response('Not found', { status: 404 }));

            const request = new Request('http://localhost/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${TEST_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'claude-sonnet-4-6',
                    messages: [{
                        role: 'user',
                        content: [
                            { type: 'text', text: 'What is in this image?' },
                            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
                        ]
                    }]
                })
            });

            const response = await chatApp.fetch(request, anthropicEnv, mockExecutionCtx);

            expect(response.status).toBe(400);
            const json = await response.json() as { error: string; details: string[] };
            expect(json.error).toBe('Invalid request');
            expect(json.details.some((problem) => problem.includes('image inputs'))).toBe(true);
            expect(globalThis.fetch).not.toHaveBeenCalledWith(expect.stringContaining('anthropic.com'), expect.anything());
        });
    });

    describe('Header-Driven Routing', () => {
        it('routes by x-kinisi headers and emits x-corvo-cortex metadata headers', async () => {
            const request = new Request('http://localhost/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${TEST_API_KEY}`,
                    'x-kinisi-llm-stage': 'week_n',
                    'x-kinisi-routing-strategy': 'speed',
                    'x-kinisi-provider-prefer': 'openrouter,fireworks',
                    'x-kinisi-model': 'gpt-5-mini'
                },
                body: JSON.stringify({
                    messages: [{ role: 'user', content: 'Generate week plan JSON' }]
                })
            });

            const response = await chatApp.fetch(request, mockEnv, mockExecutionCtx);

            expect(response.status).toBe(200);
            expect(globalThis.fetch).toHaveBeenCalledWith(
                expect.stringContaining('openrouter.ai'),
                expect.any(Object)
            );
            expect(response.headers.get('x-corvo-cortex-provider')).toBe('openrouter');
            expect(response.headers.get('x-corvo-cortex-model')).toBe('gpt-5-mini');
            expect(response.headers.get('x-corvo-cortex-route-id')).not.toBe('unknown');
            expect(response.headers.get('x-corvo-cortex-fallback-used')).toBe('false');
            expect(response.headers.get('x-corvo-cortex-hedge-used')).toBe('false');
        });

        it('rejects stream=true when strict response_format.json_schema is requested', async () => {
            const request = new Request('http://localhost/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${TEST_API_KEY}`,
                    'x-kinisi-llm-stage': 'week_1'
                },
                body: JSON.stringify({
                    model: 'gpt-5-mini',
                    stream: true,
                    messages: [{ role: 'user', content: 'Generate week plan JSON' }],
                    response_format: {
                        type: 'json_schema',
                        json_schema: {
                            name: 'week_blueprint',
                            schema: {
                                type: 'object',
                                required: ['weeks'],
                                properties: {
                                    weeks: { type: 'array' }
                                }
                            }
                        }
                    }
                })
            });

            const response = await chatApp.fetch(request, mockEnv, mockExecutionCtx);
            const json = await response.json() as { error: { class: string } };

            expect(response.status).toBe(400);
            expect(json.error.class).toBe('invalid_request');
            expect(response.headers.get('x-corvo-cortex-provider')).toBe('unknown');
            expect(response.headers.get('x-corvo-cortex-latency-ms')).not.toBe('unknown');
        });

        it('returns 422 schema_invalid and deterministic metadata when all strict-schema candidates fail', async () => {
            const request = new Request('http://localhost/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${TEST_API_KEY}`,
                    'x-kinisi-llm-stage': 'week_n',
                    'x-kinisi-routing-strategy': 'speed',
                    'x-kinisi-provider-allow': 'openrouter'
                },
                body: JSON.stringify({
                    model: 'gpt-5-mini',
                    messages: [{ role: 'user', content: 'Generate week plan JSON' }],
                    response_format: {
                        type: 'json_schema',
                        json_schema: {
                            name: 'week_blueprint',
                            schema: {
                                type: 'object',
                                required: ['weeks'],
                                properties: {
                                    weeks: { type: 'array', minItems: 1 }
                                }
                            }
                        }
                    }
                })
            });

            const response = await chatApp.fetch(request, mockEnv, mockExecutionCtx);
            const json = await response.json() as {
                error: { class: string; reason_codes: string[]; route_id: string };
            };

            expect(response.status).toBe(422);
            expect(json.error.class).toBe('schema_invalid');
            expect(json.error.reason_codes).toContain('schema_invalid');
            expect(json.error.route_id).toBeDefined();
            expect(response.headers.get('x-corvo-cortex-route-id')).toBe(json.error.route_id);
            expect(response.headers.get('x-corvo-cortex-provider')).toBe('unknown');
            expect(response.headers.get('x-corvo-cortex-fallback-used')).toBe('true');
            expect(response.headers.get('x-corvo-cortex-cache-hit')).toBe('unknown');
        });
    });

    describe('Spend Guardrails', () => {
        it('returns 413 when the request body exceeds the configured size limit', async () => {
            const smallEnv = createMockEnv({ MAX_BODY_BYTES: '100' });

            const request = new Request('http://localhost/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${TEST_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'gpt-4o',
                    messages: [{ role: 'user', content: 'x'.repeat(500) }]
                })
            });

            const response = await chatApp.fetch(request, smallEnv, mockExecutionCtx);

            expect(response.status).toBe(413);
            const json = await response.json() as { error: string };
            expect(json.error).toContain('too large');
        });

        it('returns 400 when max_tokens exceeds the configured ceiling', async () => {
            const request = new Request('http://localhost/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${TEST_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'gpt-4o',
                    max_tokens: 40_000,
                    messages: [{ role: 'user', content: 'Hello' }]
                })
            });

            const response = await chatApp.fetch(request, mockEnv, mockExecutionCtx);

            expect(response.status).toBe(400);
            const json = await response.json() as { details: Array<{ message: string }> };
            expect(JSON.stringify(json.details)).toContain('ceiling');
        });

        it('honours a configured MAX_TOKENS_CEILING override', async () => {
            const lowCeilingEnv = createMockEnv({ MAX_TOKENS_CEILING: '100' });

            const request = new Request('http://localhost/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${TEST_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'gpt-4o',
                    max_tokens: 101,
                    messages: [{ role: 'user', content: 'Hello' }]
                })
            });

            const response = await chatApp.fetch(request, lowCeilingEnv, mockExecutionCtx);
            expect(response.status).toBe(400);
        });

        it('returns 400 when the request has more than 128 messages', async () => {
            const messages = Array.from({ length: 129 }, (_, i) => ({ role: 'user', content: `msg ${i}` }));

            const request = new Request('http://localhost/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${TEST_API_KEY}`
                },
                body: JSON.stringify({ model: 'gpt-4o', messages })
            });

            const response = await chatApp.fetch(request, mockEnv, mockExecutionCtx);

            expect(response.status).toBe(400);
            const json = await response.json() as { details: Array<{ message: string }> };
            expect(JSON.stringify(json.details)).toContain('Too many messages');
        });

        it('returns 400 when a message content string exceeds the per-message cap', async () => {
            const request = new Request('http://localhost/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${TEST_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'gpt-4o',
                    messages: [{ role: 'user', content: 'x'.repeat(262_145) }]
                })
            });

            const response = await chatApp.fetch(request, mockEnv, mockExecutionCtx);
            expect(response.status).toBe(400);
        });

        it('returns 400 when an image data URL exceeds the length cap', async () => {
            const request = new Request('http://localhost/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${TEST_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'gpt-4o',
                    messages: [{
                        role: 'user',
                        content: [{
                            type: 'image_url',
                            image_url: { url: `data:image/png;base64,${'A'.repeat(1_572_864)}` }
                        }]
                    }]
                })
            });

            const response = await chatApp.fetch(request, mockEnv, mockExecutionCtx);
            expect(response.status).toBe(400);
        });

        it('returns 403 in legacy mode when the model is outside the client allowlist', async () => {
            const restrictedEnv = createMockEnv({
                CORTEX_CLIENTS: createMockKV({
                    [TEST_API_KEY]: createMockClientConfig({ allowedModels: ['glm-4-plus', 'gpt-4o*'] })
                })
            });

            const request = new Request('http://localhost/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${TEST_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'claude-3-5-sonnet',
                    messages: [{ role: 'user', content: 'Hello' }]
                })
            });

            const response = await chatApp.fetch(request, restrictedEnv, mockExecutionCtx);

            expect(response.status).toBe(403);
            const json = await response.json() as { error: string; model: string };
            expect(json.error).toBe('Forbidden');
            expect(json.model).toBe('claude-sonnet-4-6');
            expect(globalThis.fetch).not.toHaveBeenCalledWith(expect.stringContaining('openai.com'), expect.anything());
        });

        it('returns 403 in header mode when the requested model is outside the client allowlist', async () => {
            const restrictedEnv = createMockEnv({
                CORTEX_CLIENTS: createMockKV({
                    [TEST_API_KEY]: createMockClientConfig({ allowedModels: ['gpt-4o'] })
                })
            });

            const request = new Request('http://localhost/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${TEST_API_KEY}`,
                    'x-kinisi-llm-stage': 'week_n',
                    'x-kinisi-routing-strategy': 'speed',
                    'x-kinisi-model': 'gpt-5-mini'
                },
                body: JSON.stringify({
                    messages: [{ role: 'user', content: 'Generate week plan JSON' }]
                })
            });

            const response = await chatApp.fetch(request, restrictedEnv, mockExecutionCtx);

            expect(response.status).toBe(403);
            const json = await response.json() as { error: string; model: string };
            expect(json.error).toBe('Forbidden');
            expect(json.model).toBe('gpt-5-mini');
            expect(globalThis.fetch).not.toHaveBeenCalledWith(expect.stringContaining('openrouter.ai'), expect.anything());
        });

        it('allows prefix glob matches in the client allowlist', async () => {
            const restrictedEnv = createMockEnv({
                CORTEX_CLIENTS: createMockKV({
                    [TEST_API_KEY]: createMockClientConfig({ allowedModels: ['gpt-*'] })
                })
            });

            const request = new Request('http://localhost/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${TEST_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'gpt-4o',
                    messages: [{ role: 'user', content: 'Hello' }]
                })
            });

            const response = await chatApp.fetch(request, restrictedEnv, mockExecutionCtx);
            expect(response.status).toBe(200);
        });
    });
});
