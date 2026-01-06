# Telemetry

LangFuse integration for request tracking, cost analysis, and monitoring.

---

## Overview

All LLM requests are logged to LangFuse asynchronously. This provides:
- Per-app cost tracking
- Request latency metrics
- Provider usage distribution
- Error rate monitoring

---

## Configuration

Set these secrets via Wrangler:

```bash
wrangler secret put LANGFUSE_PUBLIC_KEY
wrangler secret put LANGFUSE_SECRET_KEY
```

Optional base URL (defaults to `https://cloud.langfuse.com`):

```toml
[vars]
LANGFUSE_BASE_URL = "https://cloud.langfuse.com"
```

---

## What's Tracked

Each request creates a LangFuse trace with:

| Field | Description |
|-------|-------------|
| `name` | `"llm-completion"` |
| `appId` | Client app identifier |
| `provider` | Selected provider (e.g., `anthropic-direct`) |
| `model` | Model used |
| `input` | Request messages |
| `output` | Response data |
| `startTime` | Request start timestamp |
| `endTime` | Response complete timestamp |
| `usage` | Token counts (prompt, completion, total) |

---

## Cost Estimation

The service estimates costs based on provider pricing:

```typescript
// Example pricing (per million tokens)
{
  'anthropic-direct': {
    'claude-3-5-sonnet': { input: 3.0, output: 15.0 }
  },
  'openai-direct': {
    'gpt-4o': { input: 2.5, output: 10.0 }
  }
}
```

Cost data is logged with each request for dashboard analysis.

---

## Dashboard Access

View telemetry at: **https://cloud.langfuse.com**

Key dashboards:
- **Traces** - Individual request details
- **Metrics** - Aggregate statistics
- **Cost** - Spending by app/provider/model
- **Latency** - Response time analysis

---

## Async Logging

Telemetry is logged asynchronously using `waitUntil()` to avoid blocking responses:

```typescript
c.executionCtx.waitUntil((async () => {
  await telemetryService.createTrace({ ... });
})());
```

This ensures telemetry failures don't impact request latency.

---

## Structured Events

Additional structured events are logged:

```typescript
telemetryService.logEvent({
  event: 'llm_request',
  appId: 'kinisi',
  provider: 'anthropic-direct',
  model: 'claude-3-5-sonnet',
  metadata: {
    duration: 1234,
    status: 200,
    cost: 0.0015
  }
});
```

---

## Analytics Endpoints

Admin endpoints for quick access (point to LangFuse):

| Endpoint | Description |
|----------|-------------|
| `GET /analytics/costs` | Cost breakdown info |
| `GET /analytics/metrics` | Available metrics list |
| `GET /analytics/export` | Export instructions |

---

## Implementation

Located in:
- `src/middleware/telemetry.ts` - Request middleware
- `src/services/telemetry.ts` - LangFuse service wrapper

---

## Related

- [spec.md](../spec.md) - Full API documentation
- [Rate Limiting](./rate-limiting.md) - Usage quotas
