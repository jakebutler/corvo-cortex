import type { ProviderAdapter, ChatCompletionRequest, ChatCompletionResponse } from './base';

/**
 * Anthropic Messages API adapter
 * Converts between OpenAI ChatCompletion format and Anthropic Messages format
 */
export class AnthropicAdapter implements ProviderAdapter {
  /**
   * Convert OpenAI request to Anthropic Messages format
   */
  transformRequest(request: ChatCompletionRequest): Record<string, unknown> {
    // Extract system message if present
    const systemMessage = request.messages.find(m => m.role === 'system');
    const system = systemMessage?.content || '';

    // Filter out system message from messages array
    const messages = request.messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role,
        content: m.content
      }));

    return {
      model: request.model,
      messages,
      system,
      max_tokens: request.max_tokens || 4096,
      temperature: request.temperature,
      stream: request.stream || false,
      top_p: request.top_p
    };
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
   * Transform Anthropic streaming event to OpenAI SSE format
   */
  transformStreamChunk(chunk: string, model: string): string {
    try {
      const event = JSON.parse(chunk);

      if (event.type === 'content_block_delta') {
        const delta = event.delta?.text || '';
        const openaiChunk = {
          id: event.message_id || 'chatcmpl-' + Date.now(),
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            delta: { content: delta },
            finish_reason: null
          }]
        };
        return `data: ${JSON.stringify(openaiChunk)}\n\n`;
      }

      if (event.type === 'message_stop') {
        const openaiChunk = {
          id: event.message_id || 'chatcmpl-' + Date.now(),
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: 'stop'
          }]
        };
        return `data: ${JSON.stringify(openaiChunk)}\n\ndata: [DONE]\n\n`;
      }

      return '';
    } catch {
      // Return raw chunk if parsing fails
      return chunk;
    }
  }

  private mapStopReason(reason: string): string {
    const mapping: Record<string, string> = {
      'end_turn': 'stop',
      'max_tokens': 'length',
      'stop_sequence': 'stop',
      'tool_use': 'stop'
    };
    return mapping[reason] || 'stop';
  }
}

export const anthropicAdapter = new AnthropicAdapter();
