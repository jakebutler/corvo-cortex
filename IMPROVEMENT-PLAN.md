# Corvo Cortex - Comprehensive Improvement Plan

**Version:** 2.2.0 → 2.3.0
**Created:** 2025-12-28
**Status:** Draft - Ready for Implementation

---

## Executive Summary

This plan addresses **23 security vulnerabilities** and **16 code quality issues** identified through comprehensive analysis using CodeRabbit CLI, ESLint, TypeScript compiler, and npm audit.

**Target State:** A robust, clean, production-ready codebase following security best practices and modern TypeScript/Cloudflare Workers standards.

---

## Phase 1: Critical Security Fixes (MUST DO BEFORE NEXT DEPLOY)

### 1.1 Remove Vulnerable Dependencies

**Issue:** Critical lodash vulnerability via `js-code-metric`, plus placeholder packages

**Files to Modify:** [package.json](package.json)

**Actions:**
1. Remove the following invalid/vulnerable dependencies:
   - `"audit": "^0.0.6"` (placeholder)
   - `"fix": "^0.0.6"` (placeholder)
   - `"js-code-metric": "^1.0.76"` (contains vulnerable lodash)
   - `"npm": "^11.7.0"` (should not be in dependencies)

2. Add `engines` field to specify minimum npm version:
```json
"engines": {
  "node": ">=18.0.0",
  "npm": ">=11.7.0"
}
```

3. Add audit script:
```json
"scripts": {
  "audit": "npm audit"
}
```

4. Run cleanup:
```bash
npm uninstall audit fix js-code-metric npm
npm install
npm audit fix
```

**Validation:** `npm audit` should show 0 critical/high vulnerabilities

---

### 1.2 Add ESM Support to package.json

**Issue:** Missing `"type": "module"` causes ESM import errors with vitest and ESLint warnings

**Files to Modify:** [package.json](package.json)

**Actions:**
1. Add at the top level of package.json:
```json
{
  "type": "module",
  ...
}
```

**Impact:**
- Fixes vitest ESM loading error
- Eliminates ESLint module reparsing warning
- Enables proper ES module resolution throughout the project

**Validation:**
- `npm run test:unit` should run without ESM errors
- `npx eslint src --ext .ts` should not show module warnings

---

### 1.3 Add reports/ to .gitignore

**Issue:** Auto-generated reports are being committed to version control

**Files to Modify:** [.gitignore](.gitignore)

**Actions:**
1. Add the following to .gitignore:
```gitignore
# Analysis reports (auto-generated)
reports/
*.log
```

**Validation:**
- `git status` should not show reports/ files
- Existing reports files can be removed: `git rm -r reports/`

---

## Phase 2: High Priority Configuration Fixes

### 2.1 Configure ESLint for Cloudflare Workers

**Issue:** ESLint reports `no-undef` errors for Cloudflare Workers globals (DurableObject, DurableObjectState, KVNamespace, console, setTimeout, etc.)

**Files to Modify:** [eslint.config.js](eslint.config.js)

**Actions:**
1. Update the globals configuration to include all Cloudflare Workers globals:
```javascript
globals: {
  // Web APIs
  fetch: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  WebSocket: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  Headers: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  ReadableStream: 'readonly',
  WritableStream: 'readonly',
  TransformStream: 'readonly',
  caches: 'readonly',
  CacheStorage: 'readonly',

  // Cloudflare Workers specific
  DurableObject: 'readonly',
  DurableObjectState: 'readonly',
  KVNamespace: 'readonly',
  DurableObjectNamespace: 'readonly',

  // Runtime globals
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  queue: 'readonly'
}
```

**Validation:**
- `npm run lint` should show 0 `no-undef` errors
- ESLint report should have clean results for circuit-breaker.ts and middleware files

---

### 2.2 Fix Empty Interfaces (Type Alias Pattern)

**Issue:** Three middleware files declare empty `ContextVariableMap` interfaces that should be type aliases

