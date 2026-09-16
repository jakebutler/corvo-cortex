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
| Z.ai | `https://api.z.ai/api/coding/paas/v4/chat/completions` | `Authorization: Bearer` |
| Anthropic | `https://api.anthropic.com/v1/messages` | `x-api-key` + `anthropic-version` |
| OpenAI | `https://api.openai.com/v1/chat/completions` | `Authorization: Bearer` |
| MiniMax | `https://api.minimax.io/anthropic/v1/messages` | `x-api-key` + `anthropic-version` |
| OpenRouter | `https://openrouter.ai/api/v1/chat/completions` | `Authorization: Bearer` |

---

## Z.ai Concurrency Guard

Corvo enforces model-level in-flight concurrency for `z-ai-pro` routes before calling upstream.

- Enforcement runtime: `ProviderConcurrency` Durable Object
- Request path: `POST /v1/chat/completions` (legacy model-based routing path)
- Failure behavior: returns `429` with `error: "Provider concurrency limit reached"`
- Release behavior:
  - Non-stream requests release the slot after completion/error.
  - Stream requests release on stream completion/error callbacks.

The limit map follows the current Z.ai published model limits (for example `glm-4.6: 3`, `glm-4.7: 5`, `glm-4-plus: 20`) and is defined in `src/services/provider-concurrency.ts`.

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

## Model Aliases

Legacy model names are mapped to current equivalents before routing. Targets were verified against the live provider catalogs (OpenRouter public `/api/v1/models`, 2026-09-15):

| Legacy name | Target | Tier semantics |
|---|---|---|
| `claude-3-opus*` | `claude-opus-4-6` | Opus tier |
| `claude-3*sonnet*` | `claude-sonnet-4-6` | Sonnet tier |
| `claude-3*haiku*` | `claude-haiku-4-5-20251001` | Haiku tier |
| `gpt-4o-mini*` | `gpt-5-mini` | Budget tier |
| `gpt-3.5*` | `gpt-5-mini` | Budget tier |
| `gpt-4*` | `gpt-5.2` | Flagship tier |
| `glm-4-plus`, `glm-4.6*` | `glm-5.3` | GLM flagship tier |
| `glm-4*` (rest) | `glm-5.3-flash` | GLM budget tier (cost-safe default) |

Aliases are **upgrades**: callers invoking a deprecated name are served the current equivalent of the same capability tier, at that model's standard pricing.

### KV configuration and rollback

Aliases are read from `CORTEX_CONFIG` key `config:model-aliases` — an array of `{ "match": "<regex source>", "replacement": "<model id>", "note": "..." }` (first match wins, case-insensitive). Invalid entries are skipped. To change an alias without a deploy:

```bash
npx wrangler kv key put --namespace-id=<CORTEX_CONFIG_ID> "config:model-aliases" \
  '[{"match":"^gpt-4","replacement":"gpt-5.2","note":"flagship"}]' --remote
```

**Rollback:** delete the key (`npx wrangler kv key delete --namespace-id=<ID> "config:model-aliases" --remote`) — the built-in table in `src/utils/model-aliases.ts` takes effect again.

---

## Model Name Matching

Direct-provider selection uses **prefix matching on the vendor-normalized model name** (never substring matching):

- `-1.` DigitalOcean preemption: KV-mapped models (see [DigitalOcean](./digitalocean.md)) when `CREDITS_DIGITALOCEAN=true` and ledger available > 0
- `glm*` / `z-ai*` → Z.ai Pro
- `claude*` → Anthropic Direct (with credits)
- `gpt*` / `o<digit>*` → OpenAI Direct (with credits)
- `minimax*` → MiniMax Direct (with credits)

Vendor-prefixed ids are normalized: `openai/gpt-5` routes to OpenAI Direct sending `gpt-5`; `anthropic/claude-*` routes to Anthropic Direct. Mismatched or unknown vendors (`mistral/...`) and everything unmatched stay on **OpenRouter**, which understands prefixed ids natively. Crafted names like `not-claude` never reach direct providers.

---

## Example Flow

```
Request: model="claude-3-5-sonnet"

1. Alias resolution: → "claude-sonnet-4-6"
2. Prefix match: "claude..." AND CREDITS_ANTHROPIC=true? → Yes
3. Route to: Anthropic Direct
4. Transform request → Anthropic Messages API format
5. Execute with retry logic
6. Transform response → OpenAI format
```

---

## Policy Model Allowlist

The routing policy supports a policy-level model allowlist that constrains client-pinned models (`x-kinisi-model` header or body `model`):

```json
{
  "version": "v2",
  "enabled": true,
  "allowedModels": ["gpt-5-mini", "glm-*"],
  "allowClientModelPinning": false,
  "..."
}
```

Entry semantics (shared with the per-client `allowedModels`): exact ids, trailing-`*` prefix globs (`glm*`), `*` = allow-all, `[]` = allow-none, omitted = allow-all.

Behavior when a client pins a model **outside** the allowlist:

| `allowClientModelPinning` | Behavior |
|---|---|
| `true` / omitted (default) | Pin ignored; the policy's model profile for each candidate is used |
| `false` | Request rejected with **403** (`error.class: "forbidden"`) |

Pinned models **inside** the allowlist are honored as-is. This is a second governance layer on top of the per-client `allowedModels` (client allowlist AND policy allowlist both apply).

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
