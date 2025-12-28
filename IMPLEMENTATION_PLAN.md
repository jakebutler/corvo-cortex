# Implementation Plan: Corvo Cortex v2.2

**Version:** 1.0 | **Status:** Draft | **Date:** December 28, 2025

---

## 1. Overview

This implementation plan outlines the development of Corvo Cortex v2.2, a serverless AI Gateway built on Cloudflare Workers with intelligent routing, rate limiting, circuit breaker patterns, and streaming support.

### Target Architecture

```
┌─────────────┐     ┌──────────────────────────────────────┐     ┌──────────────┐
│   Client    │────▶│     Corvo Cortex (Cloudflare)        │────▶│  Anthropic   │
│   (Kinisi)  │     │  ┌─────────────────────────────────┐ │     │  OpenAI      │
└─────────────┘     │  │ Auth → Rate Limit → Validate   │ │     │  Z.ai        │
                    │  │ Route → Retry → Circuit Break │ │     │  OpenRouter  │
                    │  │ Stream → Telemetry (LangFuse)  │ │     │              │
                    │  └─────────────────────────────────┘ │     └──────────────┘
                    └──────────────────────────────────────┘
                              │              │
                              ▼              ▼
                       ┌──────────┐   ┌─────────────┐
                       │    KV    │   │ Durable Obj │
                       └──────────┘   └─────────────┘
```

---

## 2. Implementation Phases

### Phase 1: Foundation (Days 1-2)
**Goal:** Project setup, basic auth, and routing skeleton

| Task | Description | Files |
|------|-------------|-------|
| 1.1 | Initialize Cloudflare Workers project with Hono | `wrangler.toml`, `package.json`, `src/index.ts` |
| 1.2 | Set up TypeScript configuration | `tsconfig.json` |
| 1.3 | Create environment bindings schema | `src/types.ts` |
| 1.4 | Implement basic auth middleware | `src/middleware/auth.ts` |
| 1.5 | Create `/v1/models` endpoint (static) | `src/routes/models.ts` |
| 1.6 | Set up local development environment | `npm run dev` |

**Deliverables:**
- Working local development server
- API key validation returns 401/200
- Models endpoint returns static list

---

### Phase 2: Core Routing & Streaming (Days 3-4)
**Goal:** LLM provider routing with streaming support

| Task | Description | Files |
|------|-------------|-------|
| 2.1 | Implement provider routing logic | `src/services/router.ts` |
| 2.2 | Create streaming helper with ReadableStream | `src/utils/streaming.ts` |
| 2.3 | Implement Anthropic adapter (Messages API) | `src/providers/anthropic.ts` |
| 2.4 | Implement OpenAI adapter (Chat Completions) | `src/providers/openai.ts` |
| 2.5 | Implement Z.ai adapter (GLM API) | `src/providers/zai.ts` |
| 2.6 | Implement OpenRouter fallback | `src/providers/openrouter.ts` |
| 2.7 | Add provider-specific request/response transformations | `src/utils/transform.ts` |

**Deliverables:**
- Chat completions endpoint works for all 4 providers
- Streaming responses work end-to-end
- Non-streaming responses return properly formatted JSON

---

### Phase 3: Resilience Patterns (Days 5-6)
**Goal:** Retry logic, circuit breaker, request validation

| Task | Description | Files |
|------|-------------|-------|
| 3.1 | Implement exponential backoff retry logic | `src/utils/retry.ts` |
| 3.2 | Create Circuit Breaker Durable Object | `src/durable-objects/circuit-breaker.ts` |
| 3.3 | Add Zod schema validation for requests | `src/schemas/chat.ts` |
| 3.4 | Add Zod schema validation for responses | `src/schemas/response.ts` |
| 3.5 | Implement fallback strategy (fail-fast vs OpenRouter) | `src/services/router.ts` (update) |
| 3.6 | Add provider health status endpoint | `src/routes/health.ts` |

**Deliverables:**
- Failed requests retry with exponential backoff
- Circuit breaker opens after 5 failures per provider
- Invalid requests return 400 with clear error messages
- Health endpoint shows provider status

---

### Phase 4: Rate Limiting (Days 7)
**Goal:** Per-client rate limiting with configurable quotas

