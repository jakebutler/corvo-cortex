# 05 — Proposal: DigitalOcean Serverless Inference as a Priority Provider

**Status:** Proposal (design + implementation plan; no code written)
**Goal:** Route eligible models to DigitalOcean (DO) serverless inference **first**, burning the ~$5k in non-Anthropic/non-OpenAI DO credits before any paid OpenRouter spend; OpenRouter remains the final fallback.
**Prerequisite:** Phase 0 closes the P0 audit gaps (see [README](./README.md)) — adding a funded provider multiplies every existing cost-control weakness.

---

## 1. DigitalOcean Serverless Inference — Verified Facts (Sept 2026)

Product naming has churned (GenAI Platform → Gradient AI Platform → **DigitalOcean Inference**); the serverless inference API is stable:

| Fact | Value | Source |
|---|---|---|
| Base URL | `https://inference.do-ai.run/v1` (⚠️ older `inference-api.do-ai.run` is dead) | [SI endpoints](https://docs.digitalocean.com/products/inference/how-to/si-endpoints/) |
| Chat completions | `POST /v1/chat/completions` — **OpenAI-compatible** (official examples use the OpenAI SDK with this base URL) | [API reference](https://docs.digitalocean.com/reference/api/reference/serverless-inference/) |
| Models list | `GET /v1/models` — real API, no scraping needed | same |
| Also available | `POST /v1/responses`, `POST /v1/messages` (Anthropic format!), `/v1/embeddings`, `/v1/batches` | same |
| Auth | `Authorization: Bearer <model access key>`; keys are scopeable per foundation model; personal tokens (`dop_v1_*`) also work | [Model access keys](https://docs.digitalocean.com/products/inference/how-to/manage-model-access-keys/) |
| Streaming | SSE, `stream_options.include_usage` supported | same |
| Rate limits | Tier-based per **account**: T1–2: 120 RPM / 500–750K TPM (and **no Anthropic/OpenAI models**); T3–4: 600 RPM / 800K–2M; T5: 4,500 RPM / up to 70M. Quota headers: `x-ratelimit-{limit,remaining,reset}-{requests,tokens-per-minute,tokens-per-day}` | [Limits](https://docs.digitalocean.com/products/inference/details/limits/), [Quota headers](https://docs.digitalocean.com/products/inference/reference/quota-specific-response-headers/) |
| Billing | Per-token, prepaid-only since 2026-06-29; **shared prepaid balance across the whole DO account** (Droplets deplete it too); at $0, inference is suspended | [Prepayment](https://docs.digitalocean.com/products/inference/how-to/manage-serverless-inference-prepayment/) |
| Balance check | `GET https://api.digitalocean.com/v2/customers/my/balance` with a `dop_v1_` token | DO API spec |
| Catalog | 70+ models, slug IDs (`llama-4-maverick`, `glm-5.3-flash`, `deepseek-v4.1-flash`, `qwen3.8-max`, `openai-gpt-oss-120b`, …); fast deprecation cadence (only 2–3 newest versions of each model kept) | [Models](https://docs.digitalocean.com/products/inference/details/models/), [Support policy](https://docs.digitalocean.com/products/inference/details/model-support-policy/) |
| Caveats | `response_format`/`json_schema` **not** in the documented chat-completions schema (structured outputs exist as a model-level feature for a few models only); `max_tokens` deprecated in favor of `max_completion_tokens`; guardrails inspect all traffic | API reference |

**Economically interesting models for this gateway** (per 1M in/out, from DO's pricing table): `glm-5.3-flash` $0.15/$0.50, `llama-4-maverick` $0.20/$0.696, `deepseek-v4.1-flash` $0.30/$1.20, `deepseek-3.2` $0.25/$0.80, `mistral-3-14B` $0.20/$0.20, `openai-gpt-oss-120b` $0.06/$0.39. These undercut or match OpenRouter on the same open-weight models — every request moved here before OpenRouter is pure credit burn.

---

## 2. Strategic Fit

1. **Mirrors the existing Fireworks pattern.** The gateway already has a "preempt to a credit-funded provider when the model is in its catalog" mechanism (`router.ts:31-45`, `isFireworksModel`). DO slots into the same shape — with a real models API instead of scraping.
2. **Burns credits in the right order.** Current priority is: Fireworks (credit-funded) → Z.ai (free-ish) → Anthropic/OpenAI (credit flags) → OpenRouter (paid). DO becomes the broadest credit-funded tier: it hosts *open-weight equivalents of everything*, so most non-Claude/non-GPT traffic can ride DO credits.
3. **Claude-on-DO is a Phase-4 option.** DO exposes `anthropic-claude-sonnet-4.5` / `opus-4.8` (at provider-aligned pricing) via both chat completions and `/v1/messages`. Routing Claude traffic through DO when the direct Anthropic ledger is dry would spend *DO credits* instead of OpenRouter *cash* — the single biggest cost lever in this proposal. (Caveats: no extended thinking via chat completions; tier ≥3 required.)
4. **Protocol fit is excellent.** OpenAI-compatible + SSE + usage-in-stream means the existing `openaiAdapter`, streaming usage tap, pricing hook, and telemetry path all work unchanged.

## 3. Design

### 3.1 Identity & configuration

| Item | Value |
|---|---|
| `LLMProvider` / `ModelProvider` | add `'digitalocean'` |
| `RoutingProvider` (header mode) | add `'digitalocean'` (`schemas/routing-hints.ts:5`) |
| Secret | `DIGITALOCEAN_API_KEY` (model access key; `wrangler secret put`) |
| Optional secret | `DIGITALOCEAN_BALANCE_TOKEN` (`dop_v1_` token for the balance API; can be the same DO team's token) |
| Flag | `CREDITS_DIGITALOCEAN` var (`"true"` until credits exhausted) |
| Upstream URL | `https://inference.do-ai.run/v1/chat/completions` (constant, like all other routes) |
| Adapter | reuse `openaiAdapter` (pass-through) — map `max_tokens`→`max_completion_tokens` if we observe deprecation warnings |

### 3.2 Routing integration

**Legacy mode** (`services/router.ts`): insert a DO tier **above Fireworks preemption** (DO credits are broader), gated on `CREDITS_DIGITALOCEAN === 'true'` + ledger balance > 0:

```
0. DO preemption: resolveModelAlias → if doModelFor(model) exists in the
   DO catalog AND DO ledger balance > 0 → route DO
0b. Fireworks preemption (unchanged)
1..4 Z.ai / Anthropic / OpenAI / MiniMax (unchanged)
5. fallback strategy → OpenRouter (unchanged)
```

`doModelFor(model)` is a **config-driven mapping table** in KV (`routing:digitalocean-models`), not substring logic — explicitly avoiding the audit's substring-matching findings. Seed it with what we actually use, e.g.:

| Client asks | DO model |
|---|---|
| `glm-*` (after alias collapse) | `glm-5.3-flash` (or `glm-5.3` for quality) |
| `llama-*`, `meta-llama/*` | `llama-4-maverick` |
| `deepseek-*` | `deepseek-v4.1-flash` / `deepseek-3.2` |
| `mistral-*` | `mistral-3-14B` |
| gpt-oss-class | `openai-gpt-oss-120b` |

Unmapped models are never sent to DO. This table is the policy surface: enabling/disabling/retargeting models is a KV write, no deploy.

**Header mode**: extend `routingProviderSchema` with `'digitalocean'`, extend `resolveHeaderModeRoute` (`chat.ts:765-787`) with the DO URL/key, and update `DEFAULT_ROUTING_POLICY` so `speed` chains lead with `{provider:'digitalocean', modelProfile:'fast_json_model'}` (new profile → `glm-5.3-flash`), OpenRouter second, `safe_json_model` last. Existing `x-kinisi-provider-block/prefer` headers keep working over the widened enum for free.

**Model pinning guard (audit follow-through):** because `x-kinisi-model`/body `model` currently override policy profiles, add the planned per-policy model allowlist *in the same change* — otherwise DO simply becomes another place to point expensive pinned models. Cheap version: policy-level `allowedModels` regex/ID list; pinned models not in the list fall back to the policy profile.

### 3.3 Catalog & pricing

- **Catalog:** add `'digitalocean'` to `refreshAllModelCatalogs` → new `fetchDigitalOceanModels(env)` calling `GET https://inference.do-ai.run/v1/models` with the bearer key (no scraping). KV key `models:digitalocean` + merged into `models:all`. The DO catalog deprecates models fast; the daily cron refresh plus "alert if refresh yields 0" (audit P3) covers churn. Eligibility checks (`doModelFor`) consult this catalog so dead DO models fail over to OpenRouter rather than 404-ing.
- **Pricing:** seed `pricing:digitalocean` in KV via `POST /admin/pricing` from DO's published table (same mechanism as other providers; `estimateCostFromUsage` then works unchanged). Because DO model IDs are slugs, exact-match pricing works with no normalization.

### 3.4 Credits & ledger

- Ledger instance `credit-ledger:digitalocean` appears automatically via `ledgerIdForProvider` once `'digitalocean'` joins the `LLMProvider` union (add to `PROVIDERS` in `routes/admin.ts:20`).
- **Balance sync (new, small):** extend the daily cron and `POST /admin/credits/sync` with a DO sync: `GET api.digitalocean.com/v2/customers/my/balance` using `DIGITALOCEAN_BALANCE_TOKEN` → `setCreditBalance(env,'digitalocean', amount,'USD')`. This gives DO the *accurate* sync OpenRouter already enjoys and directly addresses the audit finding that only OpenRouter self-heals. (The balance API reports account-level prepaid balance — close enough for a single-purpose account; note it is shared with Droplets, so ideally use a dedicated DO team for inference.)
- **Exhaustion handling:** DO returns 402-style/billing errors when the prepaid balance hits $0 → existing `isCreditExhaustionResponse` path marks the ledger and falls back to OpenRouter (the *correct* behavior here — unlike the false-positive case, DO billing errors are unambiguous). Also parse `x-ratelimit-remaining-tokens-per-day: 0` as a soft-exhaustion signal.
- **Phase 0 dependency:** reserve-then-settle (or negative-floor + alert) in the credit ledger must land first; a prepaid account that suspends at $0 makes overdraft races *more* visible here than on OpenRouter (suspended account = hard outage of the DO tier, not just overspend).

### 3.5 Rate limits & concurrency

Tier 1–2 caps (120 RPM) are low for a multi-app gateway. Two mechanisms:
1. **Reuse `ProviderConcurrency` DO** for `digitalocean` (it currently hard-codes z-ai-only at `services/provider-concurrency.ts:58` — generalize the provider check and move limits to KV). Configure per-model in-flight caps sized to the account tier.
2. **Honor quota headers**: on 429 (or `remaining == 0`), classify as `throttled` → header mode already retries the next candidate; legacy mode's `fetchWithRetry` treats 429 as retryable with backoff, then the credit-exhaustion fallback applies. Add `Retry-After` respect while touching `utils/retry.ts` for the audit's signal work.

### 3.6 Streaming & strict schema

- **Streaming:** pass-through works as-is (`stream_options.include_usage` supported → `createStreamingResponseWithUsage` extracts usage → deduction + telemetry paths unchanged). Note for the audit's streaming finding: DO is OpenAI-format, so raw passthrough is *correct* here.
- **Strict schema mode:** `response_format.json_schema` is not documented for DO chat completions. Safest behavior: exclude DO candidates when strict schema is enabled **unless** the mapping table marks the model as structured-output-capable (DO lists a few models with structured outputs). The post-hoc validator (`validateStrictSchemaPayload`) already protects callers either way — worst case DO attempts yield `schema_invalid` and the executor moves on (real cost: one wasted attempt).

### 3.7 Observability

- `x-corvo-cortex-provider: digitalocean` flows automatically once headers are set from the winner provider.
- Add `'digitalocean'` to `isKnownProvider` (`middleware/telemetry.ts:176-186`) so Langfuse traces carry cost data.
- `/health/providers` extension: the breaker DO instance-per-provider pattern (post-fix) will include a `digitalocean` breaker automatically.
- Optional: a `GET /admin/credits` row + Langfuse metadata field `do_account_balance` from the sync job for prepaid-balance monitoring.

## 4. Phased Implementation Plan

Estimated effort assumes one engineer familiar with the codebase; tests included.

### Phase 0 — Audit remediation floor (3–5 days) — **blocks everything**
1. Auth cache: LRU cap + positive-only caching (`middleware/auth.ts`).
2. Request limits: body size middleware, `max_tokens` ceiling, messages count/size caps in `chatCompletionRequestSchema`.
3. Credit ledger: reserve-then-settle or negative-floor; check `deductCredits` result; per-provider recovery in cron.
4. Circuit breaker: real persistence + single-instance status; `/health/providers` fix.
5. `npm audit fix` + hono bump; sanitize upstream error passthrough.
*Exit criteria: adversarial scenarios 1.1, 2.1, 2.3, 4.x from 03-adversarial no longer work.*

### Phase 1 — DO provider core (2–3 days)
1. `types.ts`: `'digitalocean'` in `LLMProvider`, `ModelProvider`, `Env` (`DIGITALOCEAN_API_KEY`, `DIGITALOCEAN_BALANCE_TOKEN?`, `CREDITS_DIGITALOCEAN?`).
2. `services/digitalocean.ts`: catalog fetch (`/v1/models`), model-mapping resolver (KV table), upstream URL constant.
3. `router.ts`: DO preemption tier; `transform.ts`: map provider → `openaiAdapter`.
4. Credits: ledger provider registration; DO balance sync in cron + `/admin/credits/sync`.
5. Pricing: seed script + `POST /admin/pricing` payload for the initial model set.
6. Tests: unit (mapping, routing tiers, sync), integration (mocked DO fetch incl. 402/429/usage-in-stream).
*Exit criteria: `model: "glm-4.7"` routes DO-first with correct deduction and telemetry; DO outage/402 falls through to OpenRouter.*

### Phase 2 — Header-mode & policy integration (1–2 days)
1. `routingProviderSchema` + `resolveHeaderModeRoute` + `DEFAULT_ROUTING_POLICY` chains (DO-led speed, OpenRouter safe-net).
2. Per-policy model allowlist (closing the model-pin override).
3. `isKnownProvider` + docs (`docs/features/provider-routing.md`, new `docs/digitalocean.md` mirroring `fireworks.md`).
*Exit criteria: kinisi header requests honor DO preference/blocking; policy matrix drives DO-first routing.*

### Phase 3 — Hardening & ops (1–2 days)
1. Generalize `ProviderConcurrency` to DO with KV-configured caps.
2. Quota-header parsing (`x-ratelimit-*`) → throttled classification.
3. Prepaid-balance watchdog: cron warns (log + Langfuse tag) when DO balance < threshold; optional auto-disable flag.
4. Rollout: per-client opt-in flag (`allowDigitalocean`, mirroring `allowZai`), canary one app, watch Langfuse provider mix + ledger accuracy for a week.
*Exit criteria: canary app spends DO credits with ≤ expected deviation between ledger and DO's own usage metrics.*

### Phase 4 — Options (post-validation)
- **Claude via DO**: route `claude-*` to DO's `anthropic-claude-*` models when the Anthropic direct ledger is dry (uses `/v1/chat/completions`; consider `/v1/messages` + `anthropicAdapter` if fidelity demands). Biggest cost lever; needs tier ≥3 and careful alias/ID mapping.
- `/v1/responses` via DO Responses API (mirroring the Fireworks route).
- Batch inference for async workloads (up to 50% discount).
- Evaluate DO **Inference Router** (policy-based routing, cache-aware) as a future replacement for parts of the internal policy engine.

**Total: ~7–12 working days end-to-end.**

## 5. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| DO model deprecation churn (2–3 version policy) | 404s → circuit flapping | Catalog-gated mapping: only route if model present in today's catalog; daily refresh + zero-model alert |
| Prepaid balance shared with other DO products (Droplets) | Surprise suspension of DO tier; OpenRouter fallback spikes spend | Dedicated DO team for inference; balance watchdog; auto-disable flag |
| Tier 1–2 RPM/TPM caps (120 RPM) | 429 storms at gateway load | Concurrency DO caps; throttled classification → next candidate; request tier increase before scaling |
| Structured outputs not generally documented | `schema_invalid` churn in strict mode | Exclude DO from strict-schema candidate chains unless model flagged capable |
| Ledger vs DO metering drift | Credit overrun at suspension boundary | Phase 0 reserve-then-settle; daily balance sync makes drift visible |
| `max_tokens` deprecation | Future breakage | Map to `max_completion_tokens` in a thin DO transform when adding |
| Guardrails block content | Unexpected 4xx with `error.type/reason_codes` | Map DO guardrail errors to `upstream_4xx` non-retriable; surface reason codes in telemetry |

## 6. Test Plan

- Unit: mapping resolver (incl. unmapped-model no-op), routing tier order, catalog fetch parse, balance sync, pricing lookup, strict-schema exclusion, `isKnownProvider`.
- Integration (mocked upstream): DO 200 JSON; DO SSE with `usage` in final chunk (assert deduction + telemetry); DO 402 → ledger zeroed → OpenRouter fallback; DO 429 with quota headers → throttled → next candidate; guardrail-block 4xx → non-retriable.
- Manual/canary: one app flagged `allowDigitalocean`; compare Langfuse-recorded per-request `costUsd` against DO control-panel usage for the same window (target <5% drift); kill-switch drill (zero the ledger → confirm clean OpenRouter fallback).

## 7. Open Questions

1. Which DO account/team hosts inference (shared prepaid vs dedicated)? Dedicated is strongly recommended.
2. Current DO tier (drives RPM caps and access to Anthropic/OpenAI models — T1–2 can't use them at all)?
3. Should `glm-*` traffic move from Z.ai direct to DO's `glm-5.3-flash` (cheaper, but Z.ai is free-credit-based)? Recommendation: keep Z.ai as-is initially; revisit when Z.ai credits exhaust.
4. For Phase 4 Claude-on-DO: acceptable latency/feature deltas (no extended thinking via chat completions) for fallback-tier traffic?
