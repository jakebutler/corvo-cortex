import { describe, it, expect } from 'vitest';
import { determineProvider } from '../../src/services/router';
import type { ClientConfig, Env } from '../../src/types';
import { createMockKV } from '../mocks/env';

describe('determineProvider', () => {
  const mockClient: ClientConfig = {
    appId: 'test-app',
    name: 'Test App',
    defaultModel: 'gpt-5-2',
    allowZai: true,
    fallbackStrategy: 'openrouter',
    rateLimit: {
      requestsPerMinute: 100,
      tokensPerMinute: 50000
    }
  };

  const mockEnv: Env = {
    CORTEX_CLIENTS: {} as any,
    CORTEX_CONFIG: createMockKV(),
    ANTHROPIC_API_KEY: 'test',
    OPENAI_API_KEY: 'test',
    ZAI_API_KEY: 'test',
    OPENROUTER_API_KEY: 'test',
    MINIMAX_API_KEY: 'test',
    FIREWORKS_API_KEY: 'test',
    LANGFUSE_PUBLIC_KEY: 'test',
    LANGFUSE_SECRET_KEY: 'test',
    CIRCUIT_BREAKER: {} as any,
    CREDIT_LEDGER: {} as any,
    ENVIRONMENT: 'test'
  };

  it('should route to MiniMax for minimax models with credits', async () => {
    const envWithCredits = { ...mockEnv, CREDITS_MINIMAX: 'true' };
    const route = await determineProvider('MiniMax-M2', mockClient, envWithCredits);
    expect(route.provider).toBe('minimax');
    expect(route.url).toContain('api.minimax.io');
    expect(route.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('should route to Z.ai for glm models', async () => {
    const route = await determineProvider('glm-5', mockClient, mockEnv);
    expect(route.provider).toBe('z-ai-pro');
    expect(route.url).toBe('https://api.z.ai/api/coding/paas/v4/chat/completions');
  });

  it('should route to Anthropic for claude models with credits', async () => {
    const envWithCredits = { ...mockEnv, CREDITS_ANTHROPIC: 'true' };
    const route = await determineProvider('claude-sonnet-4-6', mockClient, envWithCredits);
    expect(route.provider).toBe('anthropic-direct');
    expect(route.url).toContain('anthropic.com');
  });

  it('should route to OpenAI for gpt models with credits', async () => {
    const envWithCredits = { ...mockEnv, CREDITS_OPENAI: 'true' };
    const route = await determineProvider('gpt-5-2', mockClient, envWithCredits);
    expect(route.provider).toBe('openai-direct');
    expect(route.url).toContain('openai.com');
  });

  it('should route to OpenAI for o-series reasoning models with credits', async () => {
    const envWithCredits = { ...mockEnv, CREDITS_OPENAI: 'true' };
    const route = await determineProvider('o3', mockClient, envWithCredits);
    expect(route.provider).toBe('openai-direct');
    expect(route.url).toContain('openai.com');
  });

  it('should fallback to OpenRouter when credits exhausted', async () => {
    const route = await determineProvider('claude-sonnet-4-6', mockClient, mockEnv);
    expect(route.provider).toBe('openrouter');
    expect(route.url).toContain('openrouter.ai');
  });

  it('should fail-fast when fallback strategy is fail-fast', async () => {
    const failFastClient = { ...mockClient, fallbackStrategy: 'fail-fast' as const };
    await expect(determineProvider('claude-sonnet-4-6', failFastClient, mockEnv))
      .rejects
      .toThrow('Payment Required');
  });

  it('should use default model when model is not specified', async () => {
    const envWithCredits = { ...mockEnv, CREDITS_OPENAI: 'true' };
    // When no model is specified in request, chat.ts falls back to client.defaultModel (already aliased)
    const route = await determineProvider(mockClient.defaultModel, mockClient, envWithCredits);
    expect(route.provider).toBe('openai-direct');
  });
});
