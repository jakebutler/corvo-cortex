# Corvo Cortex Header-Driven Routing for Kinisi Contract Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add header-driven routing control to `POST /v1/chat/completions` so any client can direct Corvo Cortex for speed/latency/quality, while preserving strict JSON-schema guarantees and improving observability.

**Architecture:** Keep legacy router behavior as the default path, and activate the new path only when at least one `x-kinisi-*` request header is present. Split implementation into five irreducible components: hint ingestion, routing policy resolution, bounded execution (fallback + optional hedge), strict schema gate, and deterministic response metadata. Use environment-scoped KV policy with explicit feature flags for staged rollout and rollback.

**Tech Stack:** Cloudflare Workers, Hono, TypeScript, Zod, Vitest, Cloudflare KV (`CORTEX_CONFIG`), Durable Objects (existing circuit breaker), optional `ajv` for JSON Schema validation.

---

## First-Principles Decomposition

1. **Input normalization**
- Parse `x-kinisi-*` headers + request body + client defaults into one canonical hint object.

2. **Policy selection**
- Resolve stage/strategy into an ordered route chain plus retries, timeout budget, and hedge settings.

3. **Execution control**
- Execute candidate routes with bounded retries, fallback progression, and delayed hedge (only where enabled).

4. **Correctness gate**
- Enforce strict JSON + caller-provided `response_format.json_schema` before returning a winner.

5. **Observability contract**
- Emit deterministic `x-corvo-cortex-*` headers on both success and error with `unknown` placeholders.

---

## Confirmed Decisions (Locked)

- New behavior applies to **any** client that sends at least one `x-kinisi-*` header.
- Scope is **`POST /v1/chat/completions` only**.
- Corvo Cortex performs hedging now.
- Unspecified stage/strategy combinations map to balanced defaults.
- `x-kinisi-model` overrides JSON body `model` when both exist.
- If strict schema cannot be satisfied, return `422` with `schema_invalid`.
- Hedge policy: only when `x-kinisi-request-role=primary`; skip for `hedge` and `fallback`.
- Emit metadata headers on both success and error.
- Response header prefix becomes `x-corvo-cortex-*` (replace `x-corvo-*`).
- Strict-schema requests with `stream=true` are rejected (`400`).
- If no `x-kinisi-*` headers are present, keep legacy routing unchanged.
- Invalid header values fall back to defaults (no 400).
- If `allow/block` constraints remove all routes, ignore conflicting constraints and proceed with safe default route.

---

## Proposed v1 Static Routing Matrix (for Approval)

Model IDs are not hardcoded in code paths; they are resolved from config profiles:
- `fast_json_model`
- `balanced_json_model`
- `quality_json_model`
- `safe_json_model`

Provider chain per stage/strategy:

| Stage | Strategy | Route Chain (primary -> secondary -> final safe) | Hedge |
|---|---|---|---|
| `week_1` | `speed` | `fireworks.fast_json` -> `openrouter.fast_json` -> `openrouter.safe_json` | off (phase 1), optional later |
| `week_1` | `balanced` | `openrouter.balanced_json` -> `fireworks.fast_json` -> `openrouter.safe_json` | off |
| `week_1` | `quality` | `openrouter.quality_json` -> `fireworks.quality_json` -> `openrouter.safe_json` | off |
| `week_n` | `speed` | `fireworks.fast_json` -> `openrouter.fast_json` -> `openrouter.safe_json` | on (delayed) |
| `week_n` | `balanced` | `fireworks.fast_json` -> `openrouter.balanced_json` -> `openrouter.safe_json` | off |
| `week_n` | `quality` | `openrouter.quality_json` -> `fireworks.quality_json` -> `openrouter.safe_json` | off |
| `refine_week_1` | `speed` | mapped to `refine_week_1 + balanced` | off |
| `refine_week_1` | `balanced` | `openrouter.balanced_json` -> `fireworks.fast_json` -> `openrouter.safe_json` | off |
| `refine_week_1` | `quality` | `openrouter.quality_json` -> `fireworks.quality_json` -> `openrouter.safe_json` | off |

Default hint values (when header mode is active and fields are missing):
- `stage=week_n`
- `strategy=balanced`
- `request_priority=normal`
- `request_role=primary`
- `max_latency_ms` from policy profile (`week_1=45000`, `week_n=8000`, `refine_week_1=30000`)

---

### Task 1: Add Routing Hint Types and Parser

