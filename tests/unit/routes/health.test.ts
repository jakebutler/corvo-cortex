import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import healthApp from '../../../src/routes/health';
import { createMockKV, createMockClientConfig, createMockCircuitBreaker, TEST_API_KEY, ADMIN_API_KEY } from '../../mocks/env';
import type { Env } from '../../../src/types';

describe('Health Route - /health', () => {
    let mockEnv: Env;

    function createMockEnv(overrides: Partial<Env> = {}): Env {
        return {
            CORTEX_CLIENTS: createMockKV({
                [TEST_API_KEY]: createMockClientConfig(),
                [ADMIN_API_KEY]: createMockClientConfig({ admin: true })
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

    beforeEach(() => {
        mockEnv = createMockEnv();
    });

    describe('Authentication', () => {
        it('should return 401 when Authorization header is missing', async () => {
            const request = new Request('http://localhost/providers', {
                method: 'GET'
            });

            const response = await healthApp.fetch(request, mockEnv);

            expect(response.status).toBe(401);
            const json = await response.json() as { error: string };
            expect(json.error).toContain('Missing API key');
        });

        it('should return 401 for invalid API key', async () => {
            const request = new Request('http://localhost/providers', {
                method: 'GET',
                headers: { 'Authorization': 'Bearer invalid-key' }
            });

            const response = await healthApp.fetch(request, mockEnv);

            expect(response.status).toBe(401);
        });

        it('should return 403 for non-admin API key', async () => {
            const request = new Request('http://localhost/providers', {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${TEST_API_KEY}` }
            });

            const response = await healthApp.fetch(request, mockEnv);

            expect(response.status).toBe(403);
            const json = await response.json() as { error: string };
            expect(json.error).toContain('Admin access required');
        });

        it('should pass for admin API key', async () => {
            const request = new Request('http://localhost/providers', {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${ADMIN_API_KEY}` }
            });

            const response = await healthApp.fetch(request, mockEnv);

            // Our mock breaker returns static data, so 200 means success
            expect(response.status).toBe(200);
        });
    });

    describe('GET /providers', () => {
        it('should return circuit breaker status', async () => {
            const request = new Request('http://localhost/providers', {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${ADMIN_API_KEY}` }
            });

            const response = await healthApp.fetch(request, mockEnv);

            expect(response.status).toBe(200);
            const json = await response.json() as { breakers: Array<unknown> };
            expect(Array.isArray(json.breakers)).toBe(true);
        });

        it('should return 501 if circuit breaker binding is missing', async () => {
            const envNoBreaker = createMockEnv({ CIRCUIT_BREAKER: undefined });
            const request = new Request('http://localhost/providers', {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${ADMIN_API_KEY}` }
            });

            const response = await healthApp.fetch(request, envNoBreaker);

            expect(response.status).toBe(501);
            const json = await response.json() as { error: string };
            expect(json.error).toBe('Circuit breaker not available');
        });
    });

    describe('POST /reset/:provider', () => {
        it('should reset circuit breaker for provider', async () => {
            const request = new Request('http://localhost/reset/openai', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${ADMIN_API_KEY}` }
            });

            const response = await healthApp.fetch(request, mockEnv);

            expect(response.status).toBe(200);
            const json = await response.json() as { success: boolean };
            expect(json.success).toBe(true);
        });

        it('should return 501 if circuit breaker binding is missing', async () => {
            const envNoBreaker = createMockEnv({ CIRCUIT_BREAKER: undefined });
            const request = new Request('http://localhost/reset/openai', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${ADMIN_API_KEY}` }
            });

            const response = await healthApp.fetch(request, envNoBreaker);

            expect(response.status).toBe(501);
        });
    });
});
