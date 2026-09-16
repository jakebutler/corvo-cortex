import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import responsesApp from '../../../src/routes/responses';
import { createMockEnv, createMockKV, createMockClientConfig, TEST_API_KEY } from '../../mocks/env';
import type { Env } from '../../../src/types';

const originalFetch = globalThis.fetch;

describe('Responses Route - /v1/responses', () => {
    let mockEnv: Env;

    const mockExecutionCtx = {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn()
    } as unknown as ExecutionContext;

    beforeEach(() => {
        mockEnv = createMockEnv();

        globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
            if (url.includes('api.fireworks.ai')) {
                return new Response(JSON.stringify({
                    id: 'resp_test_123',
                    object: 'response',
                    model: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
                    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello from Fireworks' }] }],
                    usage: {
                        prompt_tokens: 10,
                        completion_tokens: 4,
                        total_tokens: 14
                    }
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

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

    it('does not include rate limit headers on successful responses', async () => {
        const request = new Request('http://localhost/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${TEST_API_KEY}`
            },
            body: JSON.stringify({
                model: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
                input: 'Hello'
            })
        });

        const response = await responsesApp.fetch(request, mockEnv, mockExecutionCtx);

        expect(response.status).toBe(200);
        expect(response.headers.get('RateLimit-Limit')).toBeNull();
        expect(response.headers.get('RateLimit-Remaining')).toBeNull();
        expect(response.headers.get('RateLimit-Reset')).toBeNull();
        expect(response.headers.get('RateLimit-Used')).toBeNull();
    });

    it('returns 413 when the request body exceeds the configured size limit', async () => {
        const smallEnv = createMockEnv({ MAX_BODY_BYTES: '100' });

        const request = new Request('http://localhost/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${TEST_API_KEY}`
            },
            body: JSON.stringify({
                model: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
                input: 'x'.repeat(500)
            })
        });

        const response = await responsesApp.fetch(request, smallEnv, mockExecutionCtx);

        expect(response.status).toBe(413);
        const json = await response.json() as { error: string };
        expect(json.error).toContain('too large');
    });

    it('returns 400 when max_tokens exceeds the ceiling', async () => {
        const request = new Request('http://localhost/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${TEST_API_KEY}`
            },
            body: JSON.stringify({
                model: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
                input: 'Hello',
                max_tokens: 40_000
            })
        });

        const response = await responsesApp.fetch(request, mockEnv, mockExecutionCtx);

        expect(response.status).toBe(400);
        const json = await response.json() as { details: string };
        expect(json.details).toContain('max_tokens');
    });

    it('returns 403 when the model is outside the client allowlist', async () => {
        const restrictedEnv = createMockEnv({
            CORTEX_CLIENTS: createMockKV({
                [TEST_API_KEY]: createMockClientConfig({ allowedModels: ['gpt-4o'] })
            })
        });

        const request = new Request('http://localhost/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${TEST_API_KEY}`
            },
            body: JSON.stringify({
                model: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
                input: 'Hello'
            })
        });

        const response = await responsesApp.fetch(request, restrictedEnv, mockExecutionCtx);

        expect(response.status).toBe(403);
        const json = await response.json() as { error: string; model: string };
        expect(json.error).toBe('Forbidden');
        expect(json.model).toBe('accounts/fireworks/models/llama-v3p1-8b-instruct');
        expect(globalThis.fetch).not.toHaveBeenCalledWith(expect.stringContaining('api.fireworks.ai'), expect.anything());
    });

    it('returns 400 when the body is not a JSON object', async () => {
        const request = new Request('http://localhost/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${TEST_API_KEY}`
            },
            body: 'not json at all'
        });

        const response = await responsesApp.fetch(request, mockEnv, mockExecutionCtx);

        expect(response.status).toBe(400);
    });

    it('returns a sanitized envelope instead of raw upstream error bodies', async () => {
        const secretUpstreamBody = 'account_id=fw_SECRET789 request_id=req_AA1';
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
            if (url.includes('api.fireworks.ai')) {
                return new Response(JSON.stringify({ error: secretUpstreamBody }), {
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
                model: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
                input: 'Hello'
            })
        });

        const response = await responsesApp.fetch(request, mockEnv, mockExecutionCtx);
        const json = await response.json() as { details: { provider: string; status: number; class: string } };

        expect(response.status).toBe(400);
        expect(JSON.stringify(json)).not.toContain('fw_SECRET789');
        expect(JSON.stringify(json)).not.toContain('req_AA1');
        expect(json.details).toEqual({
            provider: 'fireworks',
            status: 400,
            class: 'bad_request'
        });

        const logged = consoleErrorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
        expect(logged).toContain('fw_SECRET789');
        consoleErrorSpy.mockRestore();
    });

    it('sanitizes exception messages on network failure paths', async () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        globalThis.fetch = vi.fn().mockImplementation(async () => {
            throw new Error('connection refused to fw-internal.edge.example');
        });

        const request = new Request('http://localhost/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${TEST_API_KEY}`
            },
            body: JSON.stringify({
                model: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
                input: 'Hello'
            })
        });

        const response = await responsesApp.fetch(request, mockEnv, mockExecutionCtx);
        const json = await response.json() as { details: { status: number; class: string } };

        expect(response.status).toBe(500);
        expect(JSON.stringify(json)).not.toContain('fw-internal.edge.example');
        expect(json.details.class).toBe('upstream_error');

        const logged = consoleErrorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
        expect(logged).toContain('fw-internal.edge.example');
        consoleErrorSpy.mockRestore();
    });
});