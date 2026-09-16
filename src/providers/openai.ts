import type { ProviderAdapter, ChatCompletionRequest, ChatCompletionResponse } from './base';

/**
 * OpenAI Chat Completions API adapter
 * Pass-through adapter since OpenAI format is the standard
 */
export class OpenAIAdapter implements ProviderAdapter {
  readonly wireFormat = 'openai' as const;

  /**
   * OpenAI uses standard format, so minimal transformation needed
   */
  transformRequest(request: ChatCompletionRequest): Record<string, unknown> {
    return { ...request } as Record<string, unknown>;
  }

  /**
   * OpenAI response is already in correct format
   */
  transformResponse(response: unknown, _model: string): ChatCompletionResponse {
    return response as ChatCompletionResponse;
  }

  /**
   * OpenAI accepts all gateway-supported request features
   */
  validateRequest(_request: ChatCompletionRequest): string[] {
    return [];
  }
}

export const openaiAdapter = new OpenAIAdapter();
