import { describe, it, expect } from 'vitest';
import { determineProvider } from '../../src/services/router';
import type { ClientConfig, Env } from '../../src/types';
import { createMockKV, createMockCreditLedger } from '../mocks/env';

describe('determineProvider', () => {
  const mockClient: ClientConfig = {
    appId: 'test-app',
    name: 'Test App',
    defaultModel: 'gpt-5.2',
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
    const route = await determineProvider('gpt-5.2', mockClient, envWithCredits);
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

  it('should not route crafted names to direct providers', async () => {
    const envWithCredits = {
      ...mockEnv,
      CREDITS_OPENAI: 'true',
      CREDITS_ANTHROPIC: 'true'
    } as Env;

    const notClaude = await determineProvider('not-claude', mockClient, envWithCredits);
    expect(notClaude.provider).toBe('openrouter');

    const proxyGpt = await determineProvider('my-gpt-proxy', mockClient, envWithCredits);
    expect(proxyGpt.provider).toBe('openrouter');

    const claudeish = await determineProvider('gerald-claude-thing', mockClient, envWithCredits);
    expect(claudeish.provider).toBe('openrouter');
  });

  it('routes vendor-prefixed openai ids to OpenAI direct with the prefix stripped', async () => {
    const envWithCredits = { ...mockEnv, CREDITS_OPENAI: 'true' };
    const route = await determineProvider('openai/gpt-5', mockClient, envWithCredits);

    expect(route.provider).toBe('openai-direct');
    expect(route.model).toBe('gpt-5');
  });

  it('routes vendor-prefixed anthropic ids to Anthropic direct with the prefix stripped', async () => {
    const envWithCredits = { ...mockEnv, CREDITS_ANTHROPIC: 'true' };
    const route = await determineProvider('anthropic/claude-sonnet-4-6', mockClient, envWithCredits);

    expect(route.provider).toBe('anthropic-direct');
    expect(route.model).toBe('claude-sonnet-4-6');
  });

  it('keeps mismatched or unknown vendor prefixes on OpenRouter verbatim', async () => {
    const envWithCredits = { ...mockEnv, CREDITS_OPENAI: 'true' };

    const mismatched = await determineProvider('anthropic/gpt-5', mockClient, envWithCredits);
    expect(mismatched.provider).toBe('openrouter');
    expect(mismatched.model).toBe('anthropic/gpt-5');

    const unknownVendor = await determineProvider('mistral/mixtral-8x7b', mockClient, envWithCredits);
    expect(unknownVendor.provider).toBe('openrouter');
    expect(unknownVendor.model).toBe('mistral/mixtral-8x7b');
  });

  it('routes without vendor prefixes using the plain name as the wire model', async () => {
    const route = await determineProvider('glm-5', mockClient, mockEnv);
    expect(route.provider).toBe('z-ai-pro');
    expect(route.model).toBe('glm-5');
  });

  describe('DigitalOcean preemption tier (#23)', () => {
    const doEnv = (overrides: Record<string, unknown> = {}) => ({
      ...mockEnv,
      CREDIT_LEDGER: createMockCreditLedger(),
      CREDITS_DIGITALOCEAN: 'true',
      DIGITAL_OCEAN_MODEL_ACCESS_KEY: 'do-key',
      ...overrides
    } as Env);

    it('routes mapped models DO-first when the credit flag is on', async () => {
      const route = await determineProvider('glm-4.7', mockClient, doEnv());

      expect(route.provider).toBe('digitalocean');
      expect(route.url).toBe('https://inference.do-ai.run/v1/chat/completions');
      expect(route.model).toBe('glm-5.3-flash');
    });

    it('does not route DO when the credit flag is off (falls through to Z.ai for glm)', async () => {
      const route = await determineProvider('glm-5.3-flash', mockClient, { ...mockEnv } as Env);

      expect(route.provider).toBe('z-ai-pro');
    });

    it('honours the per-client allowDigitalocean opt-out', async () => {
      const optedOut = { ...mockClient, allowDigitalocean: false };
      const route = await determineProvider('glm-4.7', optedOut, doEnv());

      expect(route.provider).toBe('z-ai-pro');
    });

    it('does not route unmapped models to DO (falls back to OpenRouter)', async () => {
      const route = await determineProvider('gpt-4o', mockClient, doEnv({ CREDITS_OPENAI: undefined }));

      expect(route.provider).toBe('openrouter');
    });

    it('routes DO above Fireworks when both would match (mapped model)', async () => {
      const route = await determineProvider('glm-5.3-flash', mockClient, doEnv());

      expect(route.provider).toBe('digitalocean');
    });
  });
});
