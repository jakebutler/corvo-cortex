# Provider Routing

Smart routing system that directs LLM requests to the optimal provider.

---

## Overview

The router (`src/services/router.ts`) determines which LLM provider handles each request based on:
- Requested model name
- Available credits (environment flags)
- Client fallback strategy configuration

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
