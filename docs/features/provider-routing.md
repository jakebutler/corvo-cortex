# Provider Routing

Smart routing system that directs LLM requests to the optimal provider.

---

## Overview

The router (`src/services/router.ts`) determines which LLM provider handles each request based on:
- Requested model name
- Available credits (environment flags)
- Credit ledger balances (including live OpenRouter sync)
- Client fallback strategy configuration
- Optional header-driven hints (`x-kinisi-*`) on `POST /v1/chat/completions`

---

## Routing Priority

Requests are routed in this order:

```
1. Z.ai Pro          → Model contains "glm" or starts with "z-ai"
2. Anthropic Direct  → Model contains "claude" AND CREDITS_ANTHROPIC=true
3. OpenAI Direct     → Model contains "gpt" or starts with "o1" AND CREDITS_OPENAI=true
4. MiniMax Direct    → Model starts with "MiniMax" or "minimax" AND CREDITS_MINIMAX=true
5. Fallback          → Based on client.fallbackStrategy
```

---

## Fallback Strategies

Configured per-client in the `ClientConfig`:

| Strategy | Behavior |
|----------|----------|
| `openrouter` | Route to OpenRouter (incurs cost) |
| `fail-fast` | Return `402 Payment Required` error |

---

## Provider Endpoints

| Provider | URL | Auth Header |
|----------|-----|-------------|
| Z.ai | `https://open.bigmodel.cn/api/paas/v4/chat/completions` | `Authorization: Bearer` |
| Anthropic | `https://api.anthropic.com/v1/messages` | `x-api-key` + `anthropic-version` |
| OpenAI | `https://api.openai.com/v1/chat/completions` | `Authorization: Bearer` |
| MiniMax | `https://api.minimax.io/anthropic/v1/messages` | `x-api-key` + `anthropic-version` |
| OpenRouter | `https://openrouter.ai/api/v1/chat/completions` | `Authorization: Bearer` |

---

## Credit Flags

Set via environment variables or `wrangler.toml`:

```toml
[env.production.vars]
CREDITS_ANTHROPIC = "true"
CREDITS_OPENAI = "true"
CREDITS_MINIMAX = "true"
```

When a credit flag is `"true"`, requests for that provider's models use direct API. Otherwise, they fall back.

In addition, Corvo tracks credits via the Durable Object credit ledger:
- OpenRouter credits are refreshed from `GET https://openrouter.ai/api/v1/credits` and cached briefly.
- If a direct provider returns a credit-exhaustion response (for example `402`), Corvo marks that provider as exhausted and retries through OpenRouter once when client fallback strategy is `openrouter`.

Use `POST /admin/credits/sync` to force an OpenRouter credit refresh.

---

## Request Transformation

Each provider has an adapter that transforms:
- **Request**: OpenAI format → Provider format
- **Response**: Provider format → OpenAI format

See `src/providers/` for adapter implementations.

---

## Example Flow

```
Request: model="claude-3-5-sonnet"

1. Check: contains "glm"? → No
2. Check: contains "claude" AND CREDITS_ANTHROPIC=true? → Yes
3. Route to: Anthropic Direct
4. Transform request → Anthropic Messages API format
5. Execute with retry logic
6. Transform response → OpenAI format
```

---

## Related

- [spec.md](../spec.md) - Full API documentation
- [Circuit Breaker](./circuit-breaker.md) - Provider health management
- [Header Routing Client Integration](./header-routing-client-integration.md) - Client implementation guide

---

## Header-Driven Routing (`x-kinisi-*`)

Corvo Cortex supports an opt-in header contract on `POST /v1/chat/completions`:

- `x-kinisi-llm-stage`: `week_1 | week_n | refine_week_1`
- `x-kinisi-routing-strategy`: `speed | balanced | quality`
- `x-kinisi-provider-prefer`: CSV provider order
- `x-kinisi-provider-allow`: CSV allowlist
- `x-kinisi-provider-block`: CSV denylist
- `x-kinisi-request-priority`: `low | normal | high`
- `x-kinisi-max-latency-ms`: caller latency budget
- `x-kinisi-request-role`: `primary | hedge | fallback`
- `x-kinisi-model`: model override (wins over body `model`)

Behavior:

- If no `x-kinisi-*` headers are present, legacy routing behavior is unchanged.
- Invalid header values fall back to defaults (request is not rejected).
- Route constraints that eliminate all candidates are ignored and safe defaults are used.
- Hedging is enabled only for `week_n + speed + primary`.
- `stream=true` with strict `response_format.json_schema` returns `400`.

## Response Metadata Headers

Corvo Cortex now returns deterministic metadata headers on both success and error:

- `x-corvo-cortex-provider`
- `x-corvo-cortex-model`
- `x-corvo-cortex-route-id`
- `x-corvo-cortex-fallback-used`
- `x-corvo-cortex-hedge-used`
- `x-corvo-cortex-cache-hit`
- `x-corvo-cortex-ttft-ms`
- `x-corvo-cortex-latency-ms`

Unavailable values are returned as `unknown`.