**Files to Modify:**
- [src/middleware/auth.ts](src/middleware/auth.ts)
- [src/middleware/rate-limit.ts](src/middleware/rate-limit.ts)
- [src/middleware/telemetry.ts](src/middleware/telemetry.ts)

**Actions:**
Replace in each file:
```typescript
// BEFORE
declare module 'hono' {
  interface ContextVariableMap extends Variables {}
}

// AFTER
declare module 'hono' {
  type ContextVariableMap = Variables;
}
```

**Validation:**
- `npm run lint` should show 0 `no-empty-object-type` errors
- TypeScript compiler should still pass

---

### 2.3 Fix Production/Preview KV Namespace Collision

**Issue:** wrangler.toml uses the same `id` and `preview_id` for production, causing preview deployments to share production KV data

**Files to Modify:** [wrangler.toml](wrangler.toml)

**Actions:**
1. Create separate preview KV namespaces:
```bash
# Create preview namespaces for CORTEX_CLIENTS
wrangler kv:namespace create CORTEX_CLIENTS --env production
wrangler kv:namespace create "CORTEX_CLIENTS_PREVIEW" --env production

# Create preview namespaces for CORTEX_CONFIG
wrangler kv:namespace create CORTEX_CONFIG --env production
wrangler kv:namespace create "CORTEX_CONFIG_PREVIEW" --env production
```

2. Update wrangler.toml with distinct preview IDs:
```toml
[[env.production.kv_namespaces]]
binding = "CORTEX_CLIENTS"
id = "8607bc102781438a8e1ea9d481a5a12b"
preview_id = "<PREVIEW_CLIENTS_NAMESPACE_ID>"  # Different from id

[[env.production.kv_namespaces]]
binding = "CORTEX_CONFIG"
id = "37c450a7bdc74db4aebff10aac98ff57"
preview_id = "<PREVIEW_CONFIG_NAMESPACE_ID>"  # Different from id
```

**Validation:**
- Preview deployments should use separate KV stores
- Production data should not appear in preview environments

---

## Phase 3: Medium Priority Code Quality Improvements

### 3.1 Fix ESLint Script Error Masking

**Issue:** `lint:report` script ends with `|| true` which hides ESLint failures

**Files to Modify:** [package.json](package.json)

**Actions:**
1. Split into two scripts:
```json
"scripts": {
  "lint": "eslint src --ext .ts,.tsx --max-warnings=0",  // Will fail CI on errors
  "lint:report": "eslint src --ext .ts,.tsx -f html -o reports/eslint-report.html",
  "analyze": "npm run lint:report && npm run complexity && npm run type-check"
}
```

**Rationale:**
- CI can use `npm run lint` which will fail on errors
- `lint:report` generates HTML without masking failures
- `analyze` command now works correctly (test:coverage already exists)

**Validation:**
- `npm run lint` should exit with non-zero if errors exist
- `npm run analyze` should complete successfully

---

### 3.2 Remove Unused Variables and Imports

**Issue:** ESLint reports 5 unused variable warnings

**Files to Modify:**
- [src/durable-objects/circuit-breaker.ts](src/durable-objects/circuit-breaker.ts) - Line 1: `CircuitBreakerState`
- [src/providers/openai.ts](src/providers/openai.ts) - Lines 18, 25: `model` parameters
- [src/providers/openrouter.ts](src/providers/openrouter.ts) - Line 36: `model` parameter

**Actions:**
1. For `CircuitBreakerState` - remove from import if unused:
```typescript
// BEFORE
import type { CircuitState, CircuitBreakerState } from '../types';

// AFTER
import type { CircuitState } from '../types';
```

2. For `model` parameters - prefix with underscore to indicate intentionally unused:
```typescript
// BEFORE
transformResponse(response: unknown, model: string): ChatCompletionResponse {

// AFTER
transformResponse(response: unknown, _model: string): ChatCompletionResponse {
```

**Validation:**
- `npm run lint` should show 0 unused variable warnings

---

