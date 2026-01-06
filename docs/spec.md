# Corvo Cortex Specification

**Version:** 2.2.0 | **Last Updated:** January 6, 2026

---

## Overview

Corvo Cortex is a **serverless AI Gateway and Smart Router** that acts as the central nervous system for Corvo Labs applications. It decouples frontend applications from specific LLM providers, manages authentication via app-specific API keys, intelligently routes traffic to prioritize free credits, and provides centralized cost telemetry.

### Key Capabilities

- **Smart Provider Routing** - Intelligently routes to prioritize free credits (OpenAI, Anthropic, Z.ai, MiniMax)
- **Authentication** - App-specific API keys stored in Cloudflare KV
- **Rate Limiting** - Per-client quotas (requests/minute, tokens/minute)
- **Circuit Breaker** - Prevents cascading failures with auto-recovery
- **Streaming Support** - Real-time SSE streaming for all providers
- **Telemetry** - LangFuse integration for cost tracking and analytics
- **Retry Logic** - Exponential backoff for transient failures

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Cloudflare Workers |
| Framework | Hono v4 |
| Validation | Zod v3.22 |
| Telemetry | LangFuse v3 |
| State | Cloudflare Durable Objects |
| Storage | Cloudflare KV |
| Language | TypeScript 5.3 |

---

## Directory Structure

```
src/
├── index.ts                    # Entry point, route mounting, CORS config
├── types.ts                    # TypeScript interfaces and types
├── routes/
│   ├── chat.ts                 # POST /v1/chat/completions
│   ├── models.ts               # GET /v1/models
│   ├── health.ts               # GET /health/providers, POST /health/reset/:provider
│   ├── admin.ts                # GET /admin/usage, GET /admin/clients
│   └── analytics.ts            # GET /analytics/costs, /metrics, /export
├── middleware/
│   ├── auth.ts                 # API key validation
│   ├── rate-limit.ts           # Request/token quota enforcement
│   └── telemetry.ts            # LangFuse trace logging
├── providers/
│   ├── base.ts                 # ProviderAdapter interface
│   ├── anthropic.ts            # Claude API adapter
│   ├── openai.ts               # GPT API adapter (pass-through)
│   ├── zai.ts                  # GLM API adapter
│   └── openrouter.ts           # OpenRouter fallback adapter
├── services/
│   ├── router.ts               # Provider selection logic
│   └── telemetry.ts            # LangFuse service wrapper
├── schemas/
│   ├── chat.ts                 # Request validation schemas
│   └── response.ts             # Response validation schemas
├── utils/
│   ├── headers.ts              # Header utilities
│   ├── logger.ts               # Structured logging
│   ├── retry.ts                # Exponential backoff retry
│   ├── streaming.ts            # SSE stream handling
│   └── transform.ts            # Provider adapter factory
└── durable-objects/
    └── circuit-breaker.ts      # Circuit breaker state machine
```

---

## Data Models

### ClientConfig

Stored in `CORTEX_CLIENTS` KV namespace, keyed by API key.

```typescript
interface ClientConfig {
  appId: string;              // Unique app identifier (e.g., "kinisi")
  name: string;               // Display name
  defaultModel: string;       // Default model for requests
  allowZai: boolean;          // Allow Z.ai Pro routing
  fallbackStrategy: 'openrouter' | 'fail-fast';
  rateLimit: {
    requestsPerMinute: number;
    tokensPerMinute: number;
  };
  admin?: boolean;            // Admin privileges (optional)
}
```

### Rate Limit Tracking

Stored in `CORTEX_CLIENTS` KV with key format: `ratelimit:{apiKey}:{minute}`

```typescript
interface RateLimitUsage {
  requests: number;
  tokens: number;
}
```

### Environment Bindings

```typescript
interface Env {
  // KV Namespaces
  CORTEX_CLIENTS: KVNamespace;
  CORTEX_CONFIG: KVNamespace;

  // API Keys (secrets)
  ANTHROPIC_API_KEY: string;
  OPENAI_API_KEY: string;
  ZAI_API_KEY: string;
  OPENROUTER_API_KEY: string;
  MINIMAX_API_KEY: string;

  // LangFuse (secrets)
  LANGFUSE_PUBLIC_KEY: string;
  LANGFUSE_SECRET_KEY: string;

  // Credit flags
  CREDITS_ANTHROPIC?: string;   // "true" if credits available
  CREDITS_OPENAI?: string;
  CREDITS_MINIMAX?: string;

  // Durable Objects
  CIRCUIT_BREAKER: DurableObjectNamespace;

  // Environment
  ENVIRONMENT: string;
  ALLOWED_ORIGINS?: string;
}
```

