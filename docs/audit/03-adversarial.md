# 03 — Adversarial Review

Perspective: "How do I hurt this system's owner?" The gateway holds **funded API keys for six providers** and meters them with soft controls, so the dominant threats are financial, not data-theft. Threat actors ordered by likelihood:

| # | Actor | Capability | Motivation |
|---|---|---|---|
| A1 | Anonymous internet | HTTP only | Vandalism, free LLM access |
| A2 | Client-key holder (legit or stolen) | Valid `sk-corvo-*` key | Maximize personal utility; monetize stolen key |
| A3 | Client-key holder targeting the owner | Valid key + patience | Drain prepaid credits; shift owner's traffic to paid tiers |
| A4 | Admin-key holder / compromised admin key | Full admin API | Anything |
| A5 | Upstream provider misbehavior/errors | Provider API responses | N/A (environmental) |

---

## 1. A1 — Unauthenticated Attacks

### 1.1 Auth-cache memory exhaustion (works today)
**Path:** `POST /v1/chat/completions` with `Authorization: Bearer <random>` × N. Each miss is cached in a module-level Map for 30s with no eviction pressure (`middleware/auth.ts:63-71`). A few thousand requests/minute with unique keys grows the Map without bound for the isolate's lifetime; Workers' 128MB isolate cap turns this into intermittent 1102s / cold-start churn across the POP. Cost to attacker: ~nothing. **No valid key required.** (P0, see 02 §1.1.)

### 1.2 CORS-assisted probing (works today)
Allow-all origin reflection (`index.ts:24-25`) lets any web page drive the gateway from a victim's browser (network position probing, and if a victim's tooling ever embeds a key in a page, exfil). Low value alone; free to do.

### 1.3 What A1 cannot do
Reach providers (auth gates everything), read KV, or hit admin routes. SSRF: none (fixed URLs). Good.

---

## 2. A2 — Authenticated Cost Attacks (the big one)

With one valid key and rate limiting disabled, every scenario below is available **today**:

### 2.1 Volume burn
- No body-size limit: a single request can carry megabytes of prompt content to any provider (passthrough in header mode and `/v1/responses`; `passthrough()` Zod schemas elsewhere).
- No `max_tokens` ceiling: streaming a large completion is one request; the output is fully buffered in isolate memory for telemetry (`chat.ts:352`) — so a giant stream is simultaneously a **spend** vector and a **memory** vector.
- Parallelism is unconstrained (concurrency guard exists only for Z.ai, legacy mode only): 50 concurrent streams from one key is fine.

### 2.2 Model-selection arbitrage
- Legacy mode: unmatched models fall through to OpenRouter **with the raw string** (`router.ts:107-117`). `model: "anthropic/claude-opus-4.8"` or any expensive `vendor/model` on OpenRouter is invocable. `model.includes('gpt')`/`includes('claude')` substring matching means crafted names steer direct routing too.
- Header mode: `x-kinisi-model` **overrides the policy's model profiles entirely** (`route-planner.ts:90-97`), so a client can pin any Fireworks/OpenRouter model while enjoying the hedged low-latency path (which doubles spend on hedges).
- `/v1/responses` forwards any `model` string to Fireworks with no allowlist.

### 2.3 Amplifiers
- **Hedging** (`week_n` + `speed` + primary role) runs two upstream requests; the loser is never aborted (`route-executor.ts:206-274`) — both bill.
- **Retries** (`fetchWithRetry`, max 3 retries on 429/5xx/timeouts) re-send POSTs that may have succeeded upstream → double-billing on timeout-class failures.
- **Strict-schema loops**: `schema_invalid` marks attempts non-retriable but the executor moves to the *next candidate* — so a schema the models can't satisfy forces attempts across the whole candidate chain (each a real upstream call) before 422.
- **Deduction under-counting**: concurrent requests + rejected negative deductions + ignored `{ok:false}` mean the ledger under-counts exactly when spend is heaviest (03 §4.2 in 02-security) — the attacker's effective budget is larger than the configured one.

**Composite:** a stolen key with a cron job can reliably extract ≈ (configured balance + concurrency overshoot + under-counted deductions) of provider spend per day, invisible until provider invoices exceed the ledger.

---

## 3. A3 — Targeted Sabotage of Cost Routing

