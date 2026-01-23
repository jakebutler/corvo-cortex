import type { ProviderAdapter, ChatCompletionRequest, ChatCompletionResponse } from './base';

/**
 * OpenRouter API adapter
 * OpenRouter is an OpenAI-compatible aggregator, so transformation is minimal
 */
export class OpenRouterAdapter implements ProviderAdapter {
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
   * OpenRouter SSE chunks are OpenAI-compatible
   */
  transformStreamChunk(chunk: string, _model: string): string {
    // OpenRouter SSE format is compatible with OpenAI
    // Just return as-is
    if (chunk.startsWith('data: ')) {
      return chunk + '\n';
    }
    return `data: ${chunk}\n\n`;
  }
}

export const openrouterAdapter = new OpenRouterAdapter();
