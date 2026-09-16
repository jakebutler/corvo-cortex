# DigitalOcean Inference Provider

DigitalOcean Serverless Inference (`https://inference.do-ai.run/v1`, OpenAI-compatible) is the **first-priority credit-funded provider**: eligible models burn DO's prepaid balance before any paid OpenRouter spend.

---

## Configuration

| Item | Where | Notes |
|---|---|---|
| `DIGITAL_OCEAN_MODEL_ACCESS_KEY` | secret (`wrangler secret put ... --env production`) | DO Inference model access key (per-foundation-model scopeable) |
| `DIGITAL_OCEAN_BALANCE_TOKEN` | secret (optional) | `dop_v1_` DO API token; enables ledger balance sync |
| `CREDITS_DIGITALOCEAN` | var (`[env.production.vars]`) | `"true"` enables DO-first routing |
| Model mapping | KV `CORTEX_CONFIG` key `routing:digitalocean-models` | client-facing model → DO slug (see below) |
| Pricing | KV key `pricing:digitalocean` | per-slug `{ input, output }` per 1M tokens |

Endpoint: `https://inference.do-ai.run/v1/chat/completions` (⚠️ older `inference-api.do-ai.run` is dead). Auth: `Authorization: Bearer <model access key>`.

---

## Model Mapping

Client-facing models map to DO slugs via the KV table `routing:digitalocean-models` — an array of `{ "match": "<prefix>", "model": "<do-slug>", "exact": true? }` (first entry wins, case-insensitive). **Unmapped models are never routed to DO.** Default table:

| Client asks | DO model |
|---|---|
| `glm-5.3` (exact) | `glm-5.3` |
| `glm-*` | `glm-5.3-flash` |
| `llama-*` | `llama-4-maverick` |
| `deepseek-*` | `deepseek-v4.1-flash` |
| `mistral-*` | `mistral-3-14B` |
| `openai-gpt-oss*`, `gpt-oss-*` | `openai-gpt-oss-120b` |

Every resolved slug is checked against the DO catalog (`models:digitalocean`, refreshed daily) so deprecated slugs fail over to OpenRouter instead of 404-ing. If no catalog has been fetched yet, the mapping is trusted to self-bootstrap.

To retarget models (no deploy):

```bash
npx wrangler kv key put --namespace-id=<CORTEX_CONFIG_ID> "routing:digitalocean-models" \
  '[{"match":"glm-","model":"glm-5.3-flash"},{"match":"deepseek-","model":"deepseek-3.2"}]' --remote
```

Delete the key to restore the defaults.

---

## Routing Priority

DO sits **above Fireworks** in the legacy routing tier order:

```
-1. DigitalOcean (CREDITS_DIGITALOCEAN=true + mapping resolves + ledger available > 0)
 0. Fireworks preemption (catalog + credits)
 1. Z.ai (glm/z-ai prefix)
 2. Anthropic direct (credits)
 3. OpenAI direct (credits)
 4. MiniMax direct (credits)
 5. OpenRouter fallback (paid)
```

Adapter: OpenAI pass-through (`openaiAdapter`) — DO is OpenAI-compatible, including SSE with `stream_options.include_usage`.

---

## Credits & Balance

- Ledger instance `credit-ledger:digitalocean` participates in the standard reserve-then-settle flow.
- **Balance sync**: `POST /admin/credits/sync {"provider":"digitalocean"}` and the daily cron call `GET api.digitalocean.com/v2/customers/my/balance` with `DIGITAL_OCEAN_BALANCE_TOKEN` and write the result into the ledger. Without the token the sync no-ops (log on cron).
- The balance is **account-level and shared with other DO products** (e.g. Droplets); at $0, DO suspends inference. The existing exhaustion machinery marks the ledger and falls back to OpenRouter.

## Pricing Seeds

Seed via admin (`POST /admin/pricing`) or directly:

```bash
npx wrangler kv key put --namespace-id=<CORTEX_CONFIG_ID> "pricing:digitalocean" '{
  "glm-5.3-flash": {"input": 0.15, "output": 0.5},
  "llama-4-maverick": {"input": 0.2, "output": 0.696},
  "deepseek-v4.1-flash": {"input": 0.3, "output": 1.2},
  "deepseek-3.2": {"input": 0.25, "output": 0.8},
  "mistral-3-14B": {"input": 0.2, "output": 0.2},
  "openai-gpt-oss-120b": {"input": 0.06, "output": 0.39}
}' --remote
```

---

## Responses API (`/v1/responses`)

`POST /v1/responses` routes to DO's Responses API (`https://inference.do-ai.run/v1/responses`) when the requested model maps via the DO mapping table and `CREDITS_DIGITALOCEAN=true`; all other models go to Fireworks. The same guardrails (body cap, `max_output_tokens` ceiling, allowlist, reserve/settle, unified headers) apply on both paths.

## Scope decisions (Phase 4)

- **Claude-on-DO is excluded by policy.** Per operator directive, OpenAI and Anthropic model families are never routed to DO (the prepaid DO credits do not apply), so the previously considered "Claude via DO when the Anthropic ledger is dry" option is off the table.
- **Batch inference** (`/v1/batches`, up to 50% discount) is not implemented — no async batch workloads today; revisit when one exists.
- **DO Inference Router evaluation**: DO's policy-based/cache-aware router could replace parts of the internal policy engine, but the gateway's KV-driven matrix + header hints already cover current needs. Re-evaluate if cross-provider caching becomes a priority.

## Notes

- `max_tokens`: DO deprecates it in favor of `max_completion_tokens` — currently passed through as `max_tokens` (still accepted); revisit if warnings appear.
- Strict-schema mode: DO chat completions do not document `response_format.json_schema`; strict-schema candidates may waste one attempt before the post-hoc validator rejects (executor moves on).
- Rate limits are account-tier based (T1–2: 120 RPM); 429s classify as `throttled` and fall through. See [Provider Routing](./provider-routing.md).

---

## Related

- [Provider Routing](./provider-routing.md)
- [Spend Guardrails](./spend-guardrails.md)
- [fireworks.md](../fireworks.md) - the analogous Fireworks provider