**Files:**
- Create: `src/schemas/routing-hints.ts`
- Create: `src/services/routing-hints.ts`
- Modify: `src/types.ts`
- Test: `tests/unit/services/routing-hints.test.ts`

**Step 1: Write the failing test**
- Cover valid headers, missing headers, invalid enum fallback, CSV parsing for prefer/allow/block, and mode trigger (`hasHeaderDrivenRouting`).

**Step 2: Run test to verify it fails**
- Run: `npx vitest run tests/unit/services/routing-hints.test.ts`
- Expected: FAIL because parser/types do not exist.

**Step 3: Write minimal implementation**
- Add canonical type:
```ts
interface KinisiRoutingHints {
  enabled: boolean;
  stage: 'week_1' | 'week_n' | 'refine_week_1';
  strategy: 'speed' | 'balanced' | 'quality';
  providerPrefer: Array<'fireworks' | 'openrouter'>;
  providerAllow?: Array<'fireworks' | 'openrouter'>;
  providerBlock?: Array<'fireworks' | 'openrouter'>;
  requestPriority: 'low' | 'normal' | 'high';
  maxLatencyMs?: number;
  requestRole: 'primary' | 'hedge' | 'fallback';
  requestedModel?: string;
}
```
- Parse from request headers; invalid values -> defaults.
- Header mode enabled when at least one `x-kinisi-*` header exists.

**Step 4: Run test to verify it passes**
- Run: `npx vitest run tests/unit/services/routing-hints.test.ts`
- Expected: PASS.

**Step 5: Commit**
```bash
git add src/schemas/routing-hints.ts src/services/routing-hints.ts src/types.ts tests/unit/services/routing-hints.test.ts
git commit -m "feat: add routing hint parsing for header-driven mode"
```

---

### Task 2: Implement Environment-Scoped Routing Policy + Matrix

**Files:**
- Create: `src/services/routing-policy.ts`
- Modify: `src/types.ts`
- Test: `tests/unit/services/routing-policy.test.ts`

**Step 1: Write the failing test**
- Cover: matrix resolution per stage/strategy, unspecified combo fallback to balanced, env-scoped KV override, and default policy fallback if KV missing/invalid.

**Step 2: Run test to verify it fails**
- Run: `npx vitest run tests/unit/services/routing-policy.test.ts`
- Expected: FAIL.

**Step 3: Write minimal implementation**
- Add policy config structure in `CORTEX_CONFIG`:
  - Key: `routing:kinisi-hints:${ENVIRONMENT}`
  - Fields: `version`, `enabled`, `profiles`, `matrix`, `hedge`, `retryPolicies`, `modelProfiles`.
- If config missing: use hardcoded v1 defaults from table above.

**Step 4: Run test to verify it passes**
- Run: `npx vitest run tests/unit/services/routing-policy.test.ts`
- Expected: PASS.

**Step 5: Commit**
```bash
git add src/services/routing-policy.ts src/types.ts tests/unit/services/routing-policy.test.ts
git commit -m "feat: add env-scoped routing policy resolution"
```

---

### Task 3: Add Route Planning with Hint Constraints and Safe Fallback

**Files:**
- Create: `src/services/route-planner.ts`
- Modify: `src/services/router.ts`
- Test: `tests/unit/services/route-planner.test.ts`
- Modify: `tests/unit/router.test.ts`

**Step 1: Write the failing test**
- Cover precedence and constraints:
  - `x-kinisi-model` overrides body model.
  - Prefer order respected.
  - Allow/block applied.
  - If constraints eliminate all candidates, planner ignores conflicting constraints and uses safe default chain.
  - Legacy router unchanged when header mode disabled.

**Step 2: Run test to verify it fails**
- Run: `npx vitest run tests/unit/services/route-planner.test.ts tests/unit/router.test.ts`
- Expected: FAIL.

**Step 3: Write minimal implementation**
- Produce route plan object:
```ts
interface RoutePlan {
  routeId: string;
  stage: string;
  strategy: string;
  candidates: RouteCandidate[];
  hedge: HedgeConfig;
  retryPolicy: RetryPolicy;
  maxLatencyMs: number;
}
```
- Preserve existing `determineProvider` for non-header mode.

**Step 4: Run test to verify it passes**
- Run: `npx vitest run tests/unit/services/route-planner.test.ts tests/unit/router.test.ts`
- Expected: PASS.

