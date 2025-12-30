import { describe, it, expect } from 'vitest';
import { getAdapterForProvider } from '../../../src/utils/transform';
import { anthropicAdapter } from '../../../src/providers/anthropic';
import { openaiAdapter } from '../../../src/providers/openai';
import { zaiAdapter } from '../../../src/providers/zai';
import { openrouterAdapter } from '../../../src/providers/openrouter';

describe('Transform Utility', () => {
    describe('getAdapterForProvider', () => {
        it('should return anthropic adapter', () => {
            const adapter = getAdapterForProvider('anthropic-direct');
            expect(adapter).toBe(anthropicAdapter);
        });

        it('should return openai adapter', () => {
            const adapter = getAdapterForProvider('openai-direct');
            expect(adapter).toBe(openaiAdapter);
        });

        it('should return zai adapter', () => {
            const adapter = getAdapterForProvider('z-ai-pro');
            expect(adapter).toBe(zaiAdapter);
        });

        it('should return openrouter adapter', () => {
            const adapter = getAdapterForProvider('openrouter');
            expect(adapter).toBe(openrouterAdapter);
        });

        it('should return openai adapter as default for unknown provider', () => {
            const adapter = getAdapterForProvider('unknown' as any);
            expect(adapter).toBe(openaiAdapter);
        });
    });
});
