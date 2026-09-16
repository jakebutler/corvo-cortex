import type { ProviderAdapter, ChatCompletionRequest, ChatCompletionResponse } from './base';

/**
 * Z.ai (Zhipu AI / GLM) API adapter
 * Converts between OpenAI ChatCompletion format and GLM API format
 */
export class ZaiAdapter implements ProviderAdapter {
  readonly wireFormat = 'openai' as const;

  /**
   * Convert OpenAI request to GLM API format
   * GLM API is largely compatible with OpenAI format
   */
  transformRequest(request: ChatCompletionRequest): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map(m => ({
        role: m.role,
        content: messageContentToText(m.content)
      })),
      stream: request.stream || false
    };

    if (request.temperature !== undefined) {
      payload.temperature = request.temperature;
    }
    if (request.top_p !== undefined) {
      payload.top_p = request.top_p;
    }
    if (request.max_tokens !== undefined) {
      payload.max_tokens = request.max_tokens;
    }

    return payload;
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
   * Surface unsupported features instead of silently dropping them
   */
  validateRequest(request: ChatCompletionRequest): string[] {
    const problems: string[] = [];

    for (const message of request.messages) {
      if (Array.isArray(message.content)) {
        const hasImage = message.content.some(part => part?.type === 'image_url');
        if (hasImage) {
          problems.push('image inputs are not supported by the Z.ai adapter');
        }
      }
    }

    if (Array.isArray(request.tools) && request.tools.length > 0) {
      problems.push('tool definitions are not supported by the Z.ai adapter');
    }

    return problems;
  }
}

function messageContentToText(content: import('./base').ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(part => part?.type === 'text' && typeof part.text === 'string')
      .map(part => part.text)
      .join(' ');
  }
  return '';
}

export const zaiAdapter = new ZaiAdapter();