**Step 5: Commit**
```bash
git add src/services/route-planner.ts src/services/router.ts tests/unit/services/route-planner.test.ts tests/unit/router.test.ts
git commit -m "feat: add route planner with hint constraints and fallback"
```

---

### Task 4: Build Bounded Execution Engine (Fallback Chain + Reason Codes)

**Files:**
- Create: `src/services/route-executor.ts`
- Modify: `src/utils/retry.ts`
- Test: `tests/unit/services/route-executor.test.ts`
- Modify: `tests/unit/utils/retry.test.ts`

**Step 1: Write the failing test**
- Cover timeout budget, bounded retries per stage, route exhaustion, and reason code mapping:
  - `timeout`
  - `upstream_4xx`
  - `upstream_5xx`
  - `schema_invalid`
  - `throttled`

**Step 2: Run test to verify it fails**
- Run: `npx vitest run tests/unit/services/route-executor.test.ts tests/unit/utils/retry.test.ts`
- Expected: FAIL.

**Step 3: Write minimal implementation**
- Add budget-aware execution with `AbortController`.
- Add bounded retry profiles per stage/strategy.
- Return structured attempt metadata for observability and final error class.

**Step 4: Run test to verify it passes**
- Run: `npx vitest run tests/unit/services/route-executor.test.ts tests/unit/utils/retry.test.ts`
- Expected: PASS.

**Step 5: Commit**
```bash
git add src/services/route-executor.ts src/utils/retry.ts tests/unit/services/route-executor.test.ts tests/unit/utils/retry.test.ts
git commit -m "feat: add bounded route execution with reason codes"
```

---

### Task 5: Implement Delayed Hedging for `week_n + speed` (Primary Role Only)

**Files:**
- Modify: `src/services/route-executor.ts`
- Test: `tests/unit/services/route-executor-hedge.test.ts`

**Step 1: Write the failing test**
- Cover:
  - Hedge only when strategy is `speed`, stage is `week_n`, and request role is `primary`.
  - Hedge not launched for `hedge`/`fallback` roles.
  - First schema-valid winner returns.
  - Losing request is canceled.

**Step 2: Run test to verify it fails**
- Run: `npx vitest run tests/unit/services/route-executor-hedge.test.ts`
- Expected: FAIL.

**Step 3: Write minimal implementation**
- Add delayed hedge launch (`hedgeDelayMs` from policy).
- Race primary vs hedge.
- Cancel loser via abort signal.
- Do not multiply retries under hedge (bounded duplicate work).

**Step 4: Run test to verify it passes**
- Run: `npx vitest run tests/unit/services/route-executor-hedge.test.ts`
- Expected: PASS.

**Step 5: Commit**
```bash
git add src/services/route-executor.ts tests/unit/services/route-executor-hedge.test.ts
git commit -m "feat: add delayed hedging for week_n speed primary requests"
```

---

### Task 6: Enforce Strict JSON + Caller Schema Validation

**Files:**
- Create: `src/services/schema-validation.ts`
- Modify: `src/routes/chat.ts`
- Modify: `src/schemas/chat.ts`
- Test: `tests/unit/services/schema-validation.test.ts`
- Modify: `tests/unit/routes/chat.test.ts`

**Step 1: Write the failing test**
- Cover:
  - If `response_format.json_schema` exists and `stream=true` -> `400`.
  - Non-stream responses must parse as JSON and validate schema.
  - If all candidates fail schema -> `422` + reason `schema_invalid`.

**Step 2: Run test to verify it fails**
- Run: `npx vitest run tests/unit/services/schema-validation.test.ts tests/unit/routes/chat.test.ts`
- Expected: FAIL.

**Step 3: Write minimal implementation**
- Use `ajv` validator (or equivalent strict JSON-schema validator).
- Validate only when caller supplies `response_format.json_schema`.
- Never return malformed payload for strict mode.

**Step 4: Run test to verify it passes**
- Run: `npx vitest run tests/unit/services/schema-validation.test.ts tests/unit/routes/chat.test.ts`
- Expected: PASS.

**Step 5: Commit**
```bash
git add src/services/schema-validation.ts src/routes/chat.ts src/schemas/chat.ts tests/unit/services/schema-validation.test.ts tests/unit/routes/chat.test.ts package.json package-lock.json
git commit -m "feat: enforce strict caller-provided json schema for week blueprint responses"
```

---

