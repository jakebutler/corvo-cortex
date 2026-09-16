/**
 * Streaming utilities for LLM responses
 */

interface UsageInfo {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface StreamingUsageOptions {
  onUsage?: (usage: UsageInfo) => void | Promise<void>;
  onChunk?: (chunk: string) => void | Promise<void>;
  onDone?: () => void | Promise<void>;
  onCancel?: () => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
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
  let doneNotified = false;
  let cancelled = false;

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
            if (!cancelled) await notifyDone();
            break;
          }

          if (cancelled) break;

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

          if (!cancelled) {
            controller.enqueue(value);
          }
        }
        if (!cancelled) {
          controller.close();
        }
      } catch (error) {
        if (!cancelled) {
          await options.onError?.(error);
          controller.error(error);
        }
      }
    },
    async cancel() {
      cancelled = true;
      try {
        await reader.cancel();
      } catch {
        // upstream already gone
      }
      await options.onCancel?.();
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
