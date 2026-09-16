# Corvo Cortex Codebase Audit — September 2026

**Audit date:** 2026-09-15
**Codebase state:** v2.2.0 (package.json), dormant since 2026-03-04 (~6.5 months)
**Scope:** Full architecture review, functional + security audit, adversarial review, component-by-component evaluation, and a DigitalOcean inference integration proposal.

## Report Index

| Document | Contents |
|---|---|
| [01-architecture.md](./01-architecture.md) | High-level architecture, request flows, functional evaluation, tooling results |
| [02-security.md](./02-security.md) | Security audit: auth, secrets, injection, data handling, supply chain |
| [03-adversarial.md](./03-adversarial.md) | Threat model and abuse scenarios against the gateway |
| [04-components.md](./04-components.md) | Per-component audit (routes, services, providers, middleware, DOs, schemas, utils, tests, config, scripts) |
| [05-digitalocean-integration.md](./05-digitalocean-integration.md) | DigitalOcean serverless inference: design doc + phased implementation plan |

## Verification Results (actually executed)

| Check | Result |
|---|---|
| `tsc --noEmit` | **PASS** (no errors) |
| `vitest run` | **PASS** — 162/162 tests, 30 files |
| `eslint src --max-warnings=0` | **PASS** (0 warnings) |
| `npm audit` | **24 vulnerabilities** (2 critical, 17 high, 5 moderate) — see below |
| Last commit | 2026-03-04 (`8a3ada3` feat: intelligent model alias upgrades) |

`npm audit` notes: only one flagged package is a **runtime** dependency — `hono <=4.13.4` (high; ~40 advisories, mostly in middleware this gateway does not use; a non-breaking `npm audit fix` is available and should be applied). The remainder are dev-toolchain packages (vitest/miniflare/wrangler/undici/sharp/ws/esbuild) that do not ship to production but should still be updated before active development resumes.

## Executive Summary

The codebase is a well-layered Cloudflare Worker AI gateway (Hono + Zod + Durable Objects) with a genuinely sophisticated feature set: credit-aware provider fallback, header-driven routing with hedging and latency budgets, strict JSON-schema output enforcement, and Langfuse telemetry. TypeScript is clean, lint is clean, and all 162 tests pass.

However, the audit found **real functional breakage that the test suite does not catch** (the test mocks are more faithful than production in the wrong ways), several **resource-exhaustion vectors that require no authentication**, and **weak cost controls** that matter because the gateway holds funded API keys for six providers.

### Top findings (P0 — fix before routing real traffic)

1. **Unbounded, attacker-keyed in-memory auth cache.** Every 401 attempt caches the negative result in a module-level `Map` keyed by the attacker-supplied key, with no size cap and lazy-only expiry (`src/middleware/auth.ts:15,40-49,63-71`). Cheap unauthenticated memory-exhaustion DoS.
2. **Cost controls are effectively off.** Rate limiting is disabled on all request-serving routes (intentional, documented), there is no per-client model allowlist, no request body size limit, no per-request max-token cap, and unknown/arbitrary model strings fall through to paid OpenRouter. One leaked key = unbounded spend.
3. **Circuit breaker state is write-only.** `CircuitBreaker` persists to DO storage but never reads it back (`src/durable-objects/circuit-breaker.ts:185-206`); `/health/providers` queries a *different* DO instance (`idFromName('status')`) that never receives events (`src/routes/health.ts:21`). Health monitoring is broken and breaker state silently resets on every DO restart.
4. **Credit accounting can silently drift and get stuck.** Post-paid deduction with a pre-request balance check races under concurrency; deduction failures (`ok:false`) are ignored; balances can't go negative so consumed-but-unrecorded spend simply disappears from the ledger; a false-positive "credit exhausted" heuristic (substring match on "quota"/"billing") permanently zeroes a provider's ledger until manual reset — silently shifting all traffic to paid OpenRouter (`src/services/credits.ts:85-101`, `src/durable-objects/credit-ledger.ts:83-86`).

### Top findings (P1 — fix soon)

