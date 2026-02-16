# Rate Limiting

Per-client rate limiting system with request and token quotas.

---

## Overview

Rate limiting is implemented per API key with two quota types:
- **Requests per minute** - Number of API calls
- **Tokens per minute** - Estimated token usage

> [!IMPORTANT]
> As of February 15, 2026, rate-limit middleware is not mounted on request-serving routes (`POST /v1/chat/completions` and `POST /v1/responses`) to reduce Cloudflare KV hot-path writes on free tier.
>
> The middleware and data model remain in the codebase for future re-enable.

When enabled, quotas are stored in KV with automatic expiration.

---

## Configuration

Each client has rate limit settings in their `ClientConfig`:

```json
{
  "appId": "myapp",
  "rateLimit": {
    "requestsPerMinute": 100,
    "tokensPerMinute": 50000
  }
}
```

Default limits (if not specified):
- 100 requests/minute
- 50,000 tokens/minute

---

## How It Works

### Tracking Key Format

```
ratelimit:{apiKey}:{minute}
```

Example: `ratelimit:sk-corvo-kinisi-xxx:202601060830`

### Flow (when enabled)

1. **Pre-request check**: Compare current usage against limits
2. **Request processing**: Allow or reject
3. **Post-request increment**: Update counters

### Token Estimation

Tokens are estimated from message content:

```typescript
// Rough estimate: ~1.3 tokens per word
const words = text.split(/\s+/).length;
return Math.floor(words * 1.3);
```

---

## Response Headers

Successful responses include rate limit headers when rate limiting is enabled:

| Header | Description |
|--------|-------------|
| `RateLimit-Limit` | Maximum requests per minute |
| `RateLimit-Remaining` | Requests remaining in window |
| `RateLimit-Reset` | Unix timestamp when window resets |
| `RateLimit-Used` | Requests used in current window |

---

## Error Response

When limit exceeded (while enabled):

```json
{
  "error": "Rate limit exceeded",
  "limit": 100,
  "type": "requests"  // or "tokens"
}
```

HTTP Status: `429 Too Many Requests`

---

## Admin Bypass

Clients with `"admin": true` bypass rate limiting entirely.

---

## KV Storage

Usage data is stored with 120-second TTL (2 minutes for safety buffer):

```typescript
await CORTEX_CLIENTS.put(rateLimitKey, JSON.stringify({
  requests: 45,
  tokens: 125000
}), { expirationTtl: 120 });
```

---

## Implementation

Located in `src/middleware/rate-limit.ts`:
- `rateLimitCheckMiddleware` - Pre-request check
- `rateLimitIncrementMiddleware` - Post-request update

---

## Related

- [Authentication](./authentication.md) - API key system
- [spec.md](../spec.md) - Full API documentation
