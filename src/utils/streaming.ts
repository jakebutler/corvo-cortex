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

interface StreamingUsageOptions {
  onUsage?: (usage: UsageInfo) => void;
  onDone?: () => void;
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

  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usageReported = false;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          if (value) {
            const chunkText = decoder.decode(value, { stream: true });
            buffer += chunkText;

            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const data = line.slice(6).trim();
              if (!data || data === '[DONE]') {
                if (data === '[DONE]') {
                  options.onDone?.();
                }
                continue;
              }

              if (!usageReported) {
                const usage = extractUsageFromData(data);
                if (usage) {
                  usageReported = true;
                  options.onUsage?.(usage);
                }
              }
            }
          }

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
