import type { ProviderAdapter, ChatCompletionRequest, ChatCompletionResponse } from './base';

/**
 * Z.ai (Zhipu AI / GLM) API adapter
 * Converts between OpenAI ChatCompletion format and GLM API format
 */
export class ZaiAdapter implements ProviderAdapter {
  /**
   * Convert OpenAI request to GLM API format
   * GLM API is largely compatible with OpenAI format
   */
  transformRequest(request: ChatCompletionRequest): Record<string, unknown> {
    return {
      model: request.model,
      messages: request.messages.map(m => ({
        role: m.role,
        content: m.content
      })),
      temperature: request.temperature ?? 0.7,
      top_p: request.top_p,
      max_tokens: request.max_tokens || 4096,
      stream: request.stream || false
    };
  }

  /**
   * Convert GLM response to OpenAI format
   * GLM response structure is similar to OpenAI
   */
  transformResponse(response: unknown, model: string): ChatCompletionResponse {
    const glmResp = response as {
      id: string;
      created: number;
      model: string;
      choices: Array<{
        index: number;
        message: { role: string; content: string };
        finish_reason: string;
      }>;
      usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    };

    return {
      id: glmResp.id,
      object: 'chat.completion',
      created: glmResp.created,
      model,
      choices: glmResp.choices.map(c => ({
        index: c.index,
        message: {
          role: c.message.role,
          content: c.message.content
        },
        finish_reason: c.finish_reason
      })),
      usage: {
        prompt_tokens: glmResp.usage.prompt_tokens,
        completion_tokens: glmResp.usage.completion_tokens,
        total_tokens: glmResp.usage.total_tokens
      }
    };
  }

  /**
   * Transform GLM streaming chunk to OpenAI SSE format
   * GLM SSE format is compatible with OpenAI
   */
  transformStreamChunk(chunk: string, model: string): string {
    try {
      const event = JSON.parse(chunk);

      // GLM streaming format is similar to OpenAI
      const openaiChunk = {
        id: event.id || `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: event.created || Math.floor(Date.now() / 1000),
        model,
        choices: event.choices?.map((c: unknown) => c) || [{
          index: 0,
          delta: event.delta || {},
          finish_reason: event.finish_reason || null
        }]
      };

      return `data: ${JSON.stringify(openaiChunk)}\n\n`;
    } catch {
      // Return raw chunk if parsing fails
      return chunk;
    }
  }
}

export const zaiAdapter = new ZaiAdapter();
