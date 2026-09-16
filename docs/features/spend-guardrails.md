# Spend Guardrails

Request-level cost-safety controls applied before any upstream provider call. These exist because rate limiting is intentionally disabled on request-serving routes; without these guardrails a single leaked API key means effectively unbounded spend.

---

## Request body size limit

All request bodies on `/v1/chat/completions` and `/v1/responses` are capped.

| Setting | Default | Env var |
|---|---|---|
| Max body size | 2 MiB (2,097,152 bytes) | `MAX_BODY_BYTES` |

Oversized bodies are rejected with **413** before parsing/telemetry.

---

## max_tokens ceiling

`max_tokens` is capped at a provider-safe ceiling. Streaming output is fully buffered for telemetry, so an unbounded `max_tokens` is also a memory risk.

| Setting | Default | Env var |
|---|---|---|
| `max_tokens` ceiling | 32,768 | `MAX_TOKENS_CEILING` |

- `/v1/chat/completions`: validated in the request schema → **400** when exceeded.
- `/v1/responses`: validated before forwarding → **400** when exceeded (full Zod validation tracked separately).

---

## Message / content caps

Applies to `/v1/chat/completions` request schema:

| Cap | Value |
|---|---|
| Messages per request | 128 |
| Per-message content length (string or text part) | 262,144 chars |
| Image data URL length | 1,572,864 chars |

Violations return **400**.

---

## Per-client model allowlist

`ClientConfig.allowedModels` authorizes which models a client may invoke. Enforced on `/v1/chat/completions` (legacy **and** header mode, after alias resolution) and `/v1/responses`, before any upstream fetch. Violations return **403** with:

```json
{ "error": "Forbidden", "message": "Model 'x' is not permitted for this client", "model": "x" }
```

Entry semantics:

| Entry | Meaning |
|---|---|
| field omitted | all models allowed (backward compatible) |
| `[]` | no models allowed |
| `["*"]` | all models allowed |
| `gpt-4o` | exact match |
| `glm*` | prefix match |

Unknown model strings that pass the allowlist still fall through to paid OpenRouter routing — keep client lists tight.

---

## Not yet implemented (deferred)

- Per-client concurrent-request cap (generalized `ProviderConcurrency` DO) — deferred to DO Phase 3.
- DO-based per-key request/token limiter.

---

## Related

- [Authentication](./authentication.md) - client config reference
- [Rate Limiting](./rate-limiting.md) - quota infrastructure (disabled on serving routes)
- [Provider Routing](./provider-routing.md) - routing/fallback behavior
