# Telemetry

Langfuse integration for request tracing, latency, and cost visibility.

---

## Overview

Corvo Cortex records telemetry for both successful and failed LLM requests.

Tracing is **fail-open**:
- if telemetry fails, API responses still complete normally
- tracing never blocks request handling

---

## Configuration

Set Langfuse secrets:

```bash
wrangler secret put LANGFUSE_PUBLIC_KEY --env production
wrangler secret put LANGFUSE_SECRET_KEY --env production
```

Set base URL (US region):

```toml
[vars]
LANGFUSE_BASE_URL = "https://us.cloud.langfuse.com"
```

If `LANGFUSE_BASE_URL` is missing, Corvo Cortex defaults to `https://us.cloud.langfuse.com` and logs a warning.

---

## Transport

Corvo Cortex uses direct Langfuse ingestion API calls:

- Endpoint: `POST /api/public/ingestion`
- Reason: production Workers reliability

Upstream issue reference (SDK behavior in Workers):
- https://github.com/langfuse/langfuse/issues/11984

---

## What Is Traced

Each request emits:
- 1 trace (`name = "llm-request"`)
- 1 generation child (`name = "provider-call"`)

Captured fields include:
- `appId`
- `provider`
- `model`
- `statusCode`
- `durationMs`
- `error` (for failed requests)
- `input` (full request payload)
- `output` (full response payload)
- `usage` (prompt/completion/total tokens when available)
- `costUsd` (when usage is present and provider/model pricing is available)

---

## Streaming Behavior

For streaming responses:
- usage is captured from SSE chunks when provided
- output is captured from stream chunks
- telemetry finalization waits for stream completion to avoid partial traces

---

## Analytics Endpoints

Current admin analytics routes are pointers to Langfuse dashboard:
- `GET /analytics/costs`
- `GET /analytics/metrics`
- `GET /analytics/export`

Source of truth remains Langfuse dashboard.

---

## Implementation

- `src/middleware/telemetry.ts`
- `src/services/telemetry.ts`
- `src/routes/chat.ts`
- `src/routes/responses.ts`
- `src/utils/streaming.ts`

---

## Dashboard

Langfuse US: **https://us.cloud.langfuse.com**

