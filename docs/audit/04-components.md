# 04 — Component-by-Component Audit

Each component: purpose, findings (F = functional, S = security), test status, recommendation. Severity markers P0–P3 per the [README](./README.md) legend.

---

## 4.1 Entry Point — `src/index.ts` (93 LOC)

Mounts CORS, six route modules, the cron handler, and exports the three DO classes.

- **[F/P3] Version says 2.2.0** (`index.ts:62`) while the changelog's latest tagged release is 2.3.0 — the version string was never bumped.
- **[S/P2] CORS reflects any origin by default** (`index.ts:24-25`); `ALLOWED_ORIGINS` is not set in any wrangler env. Also `origin` callback returns `origin || '*'`, echoing arbitrary origins verbatim.
- **[F/P2] `scheduled` handler swallows errors per-stage** (good) but logs with `console.error` only — no alerting hook; a silently-broken daily catalog/credit sync is discoverable only by symptom.
- **[F/P3] No global `app.onError`/`notFound` handler** — framework defaults produce Hono's plain 404/500 text; error responses are inconsistent with the JSON error contract used elsewhere.

Coverage: indirectly via `tests/unit/index.scheduled.test.ts` (cron only).
**Recommendation:** set `ALLOWED_ORIGINS` in prod; add JSON error/404 handlers; wire cron failures into telemetry/logs worth alerting on.

## 4.2 Auth Middleware — `src/middleware/auth.ts` (148 LOC)

KV-backed key lookup with a 30s module-level cache; separate admin middleware checking `admin` flag.

