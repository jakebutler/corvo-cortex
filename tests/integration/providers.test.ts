import { describe, it, expect } from 'vitest';
import { anthropicAdapter } from '../../src/providers/anthropic';
import { openaiAdapter } from '../../src/providers/openai';
import { zaiAdapter } from '../../src/providers/zai';
import { openrouterAdapter } from '../../src/providers/openrouter';
import type { ChatCompletionRequest } from '../../src/providers/base';

describe('Provider Adapters - Integration', () => {
  const mockRequest: ChatCompletionRequest = {
    model: 'test-model',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello!' }
    ],
    temperature: 0.7,
    max_tokens: 100
  };

  describe('Anthropic Adapter', () => {
    it('should transform request to Anthropic format', () => {
      const result = anthropicAdapter.transformRequest(mockRequest);

      expect(result).toHaveProperty('model', 'test-model');
      expect(result).toHaveProperty('system', 'You are a helpful assistant.');
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual({
        role: 'user',
        content: 'Hello!'
      });
    });

    it('should transform response from Anthropic format', () => {
      const anthropicResponse = {
        id: 'msg-123',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Hi there!' }
        ],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 10,
          output_tokens: 5
        }
      };

      const result = anthropicAdapter.transformResponse(anthropicResponse, 'claude-3-5-sonnet');

      expect(result.id).toBe('msg-123');
      expect(result.object).toBe('chat.completion');
      expect(result.choices[0].message.content).toBe('Hi there!');
      expect(result.choices[0].finish_reason).toBe('stop');
      expect(result.usage).toEqual({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15
      });
    });
  });

  describe('OpenAI Adapter', () => {
    it('should pass through OpenAI format', () => {
      const result = openaiAdapter.transformRequest(mockRequest);

      expect(result.model).toBe('test-model');
      expect(result.messages).toEqual(mockRequest.messages);
    });

    it('should pass through OpenAI response', () => {
      const openaiResponse = {
        id: 'chatcmpl-123',
        object: 'chat.completion',
        created: 1234567890,
        model: 'gpt-4o',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: 'Hello!'
          },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15
        }
      };

      const result = openaiAdapter.transformResponse(openaiResponse, 'gpt-4o');

      expect(result).toEqual(openaiResponse);
    });
  });

  describe('Z.ai Adapter', () => {
    it('should transform request to GLM format', () => {
      const result = zaiAdapter.transformRequest(mockRequest);

      expect(result).toHaveProperty('model', 'test-model');
      expect(result).toHaveProperty('temperature', 0.7);
      expect(result).toHaveProperty('stream', false);
      expect(result.messages).toEqual(mockRequest.messages);
    });

    it('should transform GLM response to OpenAI format', () => {
      const glmResponse = {
        id: 'glm-123',
        created: 1234567890,
        model: 'glm-4',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: 'Hello from GLM!'
          },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 4,
          total_tokens: 12
        }
      };

      const result = zaiAdapter.transformResponse(glmResponse, 'glm-4');

      expect(result.choices[0].message.content).toBe('Hello from GLM!');
      expect(result.usage.totalTokens).toBe(12);
    });
  });

  describe('OpenRouter Adapter', () => {
    it('should pass through OpenRouter format', () => {
      const result = openrouterAdapter.transformRequest(mockRequest);

      expect(result.model).toBe('test-model');
      expect(result.messages).toEqual(mockRequest.messages);
    });
  });
});
