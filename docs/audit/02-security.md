# 02 — Security Audit

Scope: authentication/authorization, input handling, secrets, data egress, resource limits, supply chain. Findings reference `file:line` in the source. Severity: **P0** fix-before-traffic, **P1** fix-before-production-critical, **P2** defense-in-depth, **P3** hygiene.

## 1. Authentication & Authorization

### 1.1 [P0] Unbounded auth cache keyed by attacker input
`src/middleware/auth.ts:15,40-49,63-71`

`authCache` is a module-level `Map<string, CacheEntry>` whose keys are the raw `Authorization` header values supplied by clients. Crucially, **negative results are cached too**: `getClientFromCacheOrKv` stores `null` for unknown keys with a 30s TTL. Expired entries are only evicted on re-lookup of the same key (`fromAuthCache`), so garbage keys accumulate for the lifetime of the isolate. An unauthenticated attacker can send millions of unique `Bearer <random>` values; each allocates a map entry (key + object overhead) → isolate memory growth → Worker kill/OOM. This is a cheap, keyless DoS.

Also: the cache is per-isolate, so (a) key revocation takes up to 30s to propagate per isolate and (b) different PoPs hold different views — acceptable trade-offs, but they should be documented.

**Fix:** cap size (LRU with max entries ~1k), never cache negative lookups (or cache negatives in a fixed-size ring), prefer the cache only for positive results.

### 1.2 [P2] Bearer parsing quirks
`src/middleware/auth.ts:82,113`

`authHeader?.replace('Bearer ', '')` strips the first occurrence of `Bearer ` anywhere in the header (not anchored to the prefix), is case-sensitive, and any auth scheme is accepted (a `Basic dXNlcjog...` header whose decoded form contains `Bearer ` could alias a key). Practical impact is low because the extracted string must exactly match a KV key, but it is sloppy credential handling. Use `startsWith` + case-insensitive scheme check; consider Hono's `bearerAuth` for constant-time comparison (theoretical timing signal from the in-memory Map is not realistically exploitable over the network, but noting for completeness).

### 1.3 [P2] Admin authorization is a single KV boolean
`src/middleware/auth.ts:111-142`, `src/routes/admin.ts`

Any client record with `admin: true` grants: credit balance set/adjust (arbitrary values), pricing overwrite (including $0 — which nullifies all ledger enforcement), routing-policy rewrite, model catalog refresh, breaker reset, and `/admin/usage?key=` reads (returns the **full client record including its API key**, `admin.ts:36-43` — admin keys can be enumerated by another admin, and if this endpoint ever leaked, so could live keys). There is no second factor, no IP restriction, no admin action audit log. An admin key is a crown-jewel credential; treat it accordingly: separate namespace/secret for the admin key, `ALLOWED_ORIGINS`/WAF rule on `/admin`, and structured logging of admin writes.

### 1.4 [P3] API key material handling in scripts and KV design
- `scripts/seed-data.sh` contains a hardcoded sample key `sk-corvo-kinisi-a1b2c3d4e5f6` used as the live KV key name. It is public in the repo; if anyone ever seeds it verbatim, it is a valid published credential. Generate keys at seed time instead.
- `scripts/provision-kinisi.sh` echoes `$KINISI_API_KEY` to stdout (terminal/log capture exposure) and hardcodes a production KV namespace ID.
- API keys are used *as KV key names*, so they appear in any KV listing/debug tooling with key visibility. A hashed-key → config design (e.g., SHA-256 of key as KV key) would keep the plaintext out of storage indexes. Low urgency for a 2–3 client deployment; worth noting for growth.
- `scripts/setup-secrets.sh` omits `MINIMAX_API_KEY`, `FIREWORKS_API_KEY`, `OPENROUTER_PROVISIONING_API_KEY` — deployable state diverges from `Env` requirements.

## 2. Input Handling & Injection

### 2.1 [P1] Caller-supplied regex compiled without limits
`src/services/schema-validation.ts:282-290`

In strict-schema mode, `response_format.json_schema.schema.pattern` is compiled with `new RegExp(schema.pattern)` and tested against model output. A pattern like `(a+)+$` against a long non-matching string causes catastrophic backtracking → CPU exhaustion inside the Worker (per-attempt, × retries, × hedged duplicates). Workers' CPU cap converts this into degraded availability + burned request quota rather than a crash, but it is still an authenticated CPU-amplification vector. The `nosemgrep`/`eslint-disable` comments acknowledge the risk rather than mitigating it.

**Fix:** reject patterns above a length threshold, use a linear-time engine (RE2-style) if available, or timeout-guard the test.

### 2.2 [P1] Unbounded, caller-keyed schema cache
`src/services/schema-validation.ts:3,25-28`

