# Project Status

**Current Version:** 2.4.0  
**Last Updated:** September 15, 2026

---

## Deployment Status

| Environment | Status | URL |
|-------------|--------|-----|
| Production | ✅ Active | `cortex.corvolabs.com` |
| Preview | ✅ Active | `corvo-cortex-preview.*.workers.dev` |

---

## Provider Status

| Provider | Integration | Notes |
|----------|-------------|-------|
| Anthropic | ✅ Complete | Claude 4.x family (direct, credits-gated) |
| OpenAI | ✅ Complete | GPT-5.x family (direct, credits-gated) |
| Z.ai | ✅ Complete | GLM-5.x family |
| OpenRouter | ✅ Complete | Fallback provider |
| MiniMax | ✅ Complete | MiniMax-M2.x (Anthropic-format) |
| Fireworks | ✅ Complete | Catalog-driven preemption + `/v1/responses` proxy |

---

## Known Issues

### Active Issues

1. **Admin client listing is a placeholder**
   - Location: `src/routes/admin.ts`
   - Impact: `GET /admin/clients` returns instructions instead of client list
   - Workaround: Use `GET /admin/usage?key=<apiKey>` for specific clients

2. **Analytics endpoints return LangFuse links**
   - Location: `src/routes/analytics.ts`
   - Impact: Cost/metrics endpoints point to Langfuse dashboard
   - Reason: By design - Langfuse is the source of truth for analytics

3. **Upstream Langfuse SDK issue in Workers (tracked externally)**
   - Issue: https://github.com/langfuse/langfuse/issues/11984
   - Impact: Historical; the SDK is no longer used (direct ingestion API).
   - Workaround in Corvo Cortex: use direct Langfuse ingestion API transport (`/api/public/ingestion`).

### Resolved Recently

- ✅ Audit remediation epic #4 (2026-09): auth cache DoS, spend guardrails, ledger reserve-then-settle, breaker persistence, strict-schema hardening, error sanitization, routing correctness, catalog pipeline, adapter correctness, telemetry minimization, admin hardening, dependency remediation
- ✅ ESM module loading errors (fixed in 2.3.0)
- ✅ Production/preview namespace collision (fixed in 2.3.0)
- ✅ Lodash security vulnerability (fixed in 2.3.0)
- ✅ Production Langfuse trace ingestion verified (success + failure traces)

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

- [ ] DigitalOcean serverless inference provider integration (#23–#26)

---

## Recent Commits

*This section is updated with each commit via the documentation workflow.*

| Date | Summary |
|------|---------|
| 2026-09-15 | Audit remediation epic: P0–P3 issues #5–#22 |
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
