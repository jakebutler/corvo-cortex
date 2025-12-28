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
  const decoder = new TextDecoder();

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
