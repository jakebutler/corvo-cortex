import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import chatApp from '../../../src/routes/chat';
import { createMockKV, createMockClientConfig, createMockCircuitBreaker, TEST_API_KEY } from '../../mocks/env';
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
});