### 3.3 Review and Fix Security Warning

**Issue:** `security/detect-object-injection` warning in anthropic.ts:126

**File to Review:** [src/providers/anthropic.ts](src/providers/anthropic.ts)

**Actions:**
1. Review the code at line 126 for potential object injection:
```typescript
private mapStopReason(reason: string): string {
  const mapping: Record<string, string> = {
    'end_turn': 'stop',
    'max_tokens': 'length',
    'stop_sequence': 'stop',
    'tool_use': 'stop'
  };
  return mapping[reason] || 'stop';  // Potential injection point
}
```

2. If `reason` is user-controlled, add validation:
```typescript
private mapStopReason(reason: string): string {
  const validReasons = ['end_turn', 'max_tokens', 'stop_sequence', 'tool_use'] as const;
  const normalizedReason = validReasons.includes(reason as any) ? reason : 'end_turn';

  const mapping: Record<string, string> = {
    'end_turn': 'stop',
    'max_tokens': 'length',
    'stop_sequence': 'stop',
    'tool_use': 'stop'
  };
  return mapping[normalizedReason] || 'stop';
}
```

**Validation:**
- Security review should confirm no user-controlled input reaches this code path
- ESLint security warning should be resolved or documented as acceptable

---

## Phase 4: Infrastructure and Documentation

### 4.1 Update README with Analysis Scripts

**File to Modify:** [README.md](README.md)

**Actions:**
Add a new section documenting code quality commands:
```markdown
## Code Quality

### Running Analysis

Run all analysis tools:
\`\`\`bash
npm run analyze
\`\`\`

### Individual Checks

- **Linting:** `npm run lint` or `npm run lint:fix`
- **Type Checking:** `npm run type-check`
- **Circular Dependencies:** `npm run complexity`
- **Security Audit:** `npm run audit`
- **CodeRabbit Review:** `coderabbit --prompt-only`

### Reports

Analysis reports are generated in the `reports/` directory (auto-generated, not in git).
\`\`\`

html
# View ESLint HTML report
open reports/eslint-report.html
\`\`\`
```

---

### 4.2 Update CHANGELOG

**File to Create:** [CHANGELOG.md](CHANGELOG.md)

**Template:**
```markdown
# Changelog

All notable changes to Corvo Cortex will be documented in this file.

## [2.3.0] - 2025-12-XX

### Added
- ESM support (`"type": "module"` in package.json)
- Cloudflare Workers globals in ESLint configuration
- Separate preview KV namespaces for production isolation
- Code quality analysis scripts and documentation

### Changed
- ESLint configuration for Cloudflare Workers environment
- Type alias pattern for Hono context extension (was empty interface)
- Removed invalid/vulnerable dependencies (audit, fix, js-code-metric, npm packages)

### Fixed
- Critical lodash security vulnerability
- Vitest ESM loading errors
- Production/Preview KV namespace collision
- ESLint no-undef errors for DurableObject and other CF globals

### Security
- Removed 23 dependency vulnerabilities
- Added npm engines field for version requirements
- Separated preview environment data stores

## [2.2.0] - Previous
- Initial release
```

---

## Phase 5: Verification and Testing

### 5.1 Pre-Deployment Checklist

Before deploying to production, verify:

- [ ] `npm audit` shows 0 critical/high vulnerabilities
- [ ] `npm run lint` exits with 0 (no errors)
- [ ] `npm run type-check` passes with no errors
- [ ] `npm run test:unit` runs successfully
- [ ] `npm run test:integration` runs successfully
- [ ] Preview KV namespaces are created and configured
- [ ] wrangler.toml has distinct preview_id values
- [ ] All middleware files use type alias pattern
- [ ] ESLint report shows 0 `no-undef` errors
- [ ] .gitignore includes reports/ directory

### 5.2 Post-Deployment Verification

After deployment:

- [ ] Verify production KV data is isolated from preview
- [ ] Run smoke tests on production endpoints
- [ ] Check Cloudflare Workers logs for errors
- [ ] Verify rate limiting works correctly
- [ ] Verify circuit breaker functionality
- [ ] Check LangFuse telemetry is flowing

---

## Implementation Order

**Recommended Sequence (Do in Order):**

1. **Day 1 - Critical Security (Phase 1)**
   - 1.1: Remove vulnerable dependencies (30 min)
   - 1.2: Add ESM support (5 min)
   - 1.3: Update .gitignore (5 min)

2. **Day 1-2 - High Priority Config (Phase 2)**
   - 2.1: Configure ESLint for CF Workers (15 min)
   - 2.2: Fix empty interfaces (15 min)
   - 2.3: Create preview KV namespaces (30 min)

3. **Day 2 - Medium Priority (Phase 3)**
   - 3.1: Fix lint script (10 min)
   - 3.2: Remove unused variables (20 min)
   - 3.3: Review security warning (15 min)

4. **Day 3 - Infrastructure (Phase 4)**
   - 4.1: Update README (20 min)
   - 4.2: Create CHANGELOG (15 min)

5. **Day 3 - Verification (Phase 5)**
   - Run full verification checklist (1 hour)
   - Deploy to staging for testing

**Total Estimated Time:** 4-5 hours

---

## Risk Assessment

| Change | Risk | Mitigation |
|--------|------|------------|
| Removing dependencies | Low | These are unused/invalid packages |
| Adding `"type": "module"` | Medium | Test all imports after change |
| ESLint config changes | Low | Only affects linting, not runtime |
| Empty interface → type alias | Low | Type-compatible change |
| Preview KV namespaces | Medium | Create before updating wrangler.toml |
| Removing unused variables | Low | Code review to ensure truly unused |

---

## Rollback Plan

If issues arise after deployment:

1. **Dependency issues:** Revert package.json and package-lock.json
2. **ESM issues:** Remove `"type": "module"` and use `.mts` extension for vitest.config
3. **KV namespace issues:** Revert wrangler.toml to previous namespace IDs
4. **Type alias issues:** Revert to empty interface pattern

---

## Success Criteria

After implementation, the codebase should achieve:

- **Security:** 0 critical/high vulnerabilities in `npm audit`
- **Code Quality:** 0 ESLint errors, <5 warnings
- **Type Safety:** 0 TypeScript errors
- **Tests:** All unit and integration tests passing
- **Documentation:** README updated with analysis commands
- **Isolation:** Preview environments use separate data stores

---

## Additional Recommendations (Future Enhancements)

### Not in Scope for This Plan
1. **Test Coverage:** Increase coverage above 80%
2. **CI/CD:** Add GitHub Actions for automated testing
3. **Monitoring:** Set up alerts for error rates
4. **Documentation:** API documentation with OpenAPI/Swagger
5. **Performance:** Add response time monitoring
6. **Scaling:** Implement autoscaling policies

---

## Appendix: File Changes Summary

### Files to Modify
1. `package.json` - Remove deps, add type/module, add engines
2. `.gitignore` - Add reports/ directory
3. `eslint.config.js` - Add Cloudflare Workers globals
4. `wrangler.toml` - Update preview KV namespace IDs
5. `src/middleware/auth.ts` - Change interface to type alias
6. `src/middleware/rate-limit.ts` - Change interface to type alias
7. `src/middleware/telemetry.ts` - Change interface to type alias
8. `src/durable-objects/circuit-breaker.ts` - Remove unused import
9. `src/providers/openai.ts` - Prefix unused param with underscore
10. `src/providers/openrouter.ts` - Prefix unused param with underscore
11. `src/providers/anthropic.ts` - Review and fix object injection
12. `README.md` - Add code quality section
13. `CHANGELOG.md` - Create new file

### Files to Create
1. `CHANGELOG.md`

### Files to Delete
1. All files in `reports/` directory (can be regenerated)

---

**End of Improvement Plan**

*Last Updated: 2025-12-28*
*Version: 1.0*