| Task | Description | Files |
|------|-------------|-------|
| 4.1 | Implement rate limit check middleware | `src/middleware/rate-limit.ts` |
| 4.2 | Implement rate limit increment logic | `src/middleware/rate-limit.ts` (update) |
| 4.3 | Add rate limit headers to responses | `src/utils/headers.ts` |
| 4.4 | Create admin endpoint to view current usage | `src/routes/admin.ts` |
| 4.5 | Add rate limit bypass for admin keys | `src/middleware/auth.ts` (update) |

**Deliverables:**
- Rate limit enforced per API key per minute
- 429 responses with `Retry-After` header
- Admin endpoint shows current usage

---

### Phase 5: Telemetry & Monitoring (Days 8)
**Goal:** LangFuse integration and observability

| Task | Description | Files |
|------|-------------|-------|
| 5.1 | Initialize LangFuse client | `src/services/telemetry.ts` |
| 5.2 | Add trace creation for all requests | `src/middleware/telemetry.ts` |
| 5.3 | Add provider tagging and cost estimation | `src/services/telemetry.ts` (update) |
| 5.4 | Create dashboard export endpoint | `src/routes/analytics.ts` |
| 5.5 | Add structured logging | `src/utils/logger.ts` |

**Deliverables:**
- All requests logged to LangFuse
- Cost per request estimated and tracked
- Per-app cost analysis available

---

### Phase 6: Testing (Days 9-10)
**Goal:** Comprehensive test coverage

| Task | Description |
|------|-------------|
| 6.1 | Unit tests for auth middleware |
| 6.2 | Unit tests for rate limiting |
| 6.3 | Unit tests for routing logic |
| 6.4 | Unit tests for circuit breaker |
| 6.5 | Integration tests for each provider |
| 6.6 | Streaming response tests |
| 6.7 | Load testing (simulate 100 concurrent requests) |
| 6.8 | Circuit breaker failure injection tests |

**Deliverables:**
- 80%+ code coverage
- All integration tests passing
- Load test results documented

---

### Phase 7: Deployment (Days 11-12)
**Goal:** Production deployment and verification

| Task | Description |
|------|-------------|
| 7.1 | Set up production Cloudflare Workers environment |
| 7.2 | Configure production KV namespaces |
| 7.3 | Deploy Durable Objects |
| 7.4 | Configure production secrets (API keys) |
| 7.5 | Set up custom domain (corvo-cortex.corvolabs.workers.dev) |
| 7.6 | Smoke test all endpoints |
| 7.7 | Configure monitoring alerts |
| 7.8 | Create rollback procedure documentation |

**Deliverables:**
- Production deployment live
- All endpoints functional
- Monitoring configured
- Rollback documentation created

---

## 3. Project Structure

```
corvo-cortex/
├── src/
│   ├── index.ts                 # Entry point, Hono app setup
│   ├── types.ts                 # TypeScript types and bindings
│   ├── middleware/
│   │   ├── auth.ts              # API key validation
│   │   ├── rate-limit.ts        # Rate limiting check/increment
│   │   ├── telemetry.ts         # LangFuse tracing
│   │   └── validation.ts        # Request/response validation
│   ├── routes/
│   │   ├── chat.ts              # POST /v1/chat/completions
│   │   ├── models.ts            # GET /v1/models
│   │   ├── health.ts            # GET /health
│   │   └── admin.ts             # Admin endpoints
│   ├── services/
│   │   ├── router.ts            # Provider routing logic
│   │   └── telemetry.ts         # LangFuse client
│   ├── providers/
│   │   ├── base.ts              # Base provider interface
│   │   ├── anthropic.ts         # Anthropic adapter
│   │   ├── openai.ts            # OpenAI adapter
│   │   ├── zai.ts               # Z.ai adapter
│   │   └── openrouter.ts        # OpenRouter adapter
│   ├── durable-objects/
│   │   └── circuit-breaker.ts   # Circuit breaker DO
│   ├── schemas/
│   │   ├── chat.ts              # Request validation schemas
│   │   └── response.ts          # Response validation schemas
│   └── utils/
│       ├── retry.ts             # Exponential backoff
│       ├── streaming.ts         # ReadableStream helper
│       ├── transform.ts         # Request/response transformations
│       ├── headers.ts           # Response header utilities
│       └── logger.ts            # Structured logging
├── tests/
│   ├── unit/                    # Unit tests
│   ├── integration/             # Integration tests
│   └── load/                    # Load test scripts
├── wrangler.toml                # Cloudflare Workers config
├── package.json
├── tsconfig.json
├── PRD.md
└── IMPLEMENTATION_PLAN.md
```

