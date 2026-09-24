# AGENTS.MD

Rules and guidelines for AI agents working on this traderton codebase.

## Project Overview

Traderton is an independently owned trading platform for AI/LLM
agents. It owns trading related instructions, tool contracts, risk and execution
policy, venue integrations, credentials, persistence, and trading documentation.

This is a Node.js 22+, TypeScript strict, ESM, pnpm monorepo using Vitest,
PostgreSQL, and Redis. 

## Development

### Quick help scripts

- `scripts/shell/tests/run-all-tests.sh --e2e`
- `scripts/shell/tests/run-extra-tests.sh --all`
- `scripts/shell/run/build-and-run.sh` 
- `scripts/shell/run/reset-and-run.sh` - start afresh db, redis etc also with some basic user setup
- `scripts/shell/run/reset-and-run-xstack.sh` - like reset-and-run.sh, but also starts the external trading service (traderton)

### Useful commands

```bash
pnpm install            # install workspace dependencies
pnpm build              # build packages
pnpm test               # run Vitest suite
pnpm lint               # TypeScript typecheck
pnpm test:integration   # integration suite (requires its documented services)
```

- Run focused tests for changed behavior, then `pnpm lint` and the relevant
  build/test suite before declaring code work complete.
- Preserve existing trading behavior and contracts unless a change is
  explicitly intended. Record gaps or deliberate behavior changes in the
  relevant active plan; extraction parity history is not a ban on new features.
- Validate inputs at trust boundaries; use domain types and ports where they
  already exist. Do not bypass strict TypeScript checks, swallow errors, or add
  dependencies without justification. Keep tests behavior-focused.
- Keep operator/deploy configuration separate from trading/instance settings;
  consult [configuration best practices](./docs/best-practices/configuration.md)
  before changing either.

## Code Conventions

### Language & Style

- TypeScript with `strict: true`. Target ES2022, ESM only.
- `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters` enabled.
- Use meaningful, descriptive names. Variables are nouns, functions are verbs.
- Tool names use lower snake case.
- Prefer action-first tool names.
- Prefer `verb_noun` or `verb_noun_qualifier` when possible.
- Avoid noun-first and hyphenated tool names.
- Bad: `code_execute`, `get-overview-from-market`.
- Good: `execute_code`, `get_market_overview`.
- Keep functions short and single-purpose (SRP).
- Avoid over-engineering — write the simplest code that meets requirements (KISS).
- DRY: abstract only when duplication is proven, not preemptive.

### Error Handling

- Use `ok()` / `err()` helpers for constructing results.
- Error codes are namespaced dot-strings: `venue.timeout`, `risk.exceeded`, etc.
- Distinguish fatal (cannot operate safely → crash) from warn-and-continue (sub-optimal → log + proceed).
- Every async loop must reschedule itself on failure (`finally` or top-level catch).

### Type Safety

- Define interfaces/types for all inputs, outputs, and data structures.
- Use branded types for domain values (`Quantity`, `Price`, `OrderId`, `FillId`).
- Validate at system boundaries (API input, config load, venue responses) with Zod.
- Interior code trusts already-validated types — no redundant runtime checks.

## Environment files — `.example` twins are the committed source of truth

Every `.env*` file has a committed `.example` twin (same variable keys, real
secret values replaced with safe placeholders or left blank, one inline `#`
comment per var explaining it). Real `.env*` files are gitignored; the `.example`
files are the committed, self-documenting record of what an operator must set to
run the process (e.g. the boundary's HMAC signing creds, `DATABASE_URL`,
`SCRAPFLY_API_KEY`, `LLM_*`). This is how a reader of the repo knows which `.env`
to create and with what keys.

Rules for authoring/implementing agents:
- When you ADD or CHANGE an environment variable, update the matching `.example`
  in the SAME change. Never let the `.example` drift from what the code reads
  (`process.env.*`).
- When you introduce a NEW `.env` variant, create its `.example` immediately and
  add a `!.env.<name>.example` un-ignore line to `.gitignore` (real `.env*` stay
  ignored).
- `.example` files carry NO real secrets — placeholders/blanks only.
- Scope: `.example` documents **operator/deploy-time env inputs** only. It is NOT
  a second home for trading/instance config that lives elsewhere (config schema /
  DB). See [docs/best-practices/configuration.md](./docs/best-practices/configuration.md).
