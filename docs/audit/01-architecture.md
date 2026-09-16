# 01 — Architecture & High-Level Functional Evaluation

## 1. What This System Is

Corvo Cortex is a **serverless LLM gateway** deployed on Cloudflare Workers. Client applications authenticate with per-app API keys and speak an OpenAI-compatible Chat Completions dialect; the gateway picks a provider, translates request/response formats where needed, enforces credit limits, records telemetry, and returns a normalized response.

**Runtime stack:** Cloudflare Workers (ES modules), Hono 4 router, Zod 3 validation, 3 Durable Object classes, 2 KV namespaces, Langfuse (direct ingestion API) for observability. Runtime dependencies are minimal: `hono`, `langfuse` (installed but effectively bypassed — telemetry uses raw `fetch` to the ingestion endpoint), `zod`.

## 2. Component Map

```
src/
├── index.ts                 App entry: CORS, route mounting, cron handler, DO exports
├── types.ts                 Env bindings, routing types, Hono context variables
├── routes/
│   ├── chat.ts        (889) POST /v1/chat/completions — legacy + header-driven flows
│   ├── responses.ts   (249) POST /v1/responses — Fireworks passthrough proxy
│   ├── models.ts            GET /v1/models — merged catalog
│   ├── health.ts            /health/providers, /health/reset/:provider (admin)
│   ├── admin.ts       (245) credits, pricing, catalog refresh, routing policy (admin)
│   └── analytics.ts         Langfuse dashboard pointers (admin)
├── middleware/
│   ├── auth.ts        (148) Bearer key → KV lookup → client config, 30s in-memory cache
│   ├── telemetry.ts   (249) Trace lifecycle, streaming completion deferral
│   └── rate-limit.ts  (161) KV-based limiter — implemented but NOT mounted anywhere
├── services/
│   ├── router.ts            Legacy provider selection (substring model matching)
│   ├── routing-policy.ts    KV-backed policy for header mode (default matrix inline)
│   ├── routing-hints.ts     x-kinisi-* header parsing
│   ├── route-planner.ts     Policy + hints → ordered candidate list
│   ├── route-executor.ts (480) Sequential w/ retry + hedged (race) execution
│   ├── schema-validation.ts Custom JSON-Schema validator for strict output mode
│   ├── credits.ts           Ledger client + OpenRouter credit sync
│   ├── pricing.ts           KV pricing table → per-request cost estimate
│   ├── models-catalog.ts (589) Multi-provider catalog refresh (API + HTML scraping)
│   ├── fireworks-models.ts  Fireworks catalog (API, else HTML scrape)
│   ├── provider-concurrency.ts  Z.ai per-model concurrency guard client
│   └── telemetry.ts         Langfuse ingestion client
├── providers/               Adapters: anthropic, openai, zai, openrouter, base
├── durable-objects/
│   ├── circuit-breaker.ts   Per-provider breaker (broken persistence, see 04)
│   ├── credit-ledger.ts     Per-provider spend ledger
│   └── provider-concurrency.ts  Lease-based concurrency (in-memory only)
├── schemas/                 Zod: chat request, response, routing-policy, routing-hints
└── utils/                   retry, streaming, transform, model-aliases, headers, logger
```

## 3. Request Flows

### 3.1 Legacy flow (`POST /v1/chat/completions`, no kinisi headers)

```
auth (KV, 30s cache) → Zod validate → resolveModelAlias
→ determineProvider (substring match → fireworks preemption / z-ai / anthropic /
  openai / minimax / openrouter, credit-gated)
→ circuit breaker check → ledger balance pre-check (fallback→openrouter or 402)
→ Z.ai concurrency lease (z-ai only) → fetchWithRetry (max 3, exp backoff)
→ credit-exhaustion sniff on failure → single retry via OpenRouter
→ stream (raw passthrough + usage tap) or JSON (adapter transform + response Zod warn-only)
→ post-paid ledger deduction → x-corvo-cortex-* headers → Langfuse trace
```