### Task 7: Add Deterministic `x-corvo-cortex-*` Response Metadata (Success + Error)

**Files:**
- Create: `src/utils/corvo-cortex-headers.ts`
- Modify: `src/routes/chat.ts`
- Modify: `src/index.ts`
- Test: `tests/unit/utils/corvo-cortex-headers.test.ts`
- Modify: `tests/unit/routes/chat.test.ts`

**Step 1: Write the failing test**
- Cover response headers on success and error:
  - `x-corvo-cortex-provider`
  - `x-corvo-cortex-model`
  - `x-corvo-cortex-route-id`
  - `x-corvo-cortex-fallback-used`
  - `x-corvo-cortex-hedge-used`
  - `x-corvo-cortex-cache-hit`
  - `x-corvo-cortex-ttft-ms`
  - `x-corvo-cortex-latency-ms`
- Assert unavailable values become `unknown`.

**Step 2: Run test to verify it fails**
- Run: `npx vitest run tests/unit/utils/corvo-cortex-headers.test.ts tests/unit/routes/chat.test.ts`
- Expected: FAIL.

**Step 3: Write minimal implementation**
- Centralize header writer utility used by all exit paths in `chat.ts`.
- Capture latency from request start.
- Capture TTFT for streaming when available; else `unknown`.
- Update CORS in `src/index.ts`:
  - `allowHeaders` include all `x-kinisi-*` request headers.
  - `exposeHeaders` include all `x-corvo-cortex-*` response headers.

**Step 4: Run test to verify it passes**
- Run: `npx vitest run tests/unit/utils/corvo-cortex-headers.test.ts tests/unit/routes/chat.test.ts`
- Expected: PASS.

**Step 5: Commit**
```bash
git add src/utils/corvo-cortex-headers.ts src/routes/chat.ts src/index.ts tests/unit/utils/corvo-cortex-headers.test.ts tests/unit/routes/chat.test.ts
git commit -m "feat: add deterministic corvo-cortex routing metadata headers"
```

---

### Task 8: Wire Telemetry Dimensions for Stage-Based Dashboards

**Files:**
- Modify: `src/middleware/telemetry.ts`
- Modify: `src/services/telemetry.ts`
- Modify: `src/routes/chat.ts`
- Test: `tests/unit/services/telemetry.test.ts`
- Modify: `tests/unit/middleware/telemetry.test.ts`

**Step 1: Write the failing test**
- Assert trace metadata includes:
  - stage, strategy, request_role
  - route_id
  - fallback_used, hedge_used
  - schema_valid
  - failure_reason_code(s)
  - latency budget + actual latency

**Step 2: Run test to verify it fails**
- Run: `npx vitest run tests/unit/services/telemetry.test.ts tests/unit/middleware/telemetry.test.ts`
- Expected: FAIL.

**Step 3: Write minimal implementation**
- Extend telemetry metadata contract and ensure values are present for all outcomes.
- Keep telemetry fail-open behavior unchanged.

**Step 4: Run test to verify it passes**
- Run: `npx vitest run tests/unit/services/telemetry.test.ts tests/unit/middleware/telemetry.test.ts`
- Expected: PASS.

**Step 5: Commit**
```bash
git add src/middleware/telemetry.ts src/services/telemetry.ts src/routes/chat.ts tests/unit/services/telemetry.test.ts tests/unit/middleware/telemetry.test.ts
git commit -m "feat: add stage-aware routing telemetry dimensions"
```

---

### Task 9: Add Rollout/Rollback Controls in Admin + Scripts

**Files:**
- Modify: `src/routes/admin.ts`
- Create: `scripts/set-routing-policy.sh`
- Create: `scripts/rollback-routing-policy.sh`
- Test: `tests/unit/routes/admin.test.ts`
- Modify: `docs/features/provider-routing.md`

**Step 1: Write the failing test**
- Cover admin API for reading/updating routing policy in `CORTEX_CONFIG`.
- Cover validation and environment-scoped keys.

**Step 2: Run test to verify it fails**
- Run: `npx vitest run tests/unit/routes/admin.test.ts`
- Expected: FAIL.

**Step 3: Write minimal implementation**
- Add endpoints:
  - `GET /admin/routing-policy`
  - `POST /admin/routing-policy`
- Scripts provide one-command promote/rollback by env.

**Step 4: Run test to verify it passes**
- Run: `npx vitest run tests/unit/routes/admin.test.ts`
- Expected: PASS.

