import type { ProviderAdapter, ChatCompletionRequest, ChatCompletionResponse } from './base';

/**
 * OpenRouter API adapter
 * OpenRouter is an OpenAI-compatible aggregator, so transformation is minimal
 */
export class OpenRouterAdapter implements ProviderAdapter {
  readonly wireFormat = 'openai' as const;

  /**
   * OpenRouter uses OpenAI-compatible format
   */
  transformRequest(request: ChatCompletionRequest): Record<string, unknown> {
    return { ...request } as Record<string, unknown>;
  }

  /**
   * OpenRouter response is OpenAI-compatible
   */
  transformResponse(response: unknown, model: string): ChatCompletionResponse {
    const orResp = response as ChatCompletionResponse;
    return {
      ...orResp,
      model // Override model with requested model name
    };
  }

  /**
   * OpenRouter accepts all gateway-supported request features
   */
  validateRequest(_request: ChatCompletionRequest): string[] {
    return [];
  }
}

export const openrouterAdapter = new OpenRouterAdapter();
