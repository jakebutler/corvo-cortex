import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import adminApp from '../../../src/routes/admin';
import { createMockKV, createMockClientConfig, TEST_API_KEY, ADMIN_API_KEY } from '../../mocks/env';
import type { Env, RateLimitUsage } from '../../../src/types';

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
});