**Step 5: Commit**
```bash
git add src/routes/admin.ts scripts/set-routing-policy.sh scripts/rollback-routing-policy.sh tests/unit/routes/admin.test.ts docs/features/provider-routing.md
git commit -m "feat: add routing policy rollout and rollback controls"
```

---

### Task 10: Add End-to-End Route Behavior Tests and Contract Docs

**Files:**
- Create: `tests/integration/kinisi-routing-contract.test.ts`
- Modify: `docs/spec.md`
- Modify: `README.md`
- Modify: `docs/changelog.md`

**Step 1: Write the failing test**
- End-to-end route behavior for `chat/completions` with header mode:
  - legacy unchanged with no `x-kinisi-*`
  - stage/strategy routing activated with headers
  - schema-invalid -> `422`
  - response metadata headers always present

**Step 2: Run test to verify it fails**
- Run: `npx vitest run tests/integration/kinisi-routing-contract.test.ts`
- Expected: FAIL.

**Step 3: Write minimal implementation**
- Update docs for request/response contracts and rollout behavior.
- Include explicit header names and values.

**Step 4: Run test to verify it passes**
- Run: `npx vitest run tests/integration/kinisi-routing-contract.test.ts`
- Expected: PASS.

**Step 5: Commit**
```bash
git add tests/integration/kinisi-routing-contract.test.ts docs/spec.md README.md docs/changelog.md
git commit -m "docs: add header-driven routing and corvo-cortex metadata contract"
```

---

### Task 11: Full Verification Gate Before Merge

**Files:**
- No new files; verification only.

**Step 1: Run unit tests**
- Run: `npm run test:unit`
- Expected: PASS.

**Step 2: Run integration tests**
- Run: `npm run test:integration`
- Expected: PASS.

**Step 3: Run static checks**
- Run:
  - `npm run lint`
  - `npm run type-check`
- Expected: PASS.

**Step 4: Run coverage gate**
- Run: `npm run test:coverage`
- Expected: thresholds >= 80% pass.

**Step 5: Commit verification note**
```bash
git add -A
git commit -m "chore: verify header-driven routing implementation gates"
```

---

## Error Contract (Target)

When all routes fail:
```json
{
  "error": {
    "class": "route_exhausted",
    "stage": "week_n",
    "strategy": "speed",
    "route_id": "<uuid>",
    "reason_codes": ["timeout", "upstream_5xx"],
    "message": "No upstream route satisfied constraints and schema guarantees"
  }
}
```

Strict schema failure terminal response:
```json
{
  "error": {
    "class": "schema_invalid",
    "stage": "week_1",
    "strategy": "quality",
    "route_id": "<uuid>",
    "reason_codes": ["schema_invalid"],
    "message": "All candidate responses failed caller-provided JSON schema"
  }
}
```

---

## Blind Spots and Edge Cases to Validate During Implementation

1. **Backward compatibility risk:** existing clients reading `x-corvo-*` headers may break; decide if a temporary dual-header period is needed.
2. **Schema validator performance:** very large JSON schemas may impact latency; enforce max schema size and compile cache.
3. **Hedge amplification risk:** ensure retries are reduced/disabled on hedged branches to prevent duplicate upstream cost spikes.
4. **Provider capability drift:** cache-hit signal extraction can vary by provider response headers; default must remain `unknown`.
5. **Budget accounting correctness:** include queueing, retries, hedge delay, and schema validation time in total latency budget.
6. **Constraint conflict semantics:** when allow/block is contradictory, verify fallback behavior is deterministic and visible via reason metadata.

---

## Rollout Sequence (Aligned to Requirement)

1. Ship header ingestion + `x-corvo-cortex-*` metadata.
2. Enable stage-based static mapping (hedge disabled).
3. Enable hedge only for `week_n + speed` in `staging`, then `prod`.
4. Validate Kinisi latency + schema gates.
5. Expand hedge to `week_1 + speed` only after stability window.

---

## Definition of Done

- Header-driven mode only activates with `x-kinisi-*` presence; otherwise legacy route path is unchanged.
- Strict schema mode never returns malformed payload; terminal schema failures return `422`.
- `x-corvo-cortex-*` headers emitted on every response path (success/error) with deterministic values.
- Reason codes and stage context are visible in both API errors and telemetry metadata.
- Env-scoped routing policy supports fast rollout and rollback.
- All tests, lint, type-check, and coverage gates pass.