### 3.2 Header-driven flow (`x-kinisi-*` headers present + policy enabled)

```
auth → Zod validate → parse hints → load KV routing policy (default inline)
→ optional strict json_schema mode (stream + strict = 400)
→ buildRoutePlan (stage/strategy matrix → candidates, allow/block/prefer filters,
  hedge config, retry policy, latency budget)
→ executeRoutePlan: sequential candidates with per-candidate retries and
  remaining-budget timeouts; optional 2-way hedged race (delayMs 300)
→ optional strict schema validation per attempt (retriable=false on schema_invalid)
→ winner → stream passthrough or JSON → ledger deduction → telemetry
```

Providers available in header mode are constrained to the `RoutingProvider` enum: **`'fireworks' | 'openrouter'` only** (`src/schemas/routing-hints.ts:5`). Legacy mode serves the other four providers.

### 3.3 Cron (daily)

`refreshAllModelCatalogs` (OpenRouter-derived subsets for OpenAI/Anthropic/Gemini; docs-page scraping for Z.ai/MiniMax; Fireworks API-else-scrape) + `syncOpenRouterCredits` (provisioning key → credits API → ledger + KV snapshot). Triggered via `scheduled` handler (`src/index.ts:75-87`) with wrangler cron `0 0 * * *`.

## 4. Architectural Strengths

1. **Clean layering.** Routes → services → providers/DOs is consistently enforced; shared types in `types.ts`; Zod schemas isolated. Easy to navigate; small blast radius per file.
2. **OpenAI-compatible facade with credit-aware routing is the right product idea.** Priority to pre-funded credit paths (Fireworks, Z.ai, direct provider credits) with OpenRouter as the metered fallback, per-client `fallbackStrategy` (openrouter vs fail-fast) is a sound cost-governance model — it's just not fully enforced (see §6).
3. **The header-driven routing stack is genuinely sophisticated**: policy matrix keyed by workload stage/strategy, provider allow/block/prefer, latency budgets enforced via abort, hedging with a configurable race delay, and post-hoc strict JSON-schema validation with `422 schema_invalid` semantics. This is the most defensible part of the codebase and it is well tested (`route-executor`, `route-planner`, `routing-hints`, `routing-policy`, `schema-validation` unit suites).
4. **Fail-open design where it should be** (telemetry, circuit-breaker check failures, concurrency guard failures) and fail-closed where it should be (auth, Zod validation).
5. **Streaming-first design**: usage extraction from SSE, deferred telemetry completion until stream end, concurrency leases released by stream lifecycle.
6. **Minimal runtime deps** — no heavyweight SDK surface in the hot path.

## 5. Architectural Weaknesses (Functional)

### 5.1 Two parallel routing stacks with divergent guarantees

Legacy mode and header mode implement different: provider sets, credit-check semantics (legacy exempts openrouter from the ≤0 check, `chat.ts:509`; header mode does not, `chat.ts:221-224`), concurrency guarding (legacy only, Z.ai only), header contract (`X-Corvo-*` on `/v1/responses` vs `x-corvo-cortex-*` on chat), and retry semantics (`fetchWithRetry` vs `route-executor` budget-aware retries). Every new capability must be implemented twice or consciously skipped. This is the single largest maintainability liability.

### 5.2 Durable Object state bugs undermine the reliability features

- Circuit breaker: persistence is write-only (`circuit-breaker.ts:202-206` writes; `storage.get` never called) and `/health/providers` polls a DO instance named `'status'` that never receives `check`/`record` calls (`health.ts:21`) — observability is broken and state resets on every DO hibernation/restart.
- Provider concurrency: counters/leases live in plain in-memory Maps with no storage at all (`provider-concurrency.ts:25-26`) — a DO eviction mid-load resets the guard and over-admits to Z.ai.

The unit tests pass because the mock DO (`tests/mocks/env.ts`) is a faithful in-process object — it does not model instance-per-`idFromName` isolation or eviction, which are exactly the failure modes in play.

### 5.3 Fragile catalog pipeline