### LLM Providers

```typescript
type LLMProvider = 
  | 'anthropic-direct' 
  | 'openai-direct' 
  | 'z-ai-pro' 
  | 'openrouter' 
  | 'minimax';
```

---

## API Endpoints

### Authentication

All endpoints (except root health check) require:
```
Authorization: Bearer sk-corvo-{app}-{random}
```

### Public Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Health check (returns version, status) |

### Client Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/v1/models` | Required | List available models and defaults |
| POST | `/v1/chat/completions` | Required | Chat completion with smart routing |

### Admin Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health/providers` | Admin | Circuit breaker status for all providers |
| POST | `/health/reset/:provider` | Admin | Reset circuit breaker for a provider |
| GET | `/admin/usage` | Admin | Rate limit usage (use `?key=` for specific client) |
| GET | `/admin/clients` | Admin | List registered clients (placeholder) |
| GET | `/analytics/costs` | Admin | Cost breakdown (via LangFuse) |
| GET | `/analytics/metrics` | Admin | Usage metrics summary |
| GET | `/analytics/export` | Admin | Export data link |

---

## Request Flow

```
Client Request
     ↓
┌─────────────────┐
│   CORS Check    │
└────────┬────────┘
         ↓
┌─────────────────┐
│  Auth Middleware │ → 401 if invalid key
└────────┬────────┘
         ↓
┌─────────────────┐
│ Rate Limit Check│ → 429 if quota exceeded
└────────┬────────┘
         ↓
┌─────────────────┐
│ Telemetry Init  │
└────────┬────────┘
         ↓
┌─────────────────┐
│ Schema Validate │ → 400 if invalid
└────────┬────────┘
         ↓
┌─────────────────┐
│ Provider Router │ → 402 if fail-fast + no credits
│  (determineProvider)
└────────┬────────┘
         ↓
┌─────────────────┐
│ Circuit Breaker │ → 503 if circuit open
│     Check       │
└────────┬────────┘
         ↓
┌─────────────────┐
│ Request Transform│ (OpenAI → Provider format)
└────────┬────────┘
         ↓
┌─────────────────┐
│  Fetch w/ Retry │ (max 3 attempts, exponential backoff)
└────────┬────────┘
         ↓
┌─────────────────┐
│Response Transform│ (Provider → OpenAI format)
└────────┬────────┘
         ↓
┌─────────────────┐
│ Rate Limit Incr │
└────────┬────────┘
         ↓
┌─────────────────┐
│ Telemetry Log   │ (async, non-blocking)
└────────┬────────┘
         ↓
    Response
```

---

## Supported Models

| Model ID | Provider | Notes |
|----------|----------|-------|
| `gpt-4o` | OpenAI | Reasoning |
| `gpt-4o-mini` | OpenAI | Fast |
| `claude-3-5-sonnet` | Anthropic | Coding |
| `claude-3-haiku` | Anthropic | Economical |
| `glm-4-plus` | Z.ai | Creative |
| `MiniMax-M2` | MiniMax | Creative |
| Any OpenRouter model | OpenRouter | Fallback |

---

## Error Responses

| Status | Error | Cause |
|--------|-------|-------|
| 400 | Invalid request | Schema validation failed |
| 401 | Unauthorized | Missing or invalid API key |
| 402 | Payment Required | Credits exhausted + fail-fast strategy |
| 403 | Forbidden | Admin access required |
| 429 | Rate limit exceeded | Quota exceeded (requests or tokens) |
| 503 | Service unavailable | Circuit breaker open |

---

## Related Documentation

- [Provider Routing](./features/provider-routing.md)
- [Authentication](./features/authentication.md)
- [Rate Limiting](./features/rate-limiting.md)
- [Circuit Breaker](./features/circuit-breaker.md)
- [Streaming](./features/streaming.md)
- [Telemetry](./features/telemetry.md)
