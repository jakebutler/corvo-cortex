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

    describe('wire formats', () => {
        it('emits anthropic wire format for anthropic-direct and minimax', () => {
            expect(getAdapterForProvider('anthropic-direct').wireFormat).toBe('anthropic');
            expect(getAdapterForProvider('minimax').wireFormat).toBe('anthropic');
        });

        it('emits openai wire format for openai-compatible providers', () => {
            expect(getAdapterForProvider('openai-direct').wireFormat).toBe('openai');
            expect(getAdapterForProvider('openrouter').wireFormat).toBe('openai');
            expect(getAdapterForProvider('z-ai-pro').wireFormat).toBe('openai');
            expect(getAdapterForProvider('fireworks').wireFormat).toBe('openai');
        });
    });

    describe('request semantics (no silent mutation)', () => {
        it('joins multiple system messages for anthropic', () => {
            const result = anthropicAdapter.transformRequest({
                model: 'claude-sonnet-4-6',
                messages: [
                    { role: 'system', content: 'Be terse.' },
                    { role: 'system', content: 'Answer in French.' },
                    { role: 'user', content: 'Hi' }
                ]
            } as any);

            expect(result.system).toBe('Be terse.\n\nAnswer in French.');
            expect((result.messages as unknown[]).length).toBe(1);
        });

        it('omits temperature when the caller did not set it (zai)', () => {
            const result = zaiAdapter.transformRequest({
                model: 'glm-5.3',
                messages: [{ role: 'user', content: 'Hi' }]
            } as any);

            expect(result.temperature).toBeUndefined();
        });

        it('preserves caller temperature (zai)', () => {
            const result = zaiAdapter.transformRequest({
                model: 'glm-5.3',
                temperature: 0.2,
                messages: [{ role: 'user', content: 'Hi' }]
            } as any);

            expect(result.temperature).toBe(0.2);
        });

        it('omits max_tokens when the caller did not set it (zai)', () => {
            const result = zaiAdapter.transformRequest({
                model: 'glm-5.3',
                messages: [{ role: 'user', content: 'Hi' }]
            } as any);

            expect(result.max_tokens).toBeUndefined();
        });

        it('keeps the anthropic max_tokens default (API requires it)', () => {
            const result = anthropicAdapter.transformRequest({
                model: 'claude-sonnet-4-6',
                messages: [{ role: 'user', content: 'Hi' }]
            } as any);

            expect(result.max_tokens).toBe(4096);
        });
    });

    describe('validateRequest (no silent feature loss)', () => {
        it('rejects image inputs for anthropic-family providers', () => {
            const problems = anthropicAdapter.validateRequest({
                model: 'claude-sonnet-4-6',
                messages: [{
                    role: 'user',
                    content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]
                }]
            } as any);

            expect(problems.some((problem) => problem.includes('image inputs'))).toBe(true);
        });

        it('rejects tool definitions and tool-role messages for anthropic-family providers', () => {
            const problems = anthropicAdapter.validateRequest({
                model: 'claude-sonnet-4-6',
                tools: [{ type: 'function', function: { name: 'x' } }],
                messages: [{ role: 'tool', content: 'result' }]
            } as any);

            expect(problems.some((problem) => problem.includes('tool definitions'))).toBe(true);
            expect(problems.some((problem) => problem.includes("role 'tool'"))).toBe(true);
        });

        it('rejects image inputs for zai', () => {
            const problems = zaiAdapter.validateRequest({
                model: 'glm-5.3',
                messages: [{
                    role: 'user',
                    content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }]
                }]
            } as any);

            expect(problems.some((problem) => problem.includes('image inputs'))).toBe(true);
        });

        it('accepts plain text requests everywhere', () => {
            const request = {
                model: 'claude-sonnet-4-6',
                messages: [{ role: 'user', content: 'Hello' }]
            } as any;

            expect(anthropicAdapter.validateRequest(request)).toEqual([]);
            expect(zaiAdapter.validateRequest(request)).toEqual([]);
            expect(openaiAdapter.validateRequest(request)).toEqual([]);
            expect(openrouterAdapter.validateRequest(request)).toEqual([]);
        });
    });
});