### 3.1 "Quota"-string poisoning → forced paid routing (works today, my favorite)
`isCreditExhaustionResponse` (`credits.ts:85-101`) marks a provider's ledger zeroed if a 400/403/429 body *mentions* "quota"/"billing"/"credit balance". An A3 client can *provoke* such errors deterministically — e.g., send `claude-*` requests with oversized context to elicit Anthropic's quota/context-limit 400s — until `markProviderCreditsExhausted('anthropic-direct')` fires (`chat.ts:596-605`). Result: **all** Claude traffic silently reroutes to paid OpenRouter and stays there (cron only re-syncs OpenRouter's ledger). The owner pays real money for weeks and the only signal is a Langfuse provider-distribution drift. Repeatable against openai-direct (needs an OpenAI 4xx mentioning quota) and minimax.

### 3.2 Header-mode constraint abuse
`x-kinisi-provider-block: fireworks` + `x-kinisi-provider-prefer: openrouter` + `strategy: quality` pins every request to the most expensive policy chain. Legitimate-looking, indistinguishable from a misconfigured client, and billed 100% to paid OpenRouter.

### 3.3 Z.ai concurrency starvation (DoS, bounded)
Legacy-mode Z.ai leases pin for up to 15min (`provider-concurrency.ts:23`). A2/A3 opening a handful of glm streams and dripping tokens keeps `glm-4.7-flash` (limit 1) pinned → other clients get 429 "Provider concurrency limit reached". Bounded by lease TTL and in-memory state (DO eviction resets it), but it's a cheap availability attack on the free-credit path. Counter-intuitively, the in-memory-only DO is also the *mitigation* here — a persisted version would need TTL enforcement to be safe.

---

## 4. A4 — Admin-Compromise Scenarios

One `admin: true` KV record (and the key echoes to stdout in `provision-kinisi.sh`) yields, via the admin API:
- `POST /admin/pricing` with `{"input": 0, "output": 0}` → ledger deductions become zero → unlimited free usage for every client, forever, with the ledger *appearing* healthy.
- `POST /admin/credits/set` with balance `1e9` → same effect via balance instead of pricing.
- `POST /admin/routing-policy` → force all traffic through any allowed chain (still only fireworks/openrouter — no URL injection, the schema enum saves us here).
- `GET /admin/usage?key=<anyKey>` → **returns the full client record including other apps' API keys** (`admin.ts:36-43`); an admin key therefore effectively compromises all client keys.

No admin audit trail exists (only LLM traces), so persistence/dwell is easy. Mitigations: dedicated admin secret outside the client KV namespace, restrictive CORS/WAF on `/admin`, log all admin mutations, stop returning keys from `/admin/usage`.

---

## 5. A5 — Environmental / Upstream Abuse

- **Catalog poisoning by upstream drift**: OpenRouter-derived catalog IDs aren't normalized to direct-provider formats; clients picking catalog models can generate recurring upstream 404s. 5 consecutive failures open the provider's circuit for 60s (`circuit-breaker.ts:137-140`) — a client unknowingly using stale IDs can keep a *working* provider dark by retrying (requests fail fast to fallback, so the cost is quality degradation + paid fallback, not outage).
- **Alias table as attack surface**: `gpt-4*` → `gpt-5-2` (typo?) means every legacy gpt-4 request may hard-fail against OpenAI (and burn circuit-breaker failures) — or silently upgrade clients to pricier models (`glm-4*` → `glm-5`). Whoever controls that table controls everyone's models; it's code, not config.
- **Scraping dependencies**: Z.ai/MiniMax/Gemini/Fireworks HTML catalogs break silently when those sites change (two regexes are *already* dead — `models-catalog.ts:199,339`). Failure mode is benign today (fallback lists) but means `/v1/models` lies to clients.
- **Langfuse as data sink**: telemetry ships full payloads to a third party; an attacker who later compromises the Langfuse project (weak sharing settings, leaked LF keys) obtains the *entire conversation history* of every app. Treat Langfuse as in-scope for threat modeling (and as the PII store it effectively is).

---

## 6. Attack Trees (condensed)

```
Drain owner funds
├── [A2] leaked key
│   ├── high-volume streams (no max_tokens cap) ............ works
│   ├── expensive model pinning (x-kinisi-model / raw OR id) . works
│   ├── concurrency overshoot (post-paid ledger race) ........ works
│   └── hedge + retry amplification .......................... works
├── [A3] legit key
│   ├── quota-string poisoning → permanent paid fallback ...... works
│   ├── provider-block headers → force paid chain ............. works
│   └── strict-schema candidate-chain burn .................... works
└── [A4] admin key
    ├── pricing → $0 ......................................... works
    └── credits/set → huge balance ........................... works

Deny service
├── [A1] auth-cache flooding ................................. works
├── [A3] Z.ai lease pinning .................................. works (TTL-bounded)
└── [A2] schema-cache flooding (strict mode) ................. works
```

## 7. Highest-Leverage Defenses (ranked by (impact ÷ effort))

1. Bound the auth cache + stop caching negatives (kills A1 DoS). ~30 lines.
2. Request caps: body size, `max_tokens`, messages size/count (kills most A2 volume). Zod additions + one Hono middleware.
3. Per-client model allowlist in `ClientConfig` + exact-match routing (kills model arbitrage).
4. Ledger reserve-then-settle + honor `deductCredits` result + provider-agnostic recovery sync (kills overshoot, drift, and 3.1).
5. Retire the exhaustion heuristics in favor of explicit 402 detection with N-strike + TTL.
6. Admin split: separate admin credential + audit logging + stop returning keys from `/admin/usage`.
7. Abort losing hedges; propagate client disconnects to upstream readers; pass `AbortSignal` into `fetchWithRetry`.
