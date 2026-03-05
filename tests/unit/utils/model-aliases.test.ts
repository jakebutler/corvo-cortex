import { describe, it, expect } from 'vitest';
import { resolveModelAlias } from '../../../src/utils/model-aliases';

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
      expect(resolveModelAlias('claude-3-5-haiku-20241022')).toBe('claude-haiku-4-5-20251001');
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

    it('maps gpt-4o and gpt-4 variants to gpt-5-2', () => {
      expect(resolveModelAlias('gpt-4o')).toBe('gpt-5-2');
      expect(resolveModelAlias('gpt-4o-2024-11-20')).toBe('gpt-5-2');
      expect(resolveModelAlias('gpt-4-turbo')).toBe('gpt-5-2');
      expect(resolveModelAlias('gpt-4')).toBe('gpt-5-2');
    });

    it('maps gpt-3.5 variants to gpt-5-mini', () => {
      expect(resolveModelAlias('gpt-3.5-turbo')).toBe('gpt-5-mini');
      expect(resolveModelAlias('gpt-3.5-turbo-0125')).toBe('gpt-5-mini');
    });

    it('passes through current gpt-5 models unchanged', () => {
      expect(resolveModelAlias('gpt-5-2')).toBe('gpt-5-2');
      expect(resolveModelAlias('gpt-5-mini')).toBe('gpt-5-mini');
    });
  });

  describe('GLM / Z.ai', () => {
    it('maps glm-4 variants to glm-5', () => {
      expect(resolveModelAlias('glm-4')).toBe('glm-5');
      expect(resolveModelAlias('glm-4-plus')).toBe('glm-5');
      expect(resolveModelAlias('glm-4.6')).toBe('glm-5');
    });

    it('passes through glm-5 unchanged', () => {
      expect(resolveModelAlias('glm-5')).toBe('glm-5');
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
      expect(resolveModelAlias('GPT-4O')).toBe('gpt-5-2');
      expect(resolveModelAlias('GLM-4-Plus')).toBe('glm-5');
    });
  });
});
