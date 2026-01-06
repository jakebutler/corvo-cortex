# Project Status

**Current Version:** 2.2.0  
**Last Updated:** January 6, 2026

---

## Deployment Status

| Environment | Status | URL |
|-------------|--------|-----|
| Production | ✅ Active | `cortex.corvolabs.com` |
| Preview | ✅ Active | `corvo-cortex.*.workers.dev` |

---

## Provider Status

| Provider | Integration | Notes |
|----------|-------------|-------|
| Anthropic | ✅ Complete | Claude 3.5 Sonnet, Haiku |
| OpenAI | ✅ Complete | GPT-4o, GPT-4o-mini |
| Z.ai | ✅ Complete | GLM-4-plus |
| OpenRouter | ✅ Complete | Fallback provider |
| MiniMax | ✅ Complete | MiniMax-M2 |

---

## Known Issues

### Active Issues

1. **Admin client listing is a placeholder**
   - Location: `src/routes/admin.ts`
   - Impact: `GET /admin/clients` returns instructions instead of client list
   - Workaround: Use `GET /admin/usage?key=<apiKey>` for specific clients

2. **Analytics endpoints return LangFuse links**
   - Location: `src/routes/analytics.ts`
   - Impact: Cost/metrics endpoints point to LangFuse dashboard
   - Reason: By design - LangFuse is the source of truth for analytics

### Resolved Recently

- ✅ ESM module loading errors (fixed in 2.3.0)
- ✅ Production/preview namespace collision (fixed in 2.3.0)
- ✅ Lodash security vulnerability (fixed in 2.3.0)

---

## Test Coverage

| Category | Status |
|----------|--------|
| Unit Tests | ✅ Complete |
| Integration Tests | ✅ Complete |
| Coverage | ~80% |

Run tests: `npm test` or `npm run test:coverage`

---

## Upcoming Work

*Document planned work here:*

- [ ] *Add planned items as they are identified*

---

## Recent Commits

*This section is updated with each commit via the documentation workflow.*

| Date | Summary |
|------|---------|
| 2026-01-06 | Documentation system implementation |

---

## Health Check

Quick validation commands:

```bash
# Check deployment
curl https://cortex.corvolabs.com/

# Check models (requires API key)
curl -H "Authorization: Bearer $API_KEY" \
  https://cortex.corvolabs.com/v1/models

# Run local tests
npm test
```