Model catalogs for Z.ai, MiniMax, Gemini, and (fallback) Fireworks are maintained by **scraping marketing/docs HTML pages** with regexes. Two of those regexes contain `\\.` (literal-backslash-plus-wildcard) escaping bugs (`models-catalog.ts:199,339`) that make them match nothing, silently degrading to hardcoded fallback lists. Separately, OpenRouter-derived catalog IDs strip the `vendor/` prefix but are not normalized to direct-provider ID formats (e.g. `claude-sonnet-4.5` vs Anthropic's dash-style IDs) — catalog entries can be unroutable or mis-routed against direct providers.

### 5.4 Resource-management gaps

- No request body size limit anywhere (Hono `bodyLimit` unused); `messages` content is unbounded.
- Full stream output is buffered in isolate memory for telemetry (`streamOutput += chunk`, `chat.ts:352,643`; `responses.ts:168`).
- Hedged requests never cancel the losing fetch (`route-executor.ts:206-274`) — double upstream spend and orphaned work.
- `fetchWithRetry` on the legacy path receives no `AbortSignal` (`retry.ts:74`; `chat.ts:575-591`) — a hung provider hangs the request (retried up to 4 times).
- Module-level mutable caches (`authCache`, `schemaCache`) are unbounded and attacker-keyable (detailed in 02).

### 5.5 Verification-tooling blind spots

162/162 tests pass, lint/type-check clean — yet §5.2's bugs, the alias typo, the health-check bug, and the scraper regex bugs all survive. Causes: mocks replicate implementation rather than platform semantics; no tests assert `/health/providers` against a real-ish multi-instance DO; alias expectations are pinned to the (possibly wrong) table itself (`model-aliases.test.ts` asserts the mapping, not upstream validity); no property/limit tests (max body size, cache growth, concurrent deduction).

## 6. Architectural Weaknesses (Governance)

- **Rate limiting is disabled** on both request-serving routes (documented in `docs/features/rate-limiting.md`; middleware retained but unmounted). The stated reason (KV write cost on free tier) is legitimate; the replacement (nothing) is not.
- **No per-client model authorization.** `ClientConfig` has only `allowZai`; any client can request any model, and unmatched models flow to paid OpenRouter verbatim, including expensive vendor models (see 03 §3.2).
- **Post-paid accounting with no reservation** means the configured ledger balance is a soft ceiling that can be overshot by concurrent in-flight requests (see 02 §4.4).
- **Admin surface is single-factor** (any KV client record with `admin: true`); admin endpoints can zero out pricing (making ledger deductions meaningless), rewrite routing policy, and reset breakers. No audit trail of admin actions exists outside Langfuse LLM traces.

## 7. Dependency & Toolchain Health

| Area | Status |
|---|---|
| Runtime deps | `hono` has advisories (fix available, non-breaking); `zod` fine; `langfuse` v3 unused at runtime (direct ingestion instead) — candidate for removal |
| Dev deps | 23/24 audit findings live here (vitest 2 / miniflare / wrangler 4.54 chain); needs a major-version alignment pass (vitest 5, workers-pool 0.22+) |
| Toolchain | `tsc`, `eslint`, `vitest` all green; `madge` complexity script writes to un-`mkdir`'d `reports/` (would fail on fresh clone) |
| Engines | `node >=18` fine for wrangler; compatibility date `2024-01-01` is old — bump to unlock newer Workers features |
| Docs vs code | package.json says 2.2.0; changelog's latest release is 2.3.0; `spec.md` omits responses route, routing services, 2 of 3 DOs, Fireworks provider; `streaming.md` claims are stale |

## 8. Verdict

The gateway is architecturally sound and unusually featureful for its size (~7.5k LOC src), but it currently **cannot be trusted to protect its own budget**: the spend-limiting features are either disabled (rate limits), broken (health/breaker observability), or racy (ledger). The header-driven routing stack is worth preserving and extending — the DigitalOcean proposal (05) builds on it — but Phase 0 of that plan must close the P0 gaps first, because adding another funded provider multiplies the cost of every governance gap.
