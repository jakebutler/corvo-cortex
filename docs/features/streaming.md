# Streaming

Real-time SSE streaming support for all LLM providers.

---

## Overview

Streaming allows clients to receive partial responses in real-time as the LLM generates content. Corvo Cortex normalizes all provider streaming formats to OpenAI-compatible SSE.

---

## Enabling Streaming

Set `stream: true` in your request:

```json
{
  "model": "gpt-4o",
  "messages": [{ "role": "user", "content": "Hello!" }],
  "stream": true
}
```

---

## Response Format

Streaming responses use Server-Sent Events (SSE):

```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1704567890,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1704567890,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"!"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1704567890,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

### Response Headers

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

---

## Provider Transformations

Each provider has a streaming adapter that normalizes their format:

### OpenAI / OpenRouter

Pass-through (already OpenAI format).

### Anthropic

Transforms Anthropic streaming events:

| Anthropic Event | OpenAI Chunk |
|-----------------|--------------|
| `content_block_delta` | `delta.content` |
| `message_stop` | `finish_reason: "stop"` |

### Z.ai (GLM)

Similar to OpenAI format, minimal transformation needed.

---

## Client Integration

### JavaScript/TypeScript

```typescript
const response = await fetch('/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Hello!' }],
    stream: true
  })
});

const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  
  const chunk = decoder.decode(value);
  // Parse SSE data lines
  for (const line of chunk.split('\n')) {
    if (line.startsWith('data: ') && line !== 'data: [DONE]') {
      const data = JSON.parse(line.slice(6));
      console.log(data.choices[0]?.delta?.content || '');
    }
  }
}
```

---

## Implementation

Located in `src/utils/streaming.ts`:

```typescript
export function createStreamingResponse(response: Response): Response {
  return new Response(response.body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    }
  });
}
```

Provider-specific transformations are in `src/providers/*.ts`.

---

## Notes

- Streaming responses do **not** include usage statistics
- Telemetry logging is limited for streaming requests
- Rate limiting still applies to streaming requests

---

## Related

- [Provider Routing](./provider-routing.md) - How providers are selected
- [spec.md](../spec.md) - Full API documentation
