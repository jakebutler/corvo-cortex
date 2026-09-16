/**
 * Base provider interface and types
 */

export interface ChatMessageContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: {
    url: string;
    detail?: string;
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ChatMessageContentPart[] | null;
  [key: string]: unknown;
}

export interface ChatCompletionRequest extends Record<string, unknown> {
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
 * Wire format emitted by the provider's SSE stream.
 * - openai: chunks are OpenAI-compatible and pass through untouched
 * - anthropic: Anthropic Messages events, normalized to OpenAI chunks by transformStreamData
 */
export type StreamWireFormat = 'openai' | 'anthropic';

/**
 * Normalized interpretation of a single provider SSE `data:` payload.
 */
export interface StreamEventData {
  text?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  done?: boolean;
}

/**
 * Provider adapter interface
 */
export interface ProviderAdapter {
  /**
   * Wire format of the provider's streaming response
   */
  readonly wireFormat: StreamWireFormat;

  /**
   * Transform request from OpenAI format to provider-specific format
   */
  transformRequest(request: ChatCompletionRequest): Record<string, unknown>;

  /**
   * Transform response from provider format to OpenAI format
   */
  transformResponse(response: unknown, model: string): ChatCompletionResponse;

  /**
   * Interpret one provider SSE `data:` payload (wireFormat anthropic only).
   * Returns null when the event carries nothing client-visible.
   */
  transformStreamData?(data: string): StreamEventData | null;

  /**
   * Return a list of unsupported-feature problems for the request
   * (empty list = request is servable by this provider)
   */
  validateRequest(request: ChatCompletionRequest): string[];
}
