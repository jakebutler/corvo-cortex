import { describe, it, expect } from 'vitest';
import { chatCompletionRequestSchema } from '../../src/schemas/chat';
import { chatCompletionResponseSchema } from '../../src/schemas/response';

describe('Schema Validation - Integration', () => {
  describe('chatCompletionRequestSchema', () => {
    it('should validate a correct request', () => {
      const validRequest = {
        model: 'gpt-4o',
        messages: [
          { role: 'user', content: 'Hello!' }
        ],
        temperature: 0.7,
        stream: false
      };

      const result = chatCompletionRequestSchema.safeParse(validRequest);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(validRequest);
    });

    it('should reject request with empty messages', () => {
      const invalidRequest = {
        model: 'gpt-4o',
        messages: []
      };

      const result = chatCompletionRequestSchema.safeParse(invalidRequest);

      expect(result.success).toBe(false);
    });

    it('should reject request with invalid temperature', () => {
      const invalidRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello!' }],
        temperature: 3.0 // Above max of 2
      };

      const result = chatCompletionRequestSchema.safeParse(invalidRequest);

      expect(result.success).toBe(false);
    });

    it('should use default values for optional fields', () => {
      const minimalRequest = {
        messages: [{ role: 'user', content: 'Hello!' }]
      };

      const result = chatCompletionRequestSchema.safeParse(minimalRequest);

      expect(result.success).toBe(true);
      expect(result.data.stream).toBe(false); // Default value
    });
  });

  describe('chatCompletionResponseSchema', () => {
    it('should validate a correct response', () => {
      const validResponse = {
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

      const result = chatCompletionResponseSchema.safeParse(validResponse);

      expect(result.success).toBe(true);
    });

    it('should validate a streaming response chunk', () => {
      const streamingChunk = {
        id: 'chatcmpl-123',
        object: 'chat.completion.chunk',
        created: 1234567890,
        model: 'gpt-4o',
        choices: [{
          index: 0,
          delta: {
            content: 'Hello'
          },
          finish_reason: null
        }]
      };

      const result = chatCompletionResponseSchema.safeParse(streamingChunk);

      expect(result.success).toBe(true);
    });
  });
});
