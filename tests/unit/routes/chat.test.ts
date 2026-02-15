import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import chatApp from '../../../src/routes/chat';
import { createMockKV, createMockClientConfig, createMockCircuitBreaker, createMockCreditLedger, TEST_API_KEY } from '../../mocks/env';
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
                    model: 'claude-3-5-sonnet',
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
});