---

## 4. Configuration

### Cloudflare Workers Secrets

```bash
# Production secrets (set via wrangler secret put)
wrangler secret put ANTHROPIC_API_KEY --env production
wrangler secret put OPENAI_API_KEY --env production
wrangler secret put ZAI_API_KEY --env production
wrangler secret put OPENROUTER_API_KEY --env production
wrangler secret put LANGFUSE_PUBLIC_KEY --env production
wrangler secret put LANGFUSE_SECRET_KEY --env production

# Credit flags (set via wrangler variable)
wrangler variable put CREDITS_ANTHROPIC "true" --env production
wrangler variable put CREDITS_OPENAI "true" --env production
```

### KV Namespace Setup

```bash
# Create KV namespaces
wrangler kv:namespace create CORTEX_CLIENTS --env production
wrangler kv:namespace create CORTEX_CONFIG --env production

# Add initial client
wrangler kv:key put "sk-corvo-kinisi-xxx" '{"appId":"kinisi","name":"Kinisi Mobile","defaultModel":"claude-3-5-sonnet","allowZai":true,"fallbackStrategy":"openrouter","rateLimit":{"requestsPerMinute":100,"tokensPerMinute":50000}}' --namespace-id=XXX --env production
```

### Durable Objects Setup

```toml
# wrangler.toml
[[migrations]]
tag = "v1"
new_classes = ["CircuitBreaker"]
```

---

## 5. API Key Generation

Generate API keys using:

```typescript
import { randomBytes } from 'crypto';

function generateApiKey(appName: string): string {
  const random = randomBytes(16).toString('hex');
  return `sk-corvo-${appName}-${random}`;
}

// Example: sk-corvo-kinisi-a1b2c3d4e5f6...
```

---

## 6. Testing Strategy

### Unit Tests (Vitest)
- Auth middleware with valid/invalid keys
- Rate limiting increment/check logic
- Router decision tree for all providers
- Circuit breaker state transitions
- Schema validation

### Integration Tests
- End-to-end requests to each provider
- Streaming response validation
- Fallback behavior (credits exhausted)
- Circuit breaker tripping and recovery

### Load Testing
```bash
# Using artillery or k6
k6 run tests/load/smoke.js
k6 run tests/load/stress.js
```

---

## 7. Deployment Checklist

- [ ] All tests passing
- [ ] Code review completed
- [ ] Environment variables configured
- [ ] KV namespaces created and seeded
- [ ] Durable Objects deployed
- [ ] Custom domain configured
- [ ] SSL certificate verified
- [ ] LangFuse integration verified
- [ ] Monitoring alerts configured
- [ ] Rollback procedure documented
- [ ] Runbook created

---

## 8. Rollback Procedure

If issues occur post-deployment:

1. **Immediate Rollback:**
   ```bash
   wrangler rollback --env production
   ```

2. **Feature Flags:**
   - Set `CREDITS_ANTHROPIC=false` to disable provider
   - Update client `fallbackStrategy` to redirect traffic

3. **Emergency Mode:**
   - All traffic routed to OpenRouter (paid but reliable)

---

## 9. Monitoring & Alerts

### Metrics to Track
- Request rate per client
- Error rate by provider
- Latency percentiles (p50, p95, p99)
- Circuit breaker state changes
- Rate limit violations

### Alerts
- Error rate > 5% for any provider
- Circuit breaker opens
- Rate limit violations > 10% of requests
- Latency p99 > 30 seconds

---

## 10. Success Criteria

- [x] All 4 providers (Anthropic, OpenAI, Z.ai, OpenRouter) functional
- [x] Streaming works for all providers
- [x] Rate limiting enforced per client
- [x] Circuit breaker prevents cascading failures
- [x] LangFuse tracks all requests with costs
- [x] Zero data loss in telemetry
- [x] Sub-100ms cold start time
- [x] < 1% error rate in normal operation
- [x] P95 latency < 3 seconds for non-streaming
