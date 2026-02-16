# Changelog

All notable changes to Corvo Cortex are documented in this file.

This changelog follows [Keep a Changelog](https://keepachangelog.com/) format and uses release-based versioning.

---

## [Unreleased]

### Added
- Header-driven routing hints on `POST /v1/chat/completions` via `x-kinisi-*` headers.
- Stage/strategy-aware route planning with bounded fallback chains and optional delayed hedging (`week_n + speed + primary`).
- Strict caller-schema enforcement for `response_format.json_schema` outputs with terminal `422 schema_invalid` behavior.
- Deterministic `x-corvo-cortex-*` response metadata headers on both success and error.

### Changed
- `POST /v1/chat/completions` now supports opt-in policy-based routing without changing legacy behavior when hints are absent.
- Telemetry metadata now captures routing dimensions (`stage`, `strategy`, `route_id`, fallback/hedge flags).
- CORS allow/expose headers now include `x-kinisi-*` request headers and `x-corvo-cortex-*` response headers.
- Rate-limit middleware is now disabled on `POST /v1/chat/completions` to avoid per-request KV writes on Cloudflare free tier.
- Rate-limit middleware is now also disabled on `POST /v1/responses`, so KV-backed throttling is fully off for request-serving routes.

- Telemetry transport switched from Langfuse JS SDK event flushing to direct Langfuse ingestion API calls in Workers runtime.
- Telemetry now captures both successful and failed requests with full prompt/response payloads.
- Streaming telemetry now waits for stream completion before final trace ingestion.

### Fixed
- Resolved a production issue where Langfuse SDK v3 in Cloudflare Workers could flush without persisted traces.
- Added explicit workaround and upstream issue reference: https://github.com/langfuse/langfuse/issues/11984

---

## [2.3.0] - 2025-12-28

### Added
- ESM support (`"type": "module"` in package.json)
- Cloudflare Workers globals in ESLint configuration
- Separate preview KV namespaces for production isolation
- Code quality analysis scripts (lint, type-check, complexity, audit)
- npm `engines` field for version requirements
- CodeRabbit CLI integration for AI-powered code review
- MiniMax provider support (`MiniMax-M2` model)

### Changed
- ESLint configuration for Cloudflare Workers environment
- Type alias pattern for Hono context extension
- `lint` script now fails on errors with `--max-warnings=0`
- `lint:report` script no longer masks failures

### Fixed
- Critical lodash security vulnerability (removed js-code-metric dependency)
- Vitest ESM loading errors
- Production/Preview KV namespace collision
- ESLint `no-undef` errors for Cloudflare globals
- Security warning for object injection in anthropic.ts
- Unused variable warnings across multiple files

### Security
- Removed 4 invalid/vulnerable dependencies
- Reduced vulnerabilities from 23 to 8 (remaining are in test dependencies)
- Added proper input validation to prevent object injection attacks
- Separated preview environment data stores from production

---

## [2.2.0] - 2025-12-27

### Added
- Streaming support as MVP requirement
- Per-client rate limiting with configurable quotas
- Configurable fallback strategy (fail-fast vs. OpenRouter)
- Retry logic with exponential backoff
- Circuit breaker pattern for provider health
- Request/response validation with Zod

### Removed
- Daytona from provider list

---

## [2.1.0] - 2025-12-20

### Added
- Initial Z.ai Pro integration
- LangFuse telemetry integration
- Admin endpoints for usage monitoring

---

## [2.0.0] - 2025-12-15

### Added
- Complete rewrite on Cloudflare Workers
- Hono framework integration
- Multi-provider routing (Anthropic, OpenAI, OpenRouter)
- KV-based authentication

---

## Updating This Changelog

When preparing a release:

1. Move items from `[Unreleased]` to a new version section
2. Add the release date in `YYYY-MM-DD` format
3. Group changes into categories:
   - **Added** - New features
   - **Changed** - Changes to existing functionality
   - **Deprecated** - Features to be removed
   - **Removed** - Removed features
   - **Fixed** - Bug fixes
   - **Security** - Security-related changes
   - **Breaking** - Breaking changes (use `> [!WARNING]` alert)

4. Include impact notes for downstream consumers where relevant
