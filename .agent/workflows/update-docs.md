---
description: Update documentation before each commit
---

# Update Documentation Workflow

Run this workflow before each commit to ensure documentation stays current.

## When to Run

Before committing changes that affect:
- API endpoints or routes
- Data models or schemas
- Provider integrations
- Configuration options
- New features or bug fixes

## Steps

### 1. Review Your Changes

First, understand what you changed:

```bash
git diff --name-only
git diff --stat
```

### 2. Update Changelog (Required for Every Commit)

Add your changes to `docs/changelog.md` under `[Unreleased]`:

- **Added** - New features
- **Changed** - Changes to existing functionality
- **Fixed** - Bug fixes
- **Security** - Security-related changes

Format:
```markdown
## [Unreleased]

### Added
- Brief description of new feature (files affected)
```

### 3. Update Project Status (If Applicable)

Update `docs/project-status.md` if:
- [ ] You fixed a known issue → Move from "Active Issues" to "Resolved Recently"
- [ ] You introduced a known issue → Add to "Active Issues"
- [ ] Deployment status changed
- [ ] Version number changed

### 4. Update Feature Docs (If Code Changed)

If you modified feature-related code, update the corresponding doc:

| If you changed... | Update... |
|-------------------|-----------|
| `src/services/router.ts` | `docs/features/provider-routing.md` |
| `src/middleware/auth.ts` | `docs/features/authentication.md` |
| `src/middleware/rate-limit.ts` | `docs/features/rate-limiting.md` |
| `src/durable-objects/circuit-breaker.ts` | `docs/features/circuit-breaker.md` |
| `src/utils/streaming.ts` | `docs/features/streaming.md` |
| `src/middleware/telemetry.ts` or `src/services/telemetry.ts` | `docs/features/telemetry.md` |

### 5. Update Spec (If API/Models Changed)

Update `docs/spec.md` if:
- [ ] New endpoint added
- [ ] Endpoint behavior changed
- [ ] Data model/interface modified
- [ ] New provider added
- [ ] Error responses changed

### 6. Stage Documentation Changes

```bash
git add docs/
git status
```

### 7. Commit with Documentation

Include doc updates in your commit:

```bash
git commit -m "feat: your feature description

- Added functionality X
- Updated docs/changelog.md
- Updated docs/features/relevant-feature.md"
```

## Quick Reference

| Document | Purpose | Update Frequency |
|----------|---------|------------------|
| `changelog.md` | Track all changes | Every commit |
| `project-status.md` | Current status, known issues | When status changes |
| `spec.md` | API/data model reference | When API changes |
| `features/*.md` | Feature deep-dives | When feature code changes |

## Example Commit Sequence

```bash
# Make your code changes
vim src/services/router.ts

# Update docs
vim docs/changelog.md          # Add to [Unreleased]
vim docs/features/provider-routing.md  # If routing logic changed

# Stage and commit
git add .
git commit -m "feat: add new provider routing logic"
```
