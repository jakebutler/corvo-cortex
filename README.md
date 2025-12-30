# Corvo Cortex

**Serverless AI Gateway and Smart Router** for Corvo Labs applications.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange)](https://workers.cloudflare.com/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

## Overview

Corvo Cortex is a serverless AI Gateway built on Cloudflare Workers that decouples frontend applications from specific LLM providers. It provides:

- **Smart Provider Routing** - Intelligently routes to prioritize free credits (OpenAI, Anthropic, Z.ai)
- **Authentication** - App-specific API keys stored in Cloudflare KV
- **Rate Limiting** - Per-client quotas (requests/minute, tokens/minute)
- **Circuit Breaker** - Prevents cascading failures with auto-recovery
- **Streaming Support** - Real-time SSE streaming for all providers
- **Telemetry** - LangFuse integration for cost tracking and analytics
- **Retry Logic** - Exponential backoff for transient failures

## Supported Providers

| Provider | Models | Notes |
|----------|--------|-------|
| Anthropic | Claude 3.5 Sonnet, Haiku, Opus | Direct API |
| OpenAI | GPT-4o, GPT-4o-mini | Direct API |
| Z.ai | GLM-4 Plus | Direct API |
| OpenRouter | 100+ models | Fallback/paid |

## Quick Start

### Prerequisites

- Node.js 18+
- Cloudflare account with Workers subscription
- API keys for LLM providers
- LangFuse account (for telemetry)

### Installation

```bash
# Clone the repository
git clone https://github.com/corvolabs/corvo-cortex.git
cd corvo-cortex

# Install dependencies
npm install
```

### Local Development

```bash
# Start development server
npm run dev
```

The API will be available at `http://localhost:8787`.

## API Documentation

### Authentication

All requests require an API key in the Authorization header:

```bash
Authorization: Bearer sk-corvo-<app_name>-<random_string>
```

### Endpoints

#### GET /v1/models

Returns available models and defaults:

```bash
curl -H "Authorization: Bearer sk-corvo-kinisi-xxx" \
  https://cortex.corvolabs.com/v1/models
```

Response:
```json
{
  "object": "list",
  "data": [
    { "id": "gpt-4o", "provider": "openai", "name": "GPT-4o (Reasoning)" },
    { "id": "claude-3-5-sonnet", "provider": "anthropic", "name": "Claude 3.5 Sonnet (Coding)" },
    { "id": "glm-4-plus", "provider": "z-ai", "name": "GLM-4 (Creative)" }
  ],
  "defaults": {
    "system_default": "gpt-4o",
    "client_default": "claude-3-5-sonnet"
  }
}
```

#### POST /v1/chat/completions

OpenAI-compatible chat completions:

```bash
curl -X POST \
  -H "Authorization: Bearer sk-corvo-kinisi-xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet",
    "messages": [{"role": "user", "content": "Hello!"}]
  }' \
  https://cortex.corvolabs.com/v1/chat/completions
```

With streaming:
```json
{
  "model": "gpt-4o",
  "messages": [{"role": "user", "content": "Tell me a joke"}],
  "stream": true
}
```

## Deployment

### Production Setup

1. **Authenticate with Cloudflare**
   ```bash
   wrangler login
   ```

2. **Create KV Namespaces**
   ```bash
   ./scripts/create-kv-namespaces.sh
   ```

   Update the namespace IDs in `wrangler.toml` with the returned values.

3. **Set Production Secrets**
   ```bash
   ./scripts/setup-secrets.sh
   ```

4. **Seed Initial Data**
   ```bash
   ./scripts/seed-data.sh
   ```

5. **Deploy**
   ```bash
   npm run deploy
   ```

### Manual Deployment Steps

If you prefer manual setup:

```bash
# Create KV namespaces
wrangler kv:namespace create CORTEX_CLIENTS --env production
wrangler kv:namespace create CORTEX_CONFIG --env production

# Set secrets
wrangler secret put ANTHROPIC_API_KEY --env production
wrangler secret put OPENAI_API_KEY --env production
wrangler secret put ZAI_API_KEY --env production
wrangler secret put OPENROUTER_API_KEY --env production
wrangler secret put LANGFUSE_PUBLIC_KEY --env production
wrangler secret put LANGFUSE_SECRET_KEY --env production

# Deploy
wrangler deploy --env production
```

### Adding a New Client

```bash
wrangler kv:key put --namespace-id=<CLIENTS_NAMESPACE_ID> "sk-corvo-myapp-xxx" '{
  "appId": "myapp",
  "name": "My Application",
  "defaultModel": "gpt-4o",
  "allowZai": true,
  "fallbackStrategy": "openrouter",
  "rateLimit": {
    "requestsPerMinute": 100,
    "tokensPerMinute": 50000
  }
}' --env production
```

## Architecture

### Request Flow

```
Client App
    ↓
Auth Layer (KV validation)
    ↓
Rate Limit Check
    ↓
Schema Validation (Zod)
    ↓
Smart Routing
    ├── Z.ai (glm-* models)
    ├── Anthropic (claude-* + credits)
    ├── OpenAI (gpt-* + credits)
    └── OpenRouter (fallback)
    ↓
Retry Logic (exponential backoff)
    ↓
Circuit Breaker (Durable Objects)
    ↓
Telemetry (LangFuse)
    ↓
Response (Streaming or JSON)
```

### Circuit Breaker States

| State | Description |
|-------|-------------|
| Closed | Normal operation |
| Open | Failing - fast fail for 60s |
| Half-Open | Testing recovery |

## Configuration

### Client Configuration Schema

```typescript
interface ClientConfig {
  appId: string;           // Unique app identifier
  name: string;            // Display name
  defaultModel: string;    // Default model for requests
  allowZai: boolean;       // Allow Z.ai Pro routing
  fallbackStrategy: 'fail-fast' | 'openrouter';
  rateLimit: {
    requestsPerMinute: number;
    tokensPerMinute: number;
  };
}
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ENVIRONMENT` | `development` or `production` |
| `CREDITS_ANTHROPIC` | Set to `"true"` if Anthropic credits available |
| `CREDITS_OPENAI` | Set to `"true"` if OpenAI credits available |

## Testing

```bash
# Run all tests
npm test

# Unit tests only
npm run test:unit

# Integration tests only
npm run test:integration

# Coverage report
npm run test:coverage
```

## Code Quality

### Running Analysis

Run all analysis tools:
```bash
npm run analyze
```

### Individual Checks

- **Linting:** `npm run lint` or `npm run lint:fix`
- **Type Checking:** `npm run type-check`
- **Circular Dependencies:** `npm run complexity`
- **Security Audit:** `npm run audit`
- **CodeRabbit Review:** `coderabbit --prompt-only`

### Reports

Analysis reports are generated in the `reports/` directory (auto-generated, not in git).

```bash
# View ESLint HTML report
open reports/eslint-report.html
```

## Monitoring

### LangFuse Dashboard

Access https://cloud.langfuse.com to monitor:
- Request volume per app
- Error rates by provider
- Latency metrics
- Cost tracking per application

### Cloudflare Analytics

Access Cloudflare Dashboard for:
- Worker request metrics
- Error logs
- KV storage usage

## Troubleshooting

| Error | Cause | Solution |
|-------|-------|----------|
| 401 Unauthorized | Invalid API key | Verify KV contains client config |
| 429 Rate Limit | Quota exceeded | Wait for window reset or increase quota |
| 503 Unavailable | Circuit breaker open | Check `/health/providers` endpoint |
| 402 Payment Required | Credits exhausted | Add credits or change fallback strategy |

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests: `npm test`
5. Submit a pull request

## License

MIT License - see LICENSE file for details.

## Support

- **Engineering:** eng@corvolabs.workers.dev
- **Documentation:** [docs.corvolabs.workers.dev](https://docs.corvolabs.workers.dev)
- **Issues:** [GitHub Issues](https://github.com/corvolabs/corvo-cortex/issues)

---

**Corvo Cortex v2.2** - Built with Cloudflare Workers + Hono
