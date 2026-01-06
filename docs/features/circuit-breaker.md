# Circuit Breaker

Prevents cascading failures by tracking provider health.

---

## Overview

The circuit breaker pattern protects the system when a provider starts failing. It's implemented as a Cloudflare Durable Object for persistent state across requests.

---

## States

```
     ┌─────────┐
     │  CLOSED │ ← Normal operation
     └────┬────┘
          │ (5 consecutive failures)
          ▼
     ┌─────────┐
     │   OPEN  │ ← Fast-fail mode (60s)
     └────┬────┘
          │ (timeout expires)
          ▼
     ┌─────────┐
     │HALF-OPEN│ ← Test recovery
     └────┬────┘
          │
    ┌─────┴─────┐
    ▼           ▼
 Success     Failure
    │           │
    ▼           ▼
 CLOSED       OPEN
```

| State | Behavior |
|-------|----------|
| **CLOSED** | Normal operation, requests pass through |
| **OPEN** | Provider failing, return 503 immediately |
| **HALF-OPEN** | Testing recovery, allow limited requests |

---

## Configuration

| Parameter | Value | Description |
|-----------|-------|-------------|
| `failureThreshold` | 5 | Failures before opening circuit |
| `openTimeout` | 60000ms | Time before testing recovery |
| `halfOpenMaxCalls` | 1 | Test requests in half-open state |

---

## API

The circuit breaker Durable Object exposes internal endpoints:

| Path | Method | Description |
|------|--------|-------------|
| `/check` | POST | Check if request should proceed |
| `/recordSuccess` | POST | Record successful request |
| `/recordFailure` | POST | Record failed request |
| `/reset` | POST | Manually reset circuit |
| `/status` | GET | Get all circuit states |

---

## Admin Endpoints

### Check Provider Status

```bash
curl -H "Authorization: Bearer $ADMIN_KEY" \
  https://cortex.corvolabs.com/health/providers
```

Response:
```json
{
  "breakers": [
    {
      "provider": "anthropic-direct",
      "state": "closed",
      "failureCount": 0,
      "lastFailureTime": null
    }
  ]
}
```

### Reset Circuit

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_KEY" \
  https://cortex.corvolabs.com/health/reset/anthropic-direct
```

---

## Error Response

When circuit is open:

```json
{
  "error": "Service temporarily unavailable",
  "reason": "Circuit breaker is open",
  "provider": "anthropic-direct"
}
```

HTTP Status: `503 Service Unavailable`

---

## Implementation

Located in `src/durable-objects/circuit-breaker.ts`.

State is persisted to Durable Object storage for recovery across restarts:

```typescript
this.state.storage.put(`breaker:${provider}`, data);
```

---

## Related

- [Provider Routing](./provider-routing.md) - How providers are selected
- [spec.md](../spec.md) - Full API documentation