Same pattern as §1.1 but in strict mode: every unique JSON schema body adds a permanent entry to a module-level `Map` keyed by `JSON.stringify(schema)`. Authenticated memory-growth DoS. (The cache also serves no purpose — the stored value is immediately read back and never reused across requests in a meaningful way.)

### 2.3 [P2] Custom JSON-Schema validator: fail-open corners
`src/services/schema-validation.ts`

- Unknown `type` values pass validation (`matchesType` default returns `true`, line 356).
- No `$ref`/`definitions`, `not`, `if/then/else`, `patternProperties`, `multipleOf`, `uniqueItems`, `min/maxProperties` — schemas using them validate **less strictly than the caller asked** (fail-open) with no warning.
- `deepEqual` is `JSON.stringify` equality (line 365): key order matters, so `enum: [{"a":1,"b":2}]` rejects `{"b":2,"a":1}` (fail-closed, but wrong).
- No recursion depth cap on schema×payload nesting → deep payloads can blow the stack.

For a validator whose whole job is *guaranteeing* structure to callers, silent under-validation is a correctness/security issue (callers may trust output shape they did not get). Recommend adopting a real validator (e.g., a maintained JSON-Schema lib compiled per schema with caching) or documenting the supported subset and rejecting unsupported keywords loudly.

### 2.4 [P2] `/v1/responses` forwards unvalidated JSON upstream
`src/routes/responses.ts:69-81,126`

`rawBody` is parsed as JSON and passed verbatim to Fireworks. No Zod schema, no field allowlist, no size limit. Contrast with `chat.ts`, which validates. This is a schema-validation gap and a consistency gap (arbitrary fields → upstream; anything Fireworks later accepts becomes reachable).

### 2.5 [P3] Zod error details returned to clients
`chat.ts:152` (and `admin.ts:235`) return `validationResult.error.errors` verbatim — leaks internal schema shape. Acceptable for an internal gateway; would not be for a public API.

## 3. SSRF & Outbound Request Control

**Good news:** there is **no client-controlled SSRF**. All upstream URLs are hardcoded constants (`router.ts:37,51,64,78,91,109`; `chat.ts:530,769,779`; `responses.ts:113`). Header-driven routing resolves providers through a closed Zod enum (`fireworks | openrouter`) to fixed URLs. KV-sourced routing policy cannot introduce new URLs.

Residual notes:
- Catalog refresh fetches fixed third-party pages (Z.ai docs, MiniMax platform docs, `ai.google.dev`, Fireworks marketing page). URL-fixed, admin/cron-triggered only. No SSRF, but scraping third-party pages is fragile and mildly ToS-relevant.
- `messages[].content[].image_url.url` is forwarded to providers unrestricted (`schemas/chat.ts:11-14`): data-exfil via provider-side fetch is a theoretical channel but it's the provider's fetch; standard for OpenAI-compatible APIs.

## 4. Financial Controls (spend = security surface here)

### 4.1 [P0] Rate limiting disabled + no spend ceilings
`docs/features/rate-limiting.md`; no `rateLimit*` middleware mounted (`index.ts` mounts only CORS; `chat.ts:50-51`, `responses.ts:18-19`).

The only spend protections are: provider credit ledgers, `fallbackStrategy: fail-fast`, and the Z.ai concurrency guard. Consequences detailed in 03 (threat model). Minimum viable control set: body-size cap, `max_tokens` upper bound, per-client model allowlist, and a DO-based per-key request/token limiter (KV-based limiter exists but has a read-modify-write race and would add hot-path KV writes — use the `PROVIDER_CONCURRENCY` DO pattern instead).

### 4.2 [P0] Ledger TOCTOU, ignored failures, no negative balances
- Pre-request check + post-paid deduction (`chat.ts:508-539` check, `:717-727` deduct) → N concurrent requests all pass the check, all consume upstream credit; only the first deduction lands.
- `credit-ledger.ts:83-86` rejects deductions exceeding balance (402) — callers ignore the failure (`chat.ts` never checks `deductCredits().ok`, `credits.ts:59-75` returns `{ok:false}` silently) → consumed-but-unrecorded spend; ledger reads *higher* than reality afterward until the daily OpenRouter sync.
- Net effect: the configured balance is a soft ceiling; real spend can exceed it by the sum of concurrent in-flight requests, and permanently drift if sync only covers OpenRouter.

**Fix:** reserve-then-settle (hold at estimated max cost at acquire time, true-up after usage), or allow bounded negative balance + alert threshold, and *check the deduction result*.

### 4.3 [P1] False credit-exhaustion can permanently flip traffic to paid routing
`credits.ts:85-101`, `chat.ts:596-605`

`isCreditExhaustionResponse` treats any 400/403/429 whose body *mentions* "quota", "billing", "credit balance", etc. as credit exhaustion, then `setCreditBalance(provider, 0)`. A provider quota error (e.g., context-length limit, RPM quota) therefore zeroes e.g. the Anthropic ledger. Since the daily cron only re-syncs **OpenRouter**, direct Anthropic/OpenAI routing stays dark and everything silently rides paid OpenRouter until a human resets the ledger. A single weird upstream error becomes a standing cost leak.

