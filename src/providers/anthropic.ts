import type { ProviderAdapter, ChatCompletionRequest, ChatCompletionResponse, ChatMessage, StreamEventData } from './base';

/**
 * Anthropic Messages API adapter
 * Converts between OpenAI ChatCompletion format and Anthropic Messages format
 */
export class AnthropicAdapter implements ProviderAdapter {
  readonly wireFormat = 'anthropic' as const;

  /**
   * Convert OpenAI request to Anthropic Messages format
   */
  transformRequest(request: ChatCompletionRequest): Record<string, unknown> {
    // Anthropic takes system as a top-level string; join all system messages
    const system = request.messages
      .filter(m => m.role === 'system')
      .map(m => messageContentToText(m.content))
      .filter(text => text.length > 0)
      .join('\n\n');

    // Filter out system messages from messages array
    const messages = request.messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role,
        content: messageContentToText(m.content)
      }));

    const payload: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.max_tokens || 4096,
      stream: request.stream || false
    };

    if (system.length > 0) {
      payload.system = system;
    }
    if (request.temperature !== undefined) {
      payload.temperature = request.temperature;
    }
    if (request.top_p !== undefined) {
      payload.top_p = request.top_p;
    }

    return payload;
  }

  /**
   * Convert Anthropic response to OpenAI format
   */
  transformResponse(response: unknown, model: string): ChatCompletionResponse {
    const anthropicResp = response as {
      id: string;
      type: string;
      role: string;
      content: Array<{ type: string; text: string }>;
      stop_reason: string;
      usage: { input_tokens: number; output_tokens: number };
    };

    const content = anthropicResp.content
      .filter((c: { type: string }) => c.type === 'text')
      .map((c: { text: string }) => c.text)
      .join('');

    return {
      id: anthropicResp.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content
        },
        finish_reason: this.mapStopReason(anthropicResp.stop_reason)
      }],
      usage: {
        prompt_tokens: anthropicResp.usage.input_tokens,
        completion_tokens: anthropicResp.usage.output_tokens,
        total_tokens: anthropicResp.usage.input_tokens + anthropicResp.usage.output_tokens
      }
    };
  }

  /**
   * Interpret one Anthropic SSE `data:` payload
   */
  transformStreamData(data: string): StreamEventData | null {
    let event: {
      type?: string;
      message_id?: string;
      delta?: { text?: string };
      message?: { usage?: { input_tokens?: number } };
      usage?: { output_tokens?: number };
    };
    try {
      event = JSON.parse(data);
    } catch {
      return null;
    }

    if (event.type === 'content_block_delta') {
      return { text: event.delta?.text || '' };
    }

    if (event.type === 'message_start') {
      const inputTokens = event.message?.usage?.input_tokens;
      return inputTokens ? { usage: { prompt_tokens: inputTokens } } : null;
    }

    if (event.type === 'message_delta') {
      const outputTokens = event.usage?.output_tokens;
      return outputTokens ? { usage: { completion_tokens: outputTokens } } : null;
    }

    if (event.type === 'message_stop') {
      return { done: true };
    }

    return null;
  }

  /**
   * Surface unsupported features instead of silently dropping them
   */
  validateRequest(request: ChatCompletionRequest): string[] {
    const problems: string[] = [];

    for (const message of request.messages) {
      if (message.role === 'tool') {
        problems.push("role 'tool' messages are not supported by the Anthropic Messages adapter");
      }
      if (Array.isArray(message.content)) {
        const hasImage = message.content.some(part => part?.type === 'image_url');
        if (hasImage) {
          problems.push('image inputs are not supported by the Anthropic Messages adapter');
        }
      }
    }

    if (Array.isArray(request.tools) && request.tools.length > 0) {
      problems.push('tool definitions are not supported by the Anthropic Messages adapter');
    }

    return problems;
  }

  private mapStopReason(reason: string): string {
    // Use switch to avoid dynamic object access (security rule)
    switch (reason) {
      case 'end_turn':
      case 'stop_sequence':
      case 'tool_use':
        return 'stop';
      case 'max_tokens':
        return 'length';
      default:
        return 'stop';
    }
  }
}

function messageContentToText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(part => part?.type === 'text' && typeof part.text === 'string')
      .map(part => part.text)
      .join(' ');
  }
  return '';
}

export const anthropicAdapter = new AnthropicAdapter();
