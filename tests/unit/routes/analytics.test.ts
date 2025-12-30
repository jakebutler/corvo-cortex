import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import analyticsApp from '../../../src/routes/analytics';
import { createMockKV, createMockClientConfig, TEST_API_KEY, ADMIN_API_KEY } from '../../mocks/env';
import type { Env } from '../../../src/types';

describe('Analytics Route - /analytics', () => {
    let mockEnv: Env;

    function createMockEnv(overrides: Partial<Env> = {}): Env {
        return {
            CORTEX_CLIENTS: createMockKV({
                [TEST_API_KEY]: createMockClientConfig(),
                [ADMIN_API_KEY]: createMockClientConfig({ admin: true })
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
            const request = new Request('http://localhost/costs', {
                method: 'GET'
            });

            const response = await analyticsApp.fetch(request, mockEnv);

            expect(response.status).toBe(401);
        });

        it('should return 403 for non-admin API key', async () => {
            const request = new Request('http://localhost/costs', {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${TEST_API_KEY}` }
            });

            const response = await analyticsApp.fetch(request, mockEnv);

            expect(response.status).toBe(403);
        });
    });

    describe('GET /costs', () => {
        it('should return LangFuse info', async () => {
            const request = new Request('http://localhost/costs?from=2024-01-01', {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${ADMIN_API_KEY}` }
            });

            const response = await analyticsApp.fetch(request, mockEnv);

            expect(response.status).toBe(200);
            const json = await response.json() as { message: string; langfuseUrl: string; params: { from: string } };
            expect(json.message).toContain('LangFuse dashboard');
            expect(json.langfuseUrl).toBeDefined();
            expect(json.params.from).toBe('2024-01-01');
        });
    });

    describe('GET /metrics', () => {
        it('should return metrics summary structure', async () => {
            const request = new Request('http://localhost/metrics?app=test-app', {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${ADMIN_API_KEY}` }
            });

            const response = await analyticsApp.fetch(request, mockEnv);

            expect(response.status).toBe(200);
            const json = await response.json() as { availableMetrics: string[] };
            expect(Array.isArray(json.availableMetrics)).toBe(true);
            expect(json.availableMetrics).toContain('total_requests');
        });
    });

    describe('GET /export', () => {
        it('should return export instructions', async () => {
            const request = new Request('http://localhost/export?format=csv', {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${ADMIN_API_KEY}` }
            });

            const response = await analyticsApp.fetch(request, mockEnv);

            expect(response.status).toBe(200);
            const json = await response.json() as { instructions: string; exportUrl: string };
            expect(json.instructions).toBeDefined();
            expect(json.exportUrl).toBeDefined();
        });
    });
});
