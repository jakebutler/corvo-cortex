/**
 * Base provider interface and types
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  top_p?: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion' | 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message?: {
      role: string;
      content: string;
    };
    delta?: {
      role?: string;
      content?: string;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Provider adapter interface
 */
export interface ProviderAdapter {
  /**
   * Transform request from OpenAI format to provider-specific format
   */
  transformRequest(request: ChatCompletionRequest): Record<string, unknown>;

  /**
   * Transform response from provider format to OpenAI format
   */
  transformResponse(response: unknown, model: string): ChatCompletionResponse;

  /**
   * Transform streaming chunk from provider format to OpenAI SSE format
   */
  transformStreamChunk(chunk: string, model: string): string;
}
