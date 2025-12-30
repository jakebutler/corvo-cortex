import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import modelsApp from '../../../src/routes/models';
import { createMockKV, createMockClientConfig, TEST_API_KEY } from '../../mocks/env';
import type { Env } from '../../../src/types';

describe('Models Route - /v1/models', () => {
    let mockEnv: Env;

    function createMockEnv(overrides: Partial<Env> = {}): Env {
        return {
            CORTEX_CLIENTS: createMockKV({
                [TEST_API_KEY]: createMockClientConfig({ defaultModel: 'claude-3-5-sonnet' })
            }),
            CORTEX_CONFIG: createMockKV(),
            ANTHROPIC_API_KEY: 'test',
            OPENAI_API_KEY: 'test',
            ZAI_API_KEY: 'test',
            OPENROUTER_API_KEY: 'test',
            LANGFUSE_PUBLIC_KEY: 'test',
            LANGFUSE_SECRET_KEY: 'test',
            CIRCUIT_BREAKER: {} as unknown as DurableObjectNamespace,
            ENVIRONMENT: 'test',
            ...overrides
        } as Env;
    }

    beforeEach(() => {
        mockEnv = createMockEnv();
    });

    describe('Authentication', () => {
        it('should return 401 when Authorization header is missing', async () => {
            const request = new Request('http://localhost/', {
                method: 'GET'
            });

            const response = await modelsApp.fetch(request, mockEnv);

            expect(response.status).toBe(401);
        });

        it('should return 401 for invalid API key', async () => {
            const request = new Request('http://localhost/', {
                method: 'GET',
                headers: { 'Authorization': 'Bearer invalid-key' }
            });

            const response = await modelsApp.fetch(request, mockEnv);

            expect(response.status).toBe(401);
        });
    });

    describe('GET /', () => {
        it('should return curated models list', async () => {
            const request = new Request('http://localhost/', {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${TEST_API_KEY}` }
            });

            const response = await modelsApp.fetch(request, mockEnv);

            expect(response.status).toBe(200);
            const json = await response.json() as {
                object: string;
                data: Array<{ id: string }>;
                defaults: { client_default: string }
            };
            expect(json.object).toBe('list');
            expect(Array.isArray(json.data)).toBe(true);
            expect(json.data.length).toBeGreaterThan(0);
            expect(json.data.some(m => m.id === 'gpt-4o')).toBe(true);
        });

        it('should return correct client default model', async () => {
            const request = new Request('http://localhost/', {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${TEST_API_KEY}` }
            });

            const response = await modelsApp.fetch(request, mockEnv);

            expect(response.status).toBe(200);
            const json = await response.json() as { defaults: { client_default: string } };
            expect(json.defaults.client_default).toBe('claude-3-5-sonnet');
        });
    });
});
