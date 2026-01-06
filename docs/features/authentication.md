# Authentication

API key-based authentication system using Cloudflare KV.

---

## Overview

All API endpoints (except the root health check) require authentication via Bearer token. Client configurations are stored in the `CORTEX_CLIENTS` KV namespace.

---

## API Key Format

```
sk-corvo-{app_name}-{random_string}
```

Examples:
- `sk-corvo-kinisi-8823abc`
- `sk-corvo-primalmarc-x7f2d9e`

---

## Request Authentication

Include the API key in the Authorization header:

```bash
curl -H "Authorization: Bearer sk-corvo-kinisi-xxx" \
  https://cortex.corvolabs.com/v1/models
```

---

## Client Configuration

When a request arrives, the auth middleware:

1. Extracts the Bearer token from `Authorization` header
2. Looks up the key in `CORTEX_CLIENTS` KV
3. Attaches the `ClientConfig` to the request context

```typescript
// Middleware flow
const apiKey = header('Authorization')?.replace('Bearer ', '');
const clientData = await CORTEX_CLIENTS.get(apiKey, { type: 'json' });

if (!clientData) {
  return { error: 'Invalid API Key' }, 401;
}

context.set('client', clientData);
```

---

## Adding New Clients

Via Wrangler CLI:

```bash
wrangler kv:key put --namespace-id=<ID> "sk-corvo-myapp-xxx" '{
  "appId": "myapp",
  "name": "My Application",
  "defaultModel": "gpt-4o",
  "allowZai": true,
  "fallbackStrategy": "openrouter",
  "rateLimit": {
    "requestsPerMinute": 100,
    "tokensPerMinute": 50000
  }
}'
```

---

## Admin Authentication

Some endpoints require admin privileges:
- `/health/providers`
- `/health/reset/:provider`
- `/admin/*`
- `/analytics/*`

Admin clients must have `"admin": true` in their configuration:

```json
{
  "appId": "admin-cli",
  "name": "Admin CLI",
  "admin": true,
  ...
}
```

---

## Error Responses

| Status | Message | Cause |
|--------|---------|-------|
| 401 | `Unauthorized: Missing API key` | No Authorization header |
| 401 | `Invalid API Key` | Key not found in KV |
| 403 | `Forbidden: Admin access required` | Non-admin key on admin endpoint |

---

## Implementation

- **Standard auth**: `src/middleware/auth.ts` → `authMiddleware`
- **Admin auth**: `src/middleware/auth.ts` → `adminAuthMiddleware`

---

## Related

- [Rate Limiting](./rate-limiting.md) - Per-client quotas
- [spec.md](../spec.md) - Full API documentation