5. Custom JSON-Schema validator compiles **caller-supplied regex patterns** (`new RegExp(schema.pattern)`) → ReDoS; plus a second unbounded module-level cache keyed by caller JSON (`src/services/schema-validation.ts:3,25-28,282-290`).
6. Upstream provider error bodies are **returned verbatim to gateway callers** (`src/routes/chat.ts:612,746`, `src/routes/responses.ts:146,242`) — leaks upstream account/organization details.
7. Full request and response payloads (all user content) are shipped to Langfuse US cloud with no redaction or per-client opt-out (`src/middleware/telemetry.ts`, `src/services/telemetry.ts`).
8. Streaming passes raw upstream bytes through for **all** providers — `transformStreamChunk` is dead code, so streaming to Anthropic-format providers (anthropic-direct, minimax) emits non-OpenAI SSE events, contradicting README and `docs/features/streaming.md`.
9. Model routing by **substring matching** (`model.includes('claude')`) plus silent alias upgrades (`gpt-4*` → `gpt-5-2`, likely an invalid model id typo; `glm-4*` → `glm-5`) create mis-routing and hard-failure paths (`src/services/router.ts:48-99`, `src/utils/model-aliases.ts:14-37`).
10. `x-kinisi-model` header or body `model` overrides the routing policy's model profiles entirely → any authenticated client can invoke any OpenRouter/Fireworks model, including the most expensive ones (`src/services/route-planner.ts:85-98`).

### Overall posture

Architecture and code organization: **good**. Operational correctness: **degraded** (DO persistence, health checks, catalog scraping regex bugs). Security: **weak spots concentrated in resource limits, cost governance, and data egress**, not in classic injection. Fit for purpose after the P0/P1 remediation pass (~1–2 weeks of focused work). The DigitalOcean integration proposal in [05-digitalocean-integration.md](./05-digitalocean-integration.md) deliberately sequences the P0 fixes as Phase 0 because a new funded provider tier amplifies every cost-control gap.

## Severity & Priority Legend

- **P0** — Fix before routing real traffic. Direct money loss, outage, or unauthenticated DoS.
- **P1** — Fix before treating the gateway as production-critical.
- **P2** — Fix in normal course; degraded behavior or defense-in-depth gap.
- **P3** — Hygiene, dead code, documentation drift.

## Consolidated Remediation Roadmap

| Priority | Item | Where |
|---|---|---|
| P0 | Evict/limit auth cache (LRU + size cap + only cache positive results; bounded negative-cache) | `middleware/auth.ts` |
| P0 | Re-enable request throttling (prefer DO-based per-key limiter over KV) or at minimum enforce body size + `max_tokens` caps + per-client model allowlist | `routes/chat.ts`, `routes/responses.ts`, `schemas/chat.ts` |
| P0 | Fix circuit breaker persistence (load from storage on access) and `/health/providers` (aggregate across per-provider DOs, or store all state in one DO) | `durable-objects/circuit-breaker.ts`, `routes/health.ts` |
| P0 | Credit ledger: reserve-then-deduct or allow bounded negative balance; check `deductCredits` result; remove false-positive exhaustion heuristics or require N consecutive confirmations + auto-recovery | `services/credits.ts`, `durable-objects/credit-ledger.ts`, `routes/chat.ts` |
| P1 | `npm audit fix` (bumps hono); upgrade wrangler/vitest toolchain | `package.json` |
| P1 | Cap/regenerate caller regex patterns; bound `schemaCache`; add validator depth limit | `services/schema-validation.ts` |
| P1 | Sanitize upstream error bodies before returning to clients | `routes/chat.ts`, `routes/responses.ts` |
| P1 | Fix model alias table (`gpt-5-2` → correct id); replace substring routing with exact/prefix catalog matching | `utils/model-aliases.ts`, `services/router.ts` |
| P1 | Fix `\\.` regex bugs in catalog scrapers or drop scraping in favor of proper APIs | `services/models-catalog.ts` |
| P2 | Normalize streaming through per-provider adapters (or delete `transformStreamChunk` and document raw passthrough) | `providers/*`, `utils/streaming.ts` |
| P2 | Add Langfuse payload redaction / client-level opt-out; consider sampling | `middleware/telemetry.ts` |
| P2 | Admin hardening: second factor or IP restriction for admin keys, admin action audit log | `middleware/auth.ts`, `routes/admin.ts` |
| P2 | Validate `/v1/responses` with a Zod schema; migrate `X-Corvo-*` → `x-corvo-cortex-*` | `routes/responses.ts` |
| P2 | Cancel losing hedged attempts; wire abort signal into `fetchWithRetry` | `services/route-executor.ts`, `utils/retry.ts` |
| P2 | Set `ALLOWED_ORIGINS` in production; add `[env.preview]` to wrangler.toml | `wrangler.toml` |
| P3 | Remove dead code (`utils/logger.ts`, `utils/headers.ts`, `createStreamingResponse`, `transformStreamChunk` if staying raw) | various |
| P3 | Scrub sample key from `seed-data.sh`; stop echoing keys in `provision-kinisi.sh`; add missing secrets to `setup-secrets.sh` | `scripts/` |
| P3 | Docs sync: version 2.2 vs 2.3, stale `streaming.md`, outdated `spec.md` directory/Env tables | `docs/` |
