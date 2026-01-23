# Repository Guidelines

## Project Structure & Module Organization
- `src/` contains the Cloudflare Worker app entry (`src/index.ts`) plus feature folders: `routes/`, `services/`, `providers/`, `middleware/`, `durable-objects/`, `schemas/`, `utils/`, and shared `types.ts`.
- `tests/` is split into `unit/`, `integration/`, and `mocks/` (fixtures like `tests/mocks/env.ts`).
- `docs/` holds API specs and feature documentation; keep it in sync with behavior changes.
- `scripts/` contains deployment helpers (KV setup, secrets, seeding). Generated output lands in `coverage/` and `reports/`.

## Build, Test, and Development Commands
- `npm run dev` — run the Worker locally via Wrangler (`http://localhost:8787`).
- `npm run deploy` — deploy to Cloudflare Workers.
- `npm run lint` / `npm run lint:fix` — ESLint checks (with security rules) and fixes.
- `npm run type-check` — TypeScript type checking only.
- `npm test` — run all Vitest suites.
- `npm run test:unit` / `npm run test:integration` — scoped test runs.
- `npm run test:coverage` — coverage report (text/json/html).
- `npm run analyze` — lint report + dependency complexity + type-check + coverage.

## Coding Style & Naming Conventions
- TypeScript (ESM), 2-space indentation, semicolons, and single quotes as in existing files.
- Filenames are lowercase and concise (e.g., `routes/chat.ts`).
- ESLint rules warn on `any`, unused vars, and most `console` usage (allowing `warn`/`error`).
- Prefer explicit module boundaries; keep shared types in `src/types.ts` and Zod schemas in `src/schemas/`.

## Testing Guidelines
- Vitest with Cloudflare Workers pool; config in `vitest.config.ts`.
- Test files use `*.test.ts` naming and mirror module paths (e.g., `tests/unit/routes/chat.test.ts`).
- Coverage thresholds are 80% across statements/branches/functions/lines.

## Commit & Pull Request Guidelines
- Follow Conventional Commits seen in history: `feat: ...`, `fix: ...`, `chore: ...` (optionally with issue refs like `(#1)`).
- PRs should include: a short summary, test results (commands run), and doc updates in `docs/` when behavior changes. Note any `wrangler.toml` or secret/key impacts.

## Security & Configuration Tips
- Never commit provider keys. Use `wrangler secret put ...` or the helper scripts in `scripts/`.
- Keep KV namespace IDs and environment bindings accurate in `wrangler.toml`.
