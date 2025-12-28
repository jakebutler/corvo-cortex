# Changelog

All notable changes to Corvo Cortex will be documented in this file.

## [2.3.0] - 2025-12-28

### Added
- ESM support (`"type": "module"` in package.json)
- Cloudflare Workers globals in ESLint configuration (DurableObject, KVNamespace, RequestInit, etc.)
- Separate preview KV namespaces for production isolation
- Code quality analysis scripts (lint, type-check, complexity, audit)
- npm `engines` field for version requirements
- CodeRabbit CLI integration for AI-powered code review

### Changed
- ESLint configuration for Cloudflare Workers environment
- Type alias pattern for Hono context extension (was empty interface)
- `lint` script now fails on errors with `--max-warnings=0`
- `lint:report` script no longer masks failures with `|| true`

### Fixed
- Critical lodash security vulnerability (removed js-code-metric dependency)
- Vitest ESM loading errors (added `"type": "module"`)
- Production/Preview KV namespace collision (now use separate namespaces)
- ESLint `no-undef` errors for DurableObject and other CF globals
- Security warning for object injection in anthropic.ts (using switch statement)
- Unused variable warnings across multiple files

### Security
- Removed 4 invalid/vulnerable dependencies (audit, fix, js-code-metric, npm packages)
- Reduced vulnerabilities from 23 to 8 (all from @cloudflare/vitest-pool-workers, test dependency)
- Added proper input validation to prevent object injection attacks
- Separated preview environment data stores from production

### Developer Experience
- Added comprehensive code quality section to README
- Added analysis scripts to package.json
- Configured ESLint with security rules and Cloudflare Workers globals
- Added .gitignore entries for auto-generated reports

## [2.2.0] - Previous
- Initial release