**Fix:** require 402 specifically (or N consecutive confirmations), and add ledger auto-recovery to the cron for all providers, or timestamp-based expiry of the exhausted state.

### 4.4 [P2] Pricing fallback is financially optimistic
`pricing.ts:12` — default $1.00/$2.00 per 1M tokens when KV pricing is absent. Expensive models (Opus-class) can be under-counted ~10×; ledger balance over-states remaining funds. Pricing for most providers must be seeded by hand (`POST /admin/pricing`); nothing does this today except the OpenRouter credit sync (which sets balance, not per-model pricing).

## 5. Data Egress & Privacy

### 5.1 [P1] Full request/response payloads to third-party SaaS
`middleware/telemetry.ts:80-81`, `services/telemetry.ts:99,123-124`

Every LLM request — including complete user conversation content, outputs, and errors — is shipped unredacted to Langfuse US cloud. There is no sampling, no field redaction, no retention config, no per-client opt-out. For an internal-only deployment with non-sensitive workloads this is a product decision; the moment any client sends PII/customer data, this becomes a compliance problem (GDPR/CCPA data-processor questions, retention obligations). At minimum: config flag per client (`telemetry: full | metadata-only | off`), prompt/output truncation caps, and documented retention.

### 5.2 [P1] Upstream error bodies proxied verbatim to clients
`chat.ts:612,746`, `responses.ts:146,242`

Provider error text (which can include upstream org/account IDs, internal request IDs, model names, rate-limit details) is returned as `details` to the gateway caller. Also stored to telemetry (fine). Sanitize/summarize before returning; log the raw body server-side instead.

### 5.3 [P2] CORS reflects any origin by default
`index.ts:20-30`

With `ALLOWED_ORIGINS` unset (current state — not set in either wrangler env), every origin is reflected with credentials-adjacent headers (`Authorization` allowed). For a bearer-token API this is not directly exploitable (browser can't read the key), but it lets any web page a logged-in-user's browser visits fire authenticated requests *if* the page can obtain a key, and it enables probing. Set `ALLOWED_ORIGINS` in production (one line in `wrangler.toml`).

### 5.4 [P3] Streaming passthrough is unvalidated
`utils/streaming.ts` forwards raw upstream bytes. No SSE field injection risk *from our code*, but clients consume whatever upstream emits (including provider-side anomalies). Acceptable for a proxy; note that hono's SSE advisories don't apply since we don't use `streamSSE`.

## 6. Secrets Management

**Good:** no secrets in `wrangler.toml` or the repo; interactive `wrangler secret put` flow; code reads keys only from `env`. Langfuse keys sent via Basic auth over HTTPS to the configured base URL — note `LANGFUSE_BASE_URL` is a plain var; if it were ever misconfigured, Langfuse credentials and payloads go to an attacker-controlled host. Pin/validate it (allowlist the expected host) or make it a secret.

**Gaps:** key-echoing and sample-key issues (§1.4); production KV namespace IDs committed (not secrets, but rot risk if namespaces are recreated — the dev env still points at placeholder IDs, so a naive local `wrangler dev` + seed would write to the wrong place).

## 7. Supply Chain

`npm audit`: **24 findings (2 critical, 17 high, 5 moderate)**. Runtime exposure is limited to `hono` (high; ~40 advisories — JWT confusion, serve-static traversal, SSE/CORS/ReDoS issues — nearly all in middleware this app doesn't mount, but `npm audit fix` resolves it non-breakingly and should be applied). The criticals and remaining highs are dev-chain (vitest 2.x/miniflare/undici/ws/sharp/esbuild). Plan: `npm audit fix`, then a coordinated toolchain bump (vitest 5 + `@cloudflare/vitest-pool-workers` 0.22+ + wrangler latest), then re-run the suite. Also consider removing the unused `langfuse` SDK dependency entirely (telemetry uses raw fetch; the SDK's Workers incompatibility is documented in `project-status.md`).

## 8. Security Control Summary

| Control | Status |
|---|---|
| Transport (TLS to providers, Workers edge) | OK |
| AuthN (per-app keys via KV) | Works, but cache DoS + parsing quirks |
| AuthZ (admin flag) | Single-factor, no audit — P2 |
| Input validation | Chat: good. Responses: none. Strict-schema: fail-open corners + ReDoS |
| SSRF | None (fixed URLs) |
| Rate limiting / spend caps | Effectively absent — P0 |
| Financial integrity (ledger) | Racy + silent failure paths — P0 |
| Data minimization (telemetry) | Not practiced — P1 |
| Secret hygiene | Good in repo/scripts gaps minor |
| Dependency posture | Dev-chain stale; hono fix available |
