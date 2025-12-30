# Corvo Cortex v2.2 - Deployment Guide

**Version:** 1.0 | **Last Updated:** December 28, 2025

---

## 1. Prerequisites

Before deploying, ensure you have:

- [ ] Node.js 18+ installed
- [ ] Wrangler CLI installed: `npm install -g wrangler`
- [ ] Cloudflare account with Workers subscription
- [ ] API keys for all LLM providers (Anthropic, OpenAI, Z.ai, OpenRouter)
- [ ] LangFuse account for telemetry

---

## 2. Initial Setup

### 2.1 Install Dependencies

```bash
npm install
```

### 2.2 Authenticate with Cloudflare

```bash
wrangler login
```

### 2.3 Create Production KV Namespaces

```bash
# Create production KV namespaces
wrangler kv:namespace create CORTEX_CLIENTS --env production
wrangler kv:namespace create CORTEX_CONFIG --env production
```

**IMPORTANT:** Update the namespace IDs in `wrangler.toml` with the returned IDs:

```toml
[[env.production.kv_namespaces]]
binding = "CORTEX_CLIENTS"
id = "<ACTUAL_NAMESPACE_ID>"
preview_id = "<ACTUAL_PREVIEW_ID>"
```

### 2.4 Set Production Secrets

```bash
# LLM Provider API Keys
wrangler secret put ANTHROPIC_API_KEY --env production
wrangler secret put OPENAI_API_KEY --env production
wrangler secret put ZAI_API_KEY --env production
wrangler secret put OPENROUTER_API_KEY --env production

# LangFuse Telemetry
wrangler secret put LANGFUSE_PUBLIC_KEY --env production
wrangler secret put LANGFUSE_SECRET_KEY --env production
```

---

## 3. Seed Initial Data

### 3.1 Add Client Configuration

Add a client to the KV store:

```bash
wrangler kv:key put --namespace-id=<NAMESPACE_ID> "sk-corvo-kinisi-xxx" '{
  "appId": "kinisi",
  "name": "Kinisi Mobile",
  "defaultModel": "claude-3-5-sonnet",
  "allowZai": true,
  "fallbackStrategy": "openrouter",
  "rateLimit": {
    "requestsPerMinute": 100,
    "tokensPerMinute": 50000
  }
}' --env production
```

### 3.2 Add Models List Configuration

```bash
wrangler kv:key put --namespace-id=<CONFIG_NAMESPACE_ID> "MODELS_LIST" '{
  "data": [
    { "id": "gpt-4o", "provider": "openai", "name": "GPT-4o (Reasoning)" },
    { "id": "claude-3-5-sonnet", "provider": "anthropic", "name": "Claude 3.5 Sonnet (Coding)" },
    { "id": "glm-4-plus", "provider": "z-ai", "name": "GLM-4 (Creative)" }
  ]
}' --env production
```

---

## 4. Deployment

### 4.1 Deploy to Production

```bash
# Deploy to production
wrangler deploy --env production

# Or for a preview deployment
wrangler deploy --env preview
```

### 4.2 Verify Deployment

```bash
# Test health endpoint
curl https://cortex.corvolabs.com/health

# Test models endpoint (requires valid API key)
curl -H "Authorization: Bearer sk-corvo-kinisi-xxx" \
  https://cortex.corvolabs.com/v1/models
```

---

## 5. Custom Domain Setup (Optional)

### 5.1 Add Custom Domain

```bash
wrangler domains add cortex.corvolabs.com --env production
```

### 5.2 Update DNS

Add a CNAME record pointing to:
```
corvo-api.corvolabs.workers.dev -> corvo-cortex-pro.<your-subdomain>.workers.dev
```

---

## 6. Monitoring & Alerts

### 6.1 LangFuse Dashboard

Access your LangFuse dashboard at https://cloud.langfuse.com to monitor:
- Request volume per app
- Error rates by provider
- Latency metrics
- Cost tracking per application

### 6.2 Cloudflare Analytics

Access Cloudflare Dashboard for:
- Worker request metrics
- Error logs
- KV storage usage

### 6.3 Set Up Alerts

Configure alerts for:
- Error rate > 5%
- Circuit breaker openings
- Rate limit violations > 10%

---

## 7. Rollback Procedure

### 7.1 Quick Rollback

```bash
# Rollback to previous version
wrangler rollback --env production
```

### 7.2 Feature Flags

Disable providers via environment variables:

```bash
wrangler variable put CREDITS_ANTHROPIC="false" --env production
wrangler deploy --env production
```

### 7.3 Emergency Mode

All traffic will automatically route to OpenRouter (paid) if direct credits are exhausted.

---

## 8. Troubleshooting

### Issue: 401 Unauthorized

**Cause:** Invalid or missing API key
**Solution:** Verify KV store contains the client configuration

### Issue: 429 Rate Limit Exceeded

**Cause:** Client exceeded configured quota
**Solution:** Wait for minute window to reset or increase `rateLimit` in client config

### Issue: 503 Service Unavailable

**Cause:** Circuit breaker is open for a provider
**Solution:** Check provider status at `/health/providers` and reset if needed

### Issue: 402 Payment Required

**Cause:** Direct credits exhausted and `fallbackStrategy` is `fail-fast`
**Solution:** Add credits or change to `openrouter` fallback

---

## 9. API Key Generation

Generate new API keys using:

```typescript
import { randomBytes } from 'crypto';

function generateApiKey(appName: string): string {
  const random = randomBytes(16).toString('hex');
  return `sk-corvo-${appName}-${random}`;
}

// Example: sk-corvo-kinisi-a1b2c3d4e5f6...
```

---

## 10. Success Criteria Checklist

- [ ] All 4 providers (Anthropic, OpenAI, Z.ai, OpenRouter) functional
- [ ] Streaming works for all providers
- [ ] Rate limiting enforced per client
- [ ] Circuit breaker prevents cascading failures
- [ ] LangFuse tracks all requests with costs
- [ ] Custom domain configured (if applicable)
- [ ] Monitoring alerts configured
- [ ] Rollback procedure documented

---

## 11. Support

For issues or questions, contact:
- **Engineering:** eng@corvolabs.workers.dev
- **Infrastructure:** infra@corvolabs.workers.dev
- **Documentation:** docs.corvolabs.workers.dev
