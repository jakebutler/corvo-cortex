import { describe, it, expect } from 'vitest';
import { resolveModelAlias, resolveModelAliasFromEnv, DEFAULT_MODEL_ALIASES, MODEL_ALIASES_CONFIG_KEY } from '../../../src/utils/model-aliases';
import { createMockKV } from '../../mocks/env';

describe('resolveModelAlias', () => {
  describe('Claude', () => {
    it('maps claude-3-opus variants to claude-opus-4-6', () => {
      expect(resolveModelAlias('claude-3-opus')).toBe('claude-opus-4-6');
      expect(resolveModelAlias('claude-3-opus-20240229')).toBe('claude-opus-4-6');
    });

    it('maps claude-3-sonnet variants to claude-sonnet-4-6', () => {
      expect(resolveModelAlias('claude-3-sonnet-20240229')).toBe('claude-sonnet-4-6');
      expect(resolveModelAlias('claude-3-5-sonnet')).toBe('claude-sonnet-4-6');
      expect(resolveModelAlias('claude-3-5-sonnet-20241022')).toBe('claude-sonnet-4-6');
      expect(resolveModelAlias('claude-3-7-sonnet-20250219')).toBe('claude-sonnet-4-6');
    });

    it('maps claude-3-haiku variants to claude-haiku-4-5-20251001', () => {
      expect(resolveModelAlias('claude-3-haiku')).toBe('claude-haiku-4-5-20251001');
      expect(resolveModelAlias('claude-3-haiku-20240307')).toBe('claude-haiku-4-5-20251001');
      expect(resolveModelAlias('claude-3-5-haiku')).toBe('claude-haiku-4-5-20251001');
    });

    it('passes through current claude-4 models unchanged', () => {
      expect(resolveModelAlias('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
      expect(resolveModelAlias('claude-opus-4-6')).toBe('claude-opus-4-6');
      expect(resolveModelAlias('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001');
    });
  });

  describe('OpenAI', () => {
    it('maps gpt-4o-mini variants to gpt-5-mini', () => {
      expect(resolveModelAlias('gpt-4o-mini')).toBe('gpt-5-mini');
      expect(resolveModelAlias('gpt-4o-mini-2024-07-18')).toBe('gpt-5-mini');
    });

    it('maps gpt-4o and gpt-4 variants to gpt-5.2 (catalog-verified id)', () => {
      expect(resolveModelAlias('gpt-4o')).toBe('gpt-5.2');
      expect(resolveModelAlias('gpt-4o-2024-11-20')).toBe('gpt-5.2');
      expect(resolveModelAlias('gpt-4-turbo')).toBe('gpt-5.2');
      expect(resolveModelAlias('gpt-4')).toBe('gpt-5.2');
    });

    it('maps gpt-3.5 variants to gpt-5-mini', () => {
      expect(resolveModelAlias('gpt-3.5-turbo')).toBe('gpt-5-mini');
      expect(resolveModelAlias('gpt-3.5-turbo-0125')).toBe('gpt-5-mini');
    });

    it('passes through current gpt-5 models unchanged', () => {
      expect(resolveModelAlias('gpt-5.2')).toBe('gpt-5.2');
      expect(resolveModelAlias('gpt-5-mini')).toBe('gpt-5-mini');
    });
  });

  describe('GLM / Z.ai', () => {
    it('maps glm-4 flagship variants to glm-5.3', () => {
      expect(resolveModelAlias('glm-4-plus')).toBe('glm-5.3');
      expect(resolveModelAlias('glm-4.6')).toBe('glm-5.3');
    });

    it('maps remaining glm-4 variants to glm-5.3-flash (budget tier)', () => {
      expect(resolveModelAlias('glm-4')).toBe('glm-5.3-flash');
      expect(resolveModelAlias('glm-4-flash')).toBe('glm-5.3-flash');
      expect(resolveModelAlias('glm-4-air')).toBe('glm-5.3-flash');
    });

    it('passes through glm-5 models unchanged', () => {
      expect(resolveModelAlias('glm-5')).toBe('glm-5');
      expect(resolveModelAlias('glm-5.3-flash')).toBe('glm-5.3-flash');
    });
  });

  describe('pass-through', () => {
    it('returns unrecognised model names unchanged', () => {
      expect(resolveModelAlias('some-custom-model')).toBe('some-custom-model');
      expect(resolveModelAlias('accounts/fireworks/models/llama-v3p1-8b-instruct')).toBe('accounts/fireworks/models/llama-v3p1-8b-instruct');
      expect(resolveModelAlias('openai/gpt-5')).toBe('openai/gpt-5');
    });

    it('is case-insensitive', () => {
      expect(resolveModelAlias('Claude-3-5-Sonnet')).toBe('claude-sonnet-4-6');
      expect(resolveModelAlias('GPT-4O')).toBe('gpt-5.2');
      expect(resolveModelAlias('GLM-4-Plus')).toBe('glm-5.3');
    });
  });

  describe('KV-configurable aliases', () => {
    it('uses defaults when no KV config exists', async () => {
      const env = { CORTEX_CONFIG: createMockKV() };
      expect(await resolveModelAliasFromEnv('gpt-4o', env)).toBe('gpt-5.2');
    });

    it('honours a KV override without a code change', async () => {
      const env = {
        CORTEX_CONFIG: createMockKV({
          [MODEL_ALIASES_CONFIG_KEY]: [
            { match: '^legacy-model', replacement: 'new-model', note: 'test override' }
          ]
        })
      };

      expect(await resolveModelAliasFromEnv('legacy-model-v2', env)).toBe('new-model');
      expect(await resolveModelAliasFromEnv('gpt-4o', env)).toBe('gpt-4o');
    });

    it('skips invalid KV entries and falls back to defaults when nothing valid remains', async () => {
      const env = {
        CORTEX_CONFIG: createMockKV({
          [MODEL_ALIASES_CONFIG_KEY]: [
            { match: '(', replacement: 'broken' },
            { match: '', replacement: 'empty' },
            { replacement: 'no-match' }
          ]
        })
      };

      expect(await resolveModelAliasFromEnv('gpt-4o', env)).toBe('gpt-5.2');
    });

    it('exposes the built-in table as the documented default', () => {
      expect(DEFAULT_MODEL_ALIASES.length).toBeGreaterThan(0);
      for (const alias of DEFAULT_MODEL_ALIASES) {
        expect(() => new RegExp(alias.match, 'i')).not.toThrow();
        expect(alias.replacement.length).toBeGreaterThan(0);
      }
    });
  });
});
