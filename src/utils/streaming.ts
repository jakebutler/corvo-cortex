/**
 * Streaming utilities for LLM responses
 */

/**
 * Creates a streaming response from an upstream fetch response
 * Handles Server-Sent Events (SSE) format
 */
export async function createStreamingResponse(upstreamResponse: Response): Promise<Response> {
  if (!upstreamResponse.body) {
    return new Response('No response body', { status: 500 });
  }

  const reader = upstreamResponse.body.getReader();
  const _decoder = new TextDecoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no' // Disable nginx buffering
    }
  });
}

interface UsageInfo {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface StreamEventData {
  text?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  done?: boolean;
}

interface StreamingUsageOptions {
  onUsage?: (usage: UsageInfo) => void | Promise<void>;
  onChunk?: (chunk: string) => void | Promise<void>;
  onDone?: () => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
  /**
   * Model name stamped into normalized OpenAI chunk envelopes
   */
  streamModel?: string;
  /**
   * When provided, provider SSE `data:` payloads are interpreted and re-emitted
   * as OpenAI-format chunks (non-OpenAI wire formats, e.g. Anthropic).
   * When omitted, upstream bytes pass through untouched.
   */
  transformStreamData?: (data: string) => StreamEventData | null;
}

/**
 * Creates a streaming response while tapping SSE chunks for usage data.
 */
export async function createStreamingResponseWithUsage(
  upstreamResponse: Response,
  options: StreamingUsageOptions = {}
): Promise<Response> {
  if (!upstreamResponse.body) {
    return new Response('No response body', { status: 500 });
  }

  if (options.transformStreamData) {
    return createNormalizedStreamResponse(upstreamResponse, options);
  }
  return createPassthroughStreamResponse(upstreamResponse, options);
}

async function createPassthroughStreamResponse(
  upstreamResponse: Response,
  options: StreamingUsageOptions
): Promise<Response> {
  const reader = upstreamResponse.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usageReported = false;
  let doneNotified = false;

  const stream = new ReadableStream({
    async start(controller) {
      const notifyDone = async () => {
        if (doneNotified) return;
        doneNotified = true;
        await options.onDone?.();
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            await notifyDone();
            break;
          }

          if (value) {
            const chunkText = decoder.decode(value, { stream: true });
            buffer += chunkText;
            await options.onChunk?.(chunkText);

            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const data = line.slice(6).trim();
              if (!data || data === '[DONE]') {
                if (data === '[DONE]') {
                  await notifyDone();
                }
                continue;
              }

              if (!usageReported) {
                const usage = extractUsageFromData(data);
                if (usage) {
                  usageReported = true;
                  await options.onUsage?.(usage);
                }
              }
            }
          }

          controller.enqueue(value);
        }
        controller.close();
      } catch (error) {
        await options.onError?.(error);
        controller.error(error);
      }
    }
  });

  return streamResponse(stream);
}

async function createNormalizedStreamResponse(
  upstreamResponse: Response,
  options: StreamingUsageOptions
): Promise<Response> {
  const transformStreamData = options.transformStreamData!;
  const reader = upstreamResponse.body!.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  const usage: UsageInfo = {};
  let doneNotified = false;

  const mergeUsage = (update: UsageInfo): boolean => {
    let changed = false;
    if (update.prompt_tokens !== undefined && usage.prompt_tokens !== update.prompt_tokens) {
      usage.prompt_tokens = update.prompt_tokens;
      changed = true;
    }
    if (update.completion_tokens !== undefined && usage.completion_tokens !== update.completion_tokens) {
      usage.completion_tokens = update.completion_tokens;
      changed = true;
    }
    if (update.total_tokens !== undefined) {
      usage.total_tokens = update.total_tokens;
      changed = true;
    }
    return changed;
  };

  const openaiChunkSse = (delta: { content?: string }, finishReason: string | null): Uint8Array => {
    const chunk = {
      id: `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: options.streamModel || 'unknown',
      choices: [{
        index: 0,
        delta,
        finish_reason: finishReason
      }]
    };
    return encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  const stream = new ReadableStream({
    async start(controller) {
      const notifyDone = async () => {
        if (doneNotified) return;
        doneNotified = true;
        await options.onDone?.();
      };

      const handleLine = async (line: string): Promise<void> => {
        if (!line.startsWith('data: ')) return;
        const data = line.slice(6).trim();
        if (!data) return;
        if (data === '[DONE]') {
          await notifyDone();
          return;
        }

        let event: StreamEventData | null = null;
        try {
          event = transformStreamData(data);
        } catch {
          event = null;
        }
        if (!event) return;

        if (event.text !== undefined && event.text !== '') {
          await options.onChunk?.(event.text);
          controller.enqueue(openaiChunkSse({ content: event.text }, null));
        }

        if (event.usage) {
          const changed = mergeUsage(event.usage);
          if (changed && usage.prompt_tokens !== undefined && usage.completion_tokens !== undefined) {
            usage.total_tokens = usage.total_tokens
              ?? usage.prompt_tokens + usage.completion_tokens;
            await options.onUsage?.({ ...usage });
          }
        }

        if (event.done) {
          controller.enqueue(openaiChunkSse({}, 'stop'));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          if (usage.prompt_tokens !== undefined || usage.completion_tokens !== undefined) {
            await options.onUsage?.({ ...usage });
          }
          await notifyDone();
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            await notifyDone();
            break;
          }

          if (value) {
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              await handleLine(line);
            }
          }
        }
        controller.close();
      } catch (error) {
        await options.onError?.(error);
        controller.error(error);
      }
    }
  });

  return streamResponse(stream);
}

function streamResponse(stream: ReadableStream): Response {
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    }
  });
}

function extractUsageFromData(data: string): UsageInfo | null {
  try {
    const parsed = JSON.parse(data) as { usage?: UsageInfo } | null;
    if (parsed?.usage && typeof parsed.usage === 'object') {
      return parsed.usage;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Checks if a response is a streaming response
 */
export function isStreamingResponse(headers: Headers): boolean {
  const contentType = headers.get('content-type') || '';
  return contentType.includes('text/event-stream') || contentType.includes('application/x-ndjson');
}

/**
 * Parses SSE chunk to extract data
 */
export function parseSSEChunk(chunk: string): string[] {
  const lines = chunk.split('\n');
  const events: string[] = [];

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const data = line.slice(6);
      if (data !== '[DONE]') {
        events.push(data);
      }
    }
  }

  return events;
}
