import type { ProviderAdapter, ChatCompletionRequest, ChatCompletionResponse } from './base';

/**
 * OpenAI Chat Completions API adapter
 * Pass-through adapter since OpenAI format is the standard
 */
export class OpenAIAdapter implements ProviderAdapter {
  /**
   * OpenAI uses standard format, so minimal transformation needed
   */
  transformRequest(request: ChatCompletionRequest): Record<string, unknown> {
    return { ...request } as Record<string, unknown>;
  }

  /**
   * OpenAI response is already in correct format
   */
  transformResponse(response: unknown, model: string): ChatCompletionResponse {
    return response as ChatCompletionResponse;
  }

  /**
   * OpenAI streaming chunks are already in correct SSE format
   */
  transformStreamChunk(chunk: string, model: string): string {
    // OpenAI SSE chunks are already in the correct format
    // Just ensure proper formatting
    if (chunk.startsWith('data: ')) {
      return chunk + '\n';
    }
    return `data: ${chunk}\n\n`;
  }
}

export const openaiAdapter = new OpenAIAdapter();