- **[S/P0] Unbounded attacker-keyed cache, negatives cached, lazy-only expiry** — full analysis in 02 §1.1 / 03 §1.1. This is the audit's top security finding.
- **[S/P2] `replace('Bearer ', '')` prefix handling** (02 §1.2).
- **[F/P3] Cache TTL `AUTH_CACHE_TTL_MS` is a footgun**: setting it high amplifies revocation lag and (given finding #1) memory retention. No upper bound is enforced.
- **[S/P2] `/admin/usage?key=` returns full client records including other keys** (`routes/admin.ts:36-43`) — see 03 §4.

Coverage: `tests/unit/auth.test.ts` (5 tests) — happy paths only; no cache-growth, TTL-boundary, or header-parsing edge tests.
**Recommendation:** LRU with max entries; positive-only caching; prefix parsing; treat admin as separate credential class.

## 4.3 Chat Route — `src/routes/chat.ts` (889 LOC)

The heart of the system: legacy + header-driven flows. Highest-complexity file (≈12% of src LOC).

- **[F/P1] Dual-flow divergence** — different credit-check rules (legacy exempts openrouter from the `balance <= 0` check at `chat.ts:509`; header mode doesn't), different header contracts, different retry engines. See 01 §5.1.
- **[S/P1] Upstream error text returned to clients** (`chat.ts:612` `details: errorText`; `:746` exception message).
- **[S/P0-contributing] No body/`max_tokens`/messages-size limits** anywhere in the path; Zod schema is `passthrough()` with unbounded strings.
- **[F/P1] `transformStreamChunk` never called** (grep-verified: only definitions exist) → streaming emits raw upstream bytes; Anthropic-format providers (anthropic-direct, minimax) produce non-OpenAI SSE to clients. Docs claim normalization. Either wire adapters into `createStreamingResponseWithUsage` or delete the dead methods and document raw passthrough.
- **[F/P2] Whole-stream buffering for telemetry** (`streamOutput += chunk`, `chat.ts:352,643`) — unbounded per-request memory.
- **[F/P2] Legacy provider fetch has no timeout** — `fetchWithRetry` receives no `signal` (`chat.ts:575-591`; `utils/retry.ts:74` never applies one).
- **[S/P0-contributing] Post-paid deduction with pre-check race; `deductCredits` result ignored** (`chat.ts:717-727` — return value never checked).
- **[F/P2] Streaming concurrency-lease release depends on content-type sniffing** (`chat.ts:680-684`): if upstream returns SSE without the exact content-type, the lease is released immediately while the stream is still in flight (over-admission); if the client disconnects, whether `onDone`/`onError` fire depends on stream cancellation behavior (no `cancel()` handler exists in `utils/streaming.ts`) — the lease and telemetry-finalization paths on abort are best-effort at best.
- **[F/P3] Header mode acquires no concurrency lease at all** (inconsistent with legacy).
- **[F/P3] `getRawModel`/telemetry `updateTelemetryMetadata(c,'unresolved',...)` then re-update with winner — fine, but failure paths can leave provider `unresolved` in traces (cosmetic).
- **[F/P3] Recursive credit-fallback re-entry** (`handleLegacyRequest(..., hasRetriedCreditFallback=true)`, `chat.ts:604`) is correctly single-shot — verified safe.
- **[F/P3] Response schema validation is warn-only** (`chat.ts:706-709`) — malformed upstream responses pass through; intentional (fail-open) but undocumented.

Coverage: `tests/unit/routes/chat.test.ts` (15 tests) — good happy-path and credit-fallback coverage; mocks don't exercise stream-abort, concurrency-lease edge cases, or deduction races.
**Recommendation:** this file should be split (legacy flow vs header flow into separate modules sharing a composed pipeline); unify credit/concurrency/header semantics; add limits; sanitize error passthrough.

## 4.4 Responses Route — `src/routes/responses.ts` (249 LOC)

Fireworks `/v1/responses` passthrough proxy with credits and breaker integration.

- **[S/P1] No request validation** — `c.req.json()` result forwarded verbatim (`responses.ts:69-81,126`); invalid JSON yields an unhandled throw (framework 500, not the JSON error contract).
- **[F/P2] Uses legacy `X-Corvo-*` headers** (`responses.ts:99-101,202-203,231-232`) instead of `x-corvo-cortex-*` — inconsistent client contract; `docs/fireworks.md` documents the old names.
- **[F/P2] No model allowlist** — any model string goes to Fireworks.
- **[F/P3] `balance` snapshot taken pre-request and reused for the deduction decision post-stream** (`responses.ts:97,174,220`) — same TOCTOU shape as chat.
- **[F/P3] No concurrency lease for Fireworks** anywhere.

Coverage: `tests/unit/routes/responses.test.ts` (1 test — header absence check only). This route is essentially untested.
**Recommendation:** add a Zod schema (Responses API subset), unify headers, add limits; fold into the shared route pipeline.

## 4.5 Models Route — `src/routes/models.ts` (57 LOC)

Serves merged catalog with provider/modality filters.

- **[F/P2] Advertises unroutable/misroutable IDs**: OpenRouter-derived entries have vendor prefixes stripped but IDs aren't normalized to direct-provider formats; Gemini entries (no gemini provider exists in `router.ts`) fall through to OpenRouter **without** the `google/` prefix → upstream 4xx. Catalog and router disagree about the model universe.
- **[F/P3] Hardcoded `gpt-5.2` default/fallback** (`models.ts:42,45`).
- **[F/P3] Filter miss falls back to the full catalog** (`models.ts:35`) — querying `provider=gemini` when the filter yields nothing returns *everything*, which surprises clients.

Coverage: 6 tests (filtering, defaults). **Recommendation:** only advertise models resolvable by the router; key the catalog by routable ID; fail empty rather than fail-open.

## 4.6 Health Route — `src/routes/health.ts` (69 LOC)

- **[F/P0] `/health/providers` is structurally broken**: it queries `idFromName('status')` (`health.ts:21`) — a *different* DO instance than the per-provider breakers — and since breaker state is never loaded from storage anywhere, the status instance's in-memory Map is always empty. The endpoint always returns `{breakers: []}` regardless of reality.
- **[F/P2] Health requires admin auth** — standard monitoring (uptime checkers) can't use it without holding the most powerful credential.

Coverage: 8 tests pass against a mock that *does* aggregate correctly — the mock's fidelity gap is exactly what hides the bug. **Recommendation:** single breaker DO instance owning all providers' state (it's low-volume), or a status index in KV; expose a lightweight unauthenticated `200 ok` liveness probe plus the admin detail endpoint.

## 4.7 Admin Route — `src/routes/admin.ts` (245 LOC)

Credits get/set/adjust/sync, pricing get/set, catalog refresh, routing-policy get/set, usage, clients (placeholder).

- **[S/P2] Admin is single-factor; mutations unaudited** (02 §1.3, 03 §4). `POST /admin/pricing` accepts **any** numeric pricing incl. 0 — turning the ledger into a no-op. No bounds validation on `credits/set` (negative balances allowed — legitimate operation, but combined with no audit trail, indistinguishable from sabotage).
- **[F/P2] `/admin/clients` is a documented placeholder** (`admin.ts:75-82`); `/admin/usage` without `key` iterates a hardcoded `['sk-corvo-kinisi-xxx']` placeholder list (`admin.ts:48`).
- **[F/P3] Pricing/catalog/routing-policy writes have no concurrency control or change history** — a bad policy write is recoverable only via `rollback-routing-policy.sh` (which just deletes the key).
- **[F/P3] `POST /admin/models/refresh` runs the whole multi-provider refresh synchronously** — long-running scraping chain in a request; can hit Workers duration limits.

Coverage: 11 tests. **Recommendation:** bound and log admin mutations; add a proper client index (KV list prefix or a registry key); move refresh to cron-only or queue semantics.

## 4.8 Analytics Route — `src/routes/analytics.ts` (67 LOC)

Three endpoints returning Langfuse dashboard pointers. Documented as intentional placeholders. No findings beyond "not analytics." Coverage: 5 tests. **Recommendation:** either build (Langfuse API aggregation) or hide the routes to reduce confusion.

## 4.9 Router Service — `src/services/router.ts` (118 LOC)

Legacy provider selection: Fireworks preemption → Z.ai → Anthropic (credit flag) → OpenAI (credit flag) → MiniMax (credit flag) → fallback strategy.

- **[F/P1] Substring model matching** (`router.ts:48,61,75,88`): `includes('glm')`, `includes('claude')`, `includes('gpt')`, `/^o\d/`. "my-gpt-proxy", "not-claude" route to direct providers and hard-fail; valid OpenRouter-style IDs ("openai/gpt-5") route direct and fail (OpenAI expects un-prefixed IDs — partially rescued by aliasing, but that's accidental).
- **[F/P2] Fireworks preemption does a KV read per request** (`router.ts:32` → `getFireworksModelCatalog`) — hot-path KV read + latency; combined with policy KV read and ledger DO calls, a legacy request costs 3–5 storage round-trips before the provider fetch.
- **[F/P3] MiniMax endpoint is the Anthropic-compatible surface** (`router.ts:91`) with `anthropicAdapter` — clever, but tool/multimodal loss from the adapter applies (see 4.14).
- **[F/P3] Z.ai URL is the "coding" PaaS endpoint** (`router.ts:51`) — couples gateway traffic to a product-specific endpoint; a Z.ai reorg breaks all glm routing.

Coverage: 8 router tests (routing table, credit flags). **Recommendation:** exact-match against the catalog (which already exists in KV) with a configurable alias layer; cache the fireworks catalog in isolate memory with a short TTL.

## 4.10 Routing Policy / Hints / Planner — `services/routing-policy.ts` (164), `routing-hints.ts` (109), `route-planner.ts` (165)

The header-driven stack's configuration layer.

- **[F/P1] `x-kinisi-model` (and body `model`) override policy model profiles** (`route-planner.ts:90-97`): `requestedModel || policy.modelProfiles[...]`. The policy matrix controls *providers* but not *models* whenever the caller names one. This makes per-route cost governance advisory, not enforceable (03 §2.2).
- **[F/P2] Routing providers are a closed enum `fireworks|openrouter`** (`schemas/routing-hints.ts:5`) — extending providers (e.g., DigitalOcean, 05) requires touching the enum, the policy schema, the resolver (`chat.ts:765-787`), and the default matrix. Fine, but currently undocumented as an extension point.
- **[F/P3] `constraintsIgnored` semantics**: when allow/block filters empty the candidate list, base candidates are used anyway (`route-planner.ts:52-57`) — the caller's constraint is silently violated (flagged in telemetry but honored in behavior). A fail-closed option would be safer for callers relying on, e.g., `provider-block: fireworks`.
- **[F/P3] `getRoutingPolicy` falls back to the built-in default on any parse failure** (`routing-policy.ts:106-109`) — a malformed policy write silently reverts routing to defaults with no signal.
- **[F/P3] Kinisi-hint enablement is "any header present"** (`routing-hints.ts:70-72`) — a stray header from a proxy flips a request into header mode. Acceptable given the policy gate, worth documenting.

Coverage: strong — 7 hints + 6 planner + 5 policy tests. **Recommendation:** per-policy model allowlists that win over caller hints (or an explicit "caller may pin models" flag); fail-closed option for constraints; alert on policy parse fallback.

## 4.11 Route Executor — `src/services/route-executor.ts` (480 LOC)

Candidate chain execution: per-candidate retry with backoff, latency-budget timeouts, optional 2-way hedge race, pluggable validation.

- **[F/P2] Losing hedged attempts are never aborted** (`runHedged`, lines 206-274): when one leg wins, the other keeps fetching (and billing) in the background; orphaned streams also hold Z.ai leases if this path ever grows one.
- **[F/P3] AbortController shim degrades silently** (`createAbortController`, 432-448): without global `AbortController`, `abort()` flips a flag nothing reads — timeouts vanish. Workers have AbortController, so this only bites in tests/other runtimes — where it currently *does* run (vitest workers pool provides it; fine).
- **[F/P3] Hedge resume logic assumes candidate indices 0/1** (`startCandidateIndex = hedgeUsed ? 2 : 0`, line 141) — correct today, brittle if hedge policy ever widens.
- **[F/P3] Retry backoff is deterministic** (no jitter, unlike `utils/retry.ts`) — thundering-herd on provider recovery.
- **[S/P3] Failure `message` strings (upstream error text) flow into attempt records → returned to clients in `reason_codes`-adjacent fields** (message itself is only logged/telemetered — client gets structured `class`/`reason_codes`; OK).

Coverage: excellent (14 tests incl. dedicated hedge suite). The best-tested module. **Recommendation:** abort losers via `AbortController` per attempt (already created — wire it into the attempt callback contract); add jitter.

## 4.12 Schema Validation Service — `src/services/schema-validation.ts` (367 LOC)

Hand-rolled JSON-Schema subset validator for strict output mode.

- **[S/P1] `new RegExp(caller pattern)`** (282-290) — ReDoS (02 §2.1).
- **[S/P1] Unbounded caller-keyed cache** (3, 25-28) (02 §2.2).
- **[S/P2] Fail-open corners and semantic bugs** (02 §2.3): unknown types pass; `deepEqual` is key-order-sensitive; no `$ref`/`not`/etc. with no warning; no depth cap.
- **[F/P3] `errors.length > 0` early-returns inside `allOf`/`properties` loops** mean error *reporting* is first-failure-only (fine) but also that `allOf` short-circuit differs from spec (validation must satisfy all; short-circuit on error is fine — this is OK, noted for reviewers).
- **[F/P2] Streaming + strict mode is rejected by design** (`chat.ts:186-199`) — correct trade-off, documented.

Coverage: 6 tests + integration schema tests. **Recommendation:** replace with a vetted validator compiled-per-schema (cache compiled validators, not raw schemas); cap pattern length; enforce depth limit. If the subset must stay, reject unsupported top-level keywords loudly.

## 4.13 Catalog Services — `services/models-catalog.ts` (589), `services/fireworks-models.ts` (102)

Multi-provider catalog refresh to KV; daily cron + admin trigger.

- **[F/P1] Dead regexes from escaping bugs**: `models-catalog.ts:199` `/^(gpt-5|gpt-5\\.|gpt-5-)/` — `\\.` matches a literal backslash, so the intended `gpt-5.` alternative never matches (rescued only because `gpt-5` prefix already matches). `models-catalog.ts:339` `/glm-4\\.7(?:-flashx|-flash)?/gi` matches *nothing real* → the Z.ai docs scrape can never contribute; catalog is permanently the hardcoded fallback. Same anti-pattern risk wherever `\\.` appears in regex literals.
- **[F/P2] Catalog-to-router ID mismatch**: OpenRouter subsets strip `vendor/` (`deriveOpenRouterSubset`, 542-589) but don't normalize to each direct provider's ID grammar; `provider` labels on those records say `openai`/`anthropic` while the IDs are only guaranteed valid *on OpenRouter* (see 4.5).
- **[F/P2] HTML scraping as a first-class data source** (Z.ai docs page, MiniMax platform docs, `ai.google.dev` models page, Fireworks marketing page) — fragile, ToS-gray, and unparsable-failure modes (already silently failing for Z.ai).
- **[F/P3] `expirationTtl` 30 days** on catalog keys: a cron broken for >30d silently empties the catalog (and `isFireworksModel` → false disables Fireworks preemption; fail-open to paid).
- **[F/P3] `fetchZaiModels` name "normalization" is a no-op** (`name.toUpperCase().replace('GLM-','GLM-')`, line 355) — leftover code.
- **[F/P3] No validation of upstream JSON shapes before spreading into KV** (`as` casts throughout) — malformed upstream data becomes trusted catalog data.

Coverage: 1 scheduled-handler test + `models-catalog.test.ts` (9 tests, mock-fetch based). **Recommendation:** prefer real APIs everywhere (OpenRouter's list already covers most needs); delete scraping; add ID-normalization tests per provider; alarm when a refresh produces zero models.

## 4.14 Provider Adapters — `providers/*` (anthropic 145, zai 108, openai 35, openrouter 39, base 71) + `utils/transform.ts`

Request/response translation per provider.

- **[F/P1] Multimodal content silently destroyed for Anthropic/Z.ai/MiniMax**: `messageContentToText` flattens `image_url` parts away (`anthropic.ts:134-143`, `zai.ts:97-106`) — image inputs to claude/glm are dropped without error. For an OpenAI-compatible facade this is a correctness landmine (clients see success with degraded input).
- **[F/P2] Tool-calling fields dropped in Anthropic-family transforms** (`transformRequest` builds a fixed field set; `tools`, `tool_choice`, `tool` role messages are discarded/passthrough-mismatched) — Anthropic rejects raw `role:'tool'` messages; MiniMax inherits the same behavior.
- **[F/P1] `transformStreamChunk` is dead code in all adapters** (grep-verified) — see 4.3.
- **[F/P3] Z.ai adapter silently defaults `temperature: 0.7`** (`zai.ts:19`) — mutates request semantics when temperature omitted; other providers don't.
- **[F/P3] Only the first `system` message is honored** for Anthropic (`find`, `anthropic.ts:13`); additional system messages are dropped.
- **[F/P3] OpenRouter adapter's `transformStreamChunk` appends `\n` to `data: ` lines** — would corrupt framing if it were ever called (currently dead).
- **[F/P3] `getAdapterForProvider` maps minimax→anthropicAdapter, fireworks→openaiAdapter** — correct today; add a comment when adding providers.

Coverage: `tests/integration/providers.test.ts` (7) + transform tests (5). **Recommendation:** either invest in true per-provider normalization (including streaming) or narrow the facade (reject image/tool inputs for providers that can't serve them with a 4xx instead of silently dropping).

## 4.15 Durable Objects

### `durable-objects/circuit-breaker.ts` (219)
- **[F/P0] Persistence is write-only**: `saveState` does `storage.put` (never awaited) but nothing ever calls `storage.get` — after any DO restart/hibernation, all breakers reset to closed. The comment "Persist to DO storage for recovery across restarts" (line 204) is false.
- **[F/P2] `halfOpenMaxCalls` (line 19) is never enforced** — half-open admits unlimited concurrent probes; combined with threshold-5 opening, a failing provider can flap.
- **[F/P2] Non-async error handling**: `fetch` returns `this.handleCheck(request)` inside `try/catch` (lines 37-48) — promise rejections bypass the catch; the 500 path is mostly dead.
- **[F/P2] One DO instance per provider** (`idFromName(provider)` at call sites) — makes aggregation (health) awkward and is the root cause of the `/health/providers` bug (4.6).
- **[S/P3] `provider` string from request body is used as a storage key** (`breaker:${provider}`) — internal-only surface (DO not exposed externally), fine.

Coverage: 6 tests (state machine, mock storage read back by the same object — masking the persistence bug). **Recommendation:** load state lazily from storage in `getOrCreateState`; collapse to a single instance; enforce half-open cap; await writes.

### `durable-objects/credit-ledger.ts` (122)
- **[S/P0-contributing] Rejects over-balance deductions** (402, lines 83-86) and callers ignore it → unrecorded spend (02 §4.2).
- **[F/P3] No idempotency/reservation endpoints** — single-threaded per-object execution makes each call atomic (good), but the reserve-then-settle pattern needed by callers doesn't exist.
- **[F/P3] Currency field is cosmetic** — openrouter is set to `'credits'` (actually USD amounts) while others use `'USD'`; `estimateCostFromUsage` always returns USD. Works by coincidence; misleads anyone reading balances.
- **[F/P3] Indentation anomalies** (4-space blocks at lines 48-53, 66-71, 88-93) — cosmetic, suggests hasty edits.

Coverage: none dedicated (exercised via mocks). **Recommendation:** add `/reserve`+`/settle` (or negative-balance floor + alert), return-and-log declined deductions, unify currency semantics.

### `durable-objects/provider-concurrency.ts` (190) + `services/provider-concurrency.ts` (148)
- **[F/P2] All state in plain Maps — zero persistence** (`provider-concurrency.ts:25-26`): DO eviction resets counters mid-load (over-admission to Z.ai); leases vanish while upstream work continues. The 15-min lease TTL self-heals, but the guard is best-effort by construction — worth documenting as intentional fail-open rather than a bug, and it currently *isn't* documented.
- **[F/P3] Z.ai limits table is hardcoded code** (`services/provider-concurrency.ts:5-33`) — provider-side limit changes require deploys; should be KV config.
- **[F/P3] `cleanupExpiredLeases` is O(n) per operation** — fine at this scale.
- **[F/P3] Fail-open on DO errors** (`services/provider-concurrency.ts:93-95,106-112`) — reasonable; logged only.

Coverage: 5 service tests + mock DO. **Recommendation:** persist counters via `storage` on change (cheap at this write rate), or document the fail-open contract; move limits to KV.

## 4.16 Middleware — Telemetry (`middleware/telemetry.ts` 249) & Rate Limit (`middleware/rate-limit.ts` 161)

**Telemetry:**
- **[S/P1] Full payload egress** (02 §5.1): `input`/`output` include complete user content; no redaction/truncation/opt-out; cost estimation duplicated with the credit path (two pricing KV reads per request).
- **[F/P2] `extractResponseData` clones and fully buffers the response** when `responseData` wasn't stored (line 210-227) — another unbounded-ish memory path for non-JSON bodies.
- **[F/P3] Deferred-completion design is sound** (stream finalization gates trace creation; `waitUntil` + await both reference one promise) — good.
- **[F/P3] `isKnownProvider` whitelist** (176-186) — new providers must be added here or traces lose cost data (extension point for 05).

**Rate limit (unmounted):**
- **[F/P3] KV read-modify-write race undercounts** concurrent requests (both middlewares) — moot while disabled, relevant if re-enabled.
- **[F/P3] Token estimator is whitespace-based** (`estimateTokens`) — a 1MB no-space prompt counts as ~1 token; and only request tokens are estimated (completion tokens ignored entirely).
- Kept-for-future status is documented; if re-enabled, prefer the DO-based limiter (02 §4.1).

Coverage: telemetry 3 tests + middleware tests; rate-limit 4 tests. **Recommendation:** add payload caps + per-client telemetry mode; delete or rebuild rate limiting on a DO.

## 4.17 Schemas — `schemas/*`

`chat.ts`: `passthrough()` on messages and request root — deliberate OpenAI-compat flexibility, but it means **no structural limits** and unknown fields flow upstream (including to strict providers). `response.ts`: warn-only usage. `routing-policy.ts` / `routing-hints.ts`: tight enums, good. **Recommendation:** add size/count ceilings in `chat.ts` (e.g., `max()`, string length caps), keep passthrough for extension fields.

## 4.18 Utils

- `utils/retry.ts` (116): retries POSTs on timeout-class errors → possible double-billing; no `AbortSignal` support (hot-path impact, 4.3); `response.clone().text()` buffers error bodies (bounded in practice). Jittered backoff: good.
- `utils/streaming.ts` (173): no `cancel()` handler (client disconnects don't propagate upstream); `buffer.split('\n')` per chunk is O(line) — fine; usage captured once (`usageReported`) — first usage object wins, which can be wrong for providers emitting per-chunk usage.
- `utils/model-aliases.ts` (50): **`gpt-4*` → `gpt-5-2`** (line 31) — inconsistent with `gpt-5.2` used in `routes/models.ts:42,45`; one of them is wrong, and if it's the alias, every gpt-4 request hard-fails upstream. `glm-4*` → `glm-5` silently upgrades clients (and DO's newer `glm-5.3-flash` is cheaper — see 05 §4). Table is code, not config. **[F/P1]**
- `utils/logger.ts` (136): **dead code** — never imported.
- `utils/headers.ts` (62): **dead code** (rate-limit header helpers, never imported).
- `utils/corvo-cortex-headers.ts` (55): clean; `'unknown'` sentinel strings are a reasonable contract.
- `utils/transform.ts` (27): fine.

## 4.19 Tests — `tests/` (30 files, 162 tests)

- **Strengths:** broad route/service coverage; dedicated hedge suite; integration schema/provider suites; clean mock env with DO stubs.
- **[F/P1] Mock-fidelity gaps hide production bugs**: mock DOs are single in-process objects — they don't model per-`idFromName` isolation (hides `/health` bug), storage persistence/eviction (hides breaker write-only bug), or lease TTL semantics.
- **[F/P2] No dedicated coverage** for `credit-ledger.ts` DO, `services/credits.ts` (sync logic), `services/pricing.ts`, `services/fireworks-models.ts` (regex paths), `routes/responses.ts` (1 test), concurrency-lease stream lifecycle.
- **[F/P2] No adversarial/limit tests**: no max-body, cache-growth, concurrent-deduction, or malformed-upstream-response cases — precisely the classes where bugs were found.
- **[F/P3] Tests validate the alias table against itself** (mapping pinned in tests matches the code, so a wrong ID like `gpt-5-2` passes).
- Coverage is configured (80% thresholds per AGENTS.md); the *un*covered set correlates strongly with the bug set above.

## 4.20 Config, Scripts & Docs

- **`wrangler.toml`**: dev KV IDs are placeholders (correct); **production KV IDs committed** (not secrets; rot risk); no `[env.preview]` despite preview namespace IDs and docs referencing a preview deploy; `ALLOWED_ORIGINS` unset in both envs; `compatibility_date = 2024-01-01` is ~2 years stale; cron daily 00:00 UTC; DO migrations v1–v3 use `new_sqlite_classes` (correct per CF requirement, per commit `a05858a`).
- **`scripts/`**: `seed-data.sh` hardcodes a public sample key; `provision-kinisi.sh` echoes the real API key and hardcodes the prod namespace ID; `setup-secrets.sh` misses 3 of 7 required secrets (02 §1.4).
- **`docs/`**: version drift (2.2 vs 2.3), `spec.md` missing responses/routing-services/2 DOs/Fireworks, `streaming.md` claims SSE normalization (false) and live rate limiting (false), `project-status.md` provider table omits Fireworks and its "Recent Commits" ends 2026-01. The docs are good *when* accurate — currently ~15% misleading.
- **`package.json`**: `langfuse` runtime dep is unused (raw fetch used instead) — removable; `analyze` chain assumes `reports/` exists.

---

## Component Health Scorecard

| Component | Grade | Blocking issues |
|---|---|---|
| index/CORS | B− | CORS default |
| auth middleware | D+ | Cache DoS (P0) |
| chat route | C− | Limits, deduction race, error leak, dead stream transform |
| responses route | C | No validation, no tests |
| models route | C | Unroutable catalog IDs |
| health route | F | Always-empty status (P0) |
| admin route | C+ | Single-factor, unaudited |
| router (legacy) | C | Substring matching |
| policy/hints/planner | B+ | Model-pin override |
| route executor | A− | Hedge cancellation |
| schema-validation | C− | ReDoS, cache, fail-open |
| catalogs | C | Dead regexes, ID mismatch |
| provider adapters | C | Multimodal loss, dead stream transform |
| circuit breaker DO | D | Write-only persistence, health isolation |
| credit ledger DO | C | Overdraft semantics |
| concurrency DO | C+ | In-memory only (document as intentional) |
| telemetry | B− | Payload egress |
| rate limit (disabled) | B | n/a while disabled |
| schemas | B | Missing size limits |
| tests | B− | Fidelity gaps |
| config/scripts/docs | C | Secret hygiene, drift |
