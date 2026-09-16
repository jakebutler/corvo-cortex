import { describe, it, expect } from 'vitest';
import { isModelAllowedForClient } from '../../../src/services/model-authorization';
import { createMockClientConfig } from '../../mocks/env';

describe('isModelAllowedForClient', () => {
    it('allows all models when allowedModels is undefined (legacy records)', () => {
        const client = createMockClientConfig();
        expect(client.allowedModels).toBeUndefined();
        expect(isModelAllowedForClient(client, 'gpt-4o')).toBe(true);
        expect(isModelAllowedForClient(client, 'any-model-at-all')).toBe(true);
    });

    it('denies all models when allowedModels is empty', () => {
        const client = createMockClientConfig({ allowedModels: [] });
        expect(isModelAllowedForClient(client, 'gpt-4o')).toBe(false);
    });

    it('allows all models with the * wildcard', () => {
        const client = createMockClientConfig({ allowedModels: ['*'] });
        expect(isModelAllowedForClient(client, 'gpt-4o')).toBe(true);
        expect(isModelAllowedForClient(client, 'claude-3-5-sonnet')).toBe(true);
    });

    it('matches exact model ids', () => {
        const client = createMockClientConfig({ allowedModels: ['gpt-4o', 'claude-3-5-sonnet'] });
        expect(isModelAllowedForClient(client, 'gpt-4o')).toBe(true);
        expect(isModelAllowedForClient(client, 'claude-3-5-sonnet')).toBe(true);
        expect(isModelAllowedForClient(client, 'gpt-4o-mini')).toBe(false);
    });

    it('matches trailing-* prefix globs', () => {
        const client = createMockClientConfig({ allowedModels: ['glm*', 'gpt-4o'] });
        expect(isModelAllowedForClient(client, 'glm-4-plus')).toBe(true);
        expect(isModelAllowedForClient(client, 'glm-4-flash')).toBe(true);
        expect(isModelAllowedForClient(client, 'gpt-4o')).toBe(true);
        expect(isModelAllowedForClient(client, 'claude-3-5-sonnet')).toBe(false);
    });
});
