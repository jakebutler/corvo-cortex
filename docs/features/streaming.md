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

Every provider stream is served to clients as OpenAI-compatible SSE:

### OpenAI / OpenRouter / Fireworks / Z.ai (GLM)

Pass-through (already OpenAI-compatible wire format; bytes forwarded untouched).

### Anthropic / MiniMax (Anthropic Messages wire format)

The gateway interprets Anthropic SSE events and re-emits normalized OpenAI chunks:

| Anthropic Event | OpenAI Chunk |
|-----------------|--------------|
| `content_block_delta` | `delta.content` |
| `message_start` | usage tapped (`prompt_tokens`) |
| `message_delta` | usage tapped (`completion_tokens`) |
| `message_stop` | `finish_reason: "stop"` + `data: [DONE]` |

Usage tapped from normalized streams feeds the credit ledger (reserve-then-settle), so streamed Anthropic-family calls are metered the same way as OpenAI-format streams.

---

## Unsupported Feature Handling

Providers that cannot serve a requested feature return a **400** with an explicit `details` list instead of silently degrading the request:

| Feature | OpenAI / OpenRouter / Fireworks | Anthropic / MiniMax | Z.ai |
|---|---|---|---|
| Image inputs (`image_url` parts) | supported | 400 | 400 |
| Tools (`tools`, `role: 'tool'`) | supported | 400 | 400 |

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

- Usage statistics are captured from SSE chunks when the provider emits them (OpenAI-format `usage` field; Anthropic-family `message_start`/`message_delta` events) and feed credit metering
- Streaming telemetry waits for stream completion before final trace ingestion
- Rate limiting is **disabled** on request-serving routes (see [Rate Limiting](./rate-limiting.md)); spend is bounded by the guardrails in [Spend Guardrails](./spend-guardrails.md) and the credit ledger
- Client disconnects cancel the upstream request and release concurrency leases

---

## Related

- [Provider Routing](./provider-routing.md) - How providers are selected
- [spec.md](../spec.md) - Full API documentation
