import { describe, it, expect } from 'vitest';
import { determineProvider } from '../../src/services/router';
import type { ClientConfig, Env } from '../../src/types';

describe('determineProvider', () => {
  const mockClient: ClientConfig = {
    appId: 'test-app',
    name: 'Test App',
    defaultModel: 'gpt-4o',
    allowZai: true,
    fallbackStrategy: 'openrouter',
    rateLimit: {
      requestsPerMinute: 100,
      tokensPerMinute: 50000
    }
  };

  const mockEnv: Env = {
    CORTEX_CLIENTS: {} as any,
    CORTEX_CONFIG: {} as any,
    ANTHROPIC_API_KEY: 'test',
    OPENAI_API_KEY: 'test',
    ZAI_API_KEY: 'test',
    OPENROUTER_API_KEY: 'test',
    LANGFUSE_PUBLIC_KEY: 'test',
    LANGFUSE_SECRET_KEY: 'test',
    CIRCUIT_BREAKER: {} as any,
    ENVIRONMENT: 'test'
  };

  it('should route to Z.ai for glm models', () => {
    const route = determineProvider('glm-4-plus', mockClient, mockEnv);
    expect(route.provider).toBe('z-ai-pro');
    expect(route.url).toContain('bigmodel.cn');
  });

  it('should route to Anthropic for claude models with credits', () => {
    const envWithCredits = { ...mockEnv, CREDITS_ANTHROPIC: 'true' };
    const route = determineProvider('claude-3-5-sonnet', mockClient, envWithCredits);
    expect(route.provider).toBe('anthropic-direct');
    expect(route.url).toContain('anthropic.com');
  });

  it('should route to OpenAI for gpt models with credits', () => {
    const envWithCredits = { ...mockEnv, CREDITS_OPENAI: 'true' };
    const route = determineProvider('gpt-4o', mockClient, envWithCredits);
    expect(route.provider).toBe('openai-direct');
    expect(route.url).toContain('openai.com');
  });

  it('should fallback to OpenRouter when credits exhausted', () => {
    const route = determineProvider('claude-3-5-sonnet', mockClient, mockEnv);
    expect(route.provider).toBe('openrouter');
    expect(route.url).toContain('openrouter.ai');
  });

  it('should fail-fast when fallback strategy is fail-fast', () => {
    const failFastClient = { ...mockClient, fallbackStrategy: 'fail-fast' as const };
    expect(() => {
      determineProvider('claude-3-5-sonnet', failFastClient, mockEnv);
    }).toThrow('Payment Required');
  });

  it('should use default model when model is not specified', () => {
    const envWithCredits = { ...mockEnv, CREDITS_OPENAI: 'true' };
    // @ts-expect-error - Testing with undefined model
    const route = determineProvider(undefined, mockClient, envWithCredits);
    expect(route.provider).toBe('openai-direct');
  });
});
