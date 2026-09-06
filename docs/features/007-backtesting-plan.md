# Phase 7 Plan (FINAL) — `@traderton/backtesting`

**Phase:** 7 of the roadmap ([009](../009-extraction-roadmap.md)).
**Shape:** clean-package (no seams).
**Depends on:** `@traderton/domain` + `@traderton/engine` (both done). NOT db/venues/market-data/strategy.
**Status:** FINAL — investigated (step 1) against real herobids `packages/backtesting` on 2026-09-06.

## Why clean-package, zero seams (step-1 findings)
`packages/backtesting/package.json` prod deps: `@herobids/domain` + `@herobids/engine`. Import sweep of
`src/**` (incl. `importers/`): the ONLY non-relative imports are `@herobids/domain`, `@herobids/engine`,
`vitest` (tests). No db/venues/market-data/strategy/llm/platform imports. No `@herobids/tests` fixtures.

**Per-symbol import diff (done up front):**
- Engine symbols imported — `Clock`, `Executor`, `InMemoryJournal`, `Journal`, `PaperExecutor`,
  `PositionState`, `RiskLimits`, `TradingCyclePersistence`, `TradingCycleResult` — **all exported by the
  `@traderton/engine` barrel.**
- Domain symbols imported — `Decimal`, `Decision`, `DecisionId`, `InstrumentId`, `MarkSource`,
  `MarketSnapshot`, `Price`, `RiskPlaybook`, `Strategy`, `VenueAccountId` — **all present in the
  `@traderton/domain` barrel.**
- No missing symbol → no seam. The verbatim copy IS the deliverable.

## Scope
~14 files: `backtest-report.ts`, `context-replay.ts`, `historical-data-feed.ts`, `market-data-recorder.ts`
(+ test), `replay-runner.ts`, `simulated-clock.ts`, `validation-runner.ts`, `index.ts`,
`backtesting.test.ts`, `validation.test.ts`, and `importers/` (`csv-importer.ts` + test + `index.ts`).

## Method (copy-and-delete)
1. Scaffold `@traderton/backtesting` (deps `@traderton/domain` + `@traderton/engine` workspace:*; devDep
   `@types/node`; tsconfig references `../domain` + `../engine`). **Mirror the Traderton package
   convention** (`build: tsc --build`, project references) rather than herobids backtesting's `build: tsc`
   / own-`typescript`-devDep form — Traderton uses a root TS toolchain + project references (decision 16;
   operator/toolchain scaffolding, not trading logic). Wire root tsconfig ref + vitest alias
   `@traderton/backtesting`. `pnpm install`.
2. Copy `packages/backtesting/src/**` (incl. `importers/`) verbatim; namespace-rename
   `@herobids/*`→`@traderton/*` (imports only). Build + copied tests green.
3. No seam-cut step (step 1 found none). If implement-time finds a seam, fall back to the per-phase pattern.

## Stop-gates (per 009)
- A backtesting file needing a domain/engine symbol not in the Traderton barrels → source-fix request.
  (Not expected — the diff is clean.)
- Any platform coupling in replay orchestration that isn't a clean deletion → classify; escalate.
- Any behavioural divergence in replay/historical-execution → consequential, STOP.

## Deliverables / acceptance
- `@traderton/backtesting` compiles strict against domain + engine; lint clean.
- All copied backtesting tests green.
- Forbidden-import sweep: no `@herobids/*`, no llm, no platform, no db/venues/market-data/strategy imports.
- Ledger updated: "Backtesting / replay" subsystem row → Met with evidence; `backtest_runs`/`replay_corpora`
  data-model rows already Met in Phase 2 (db) — confirm the runtime backtesting/replay engine is now Met.
- Mark Phase 7 Done in 009; seed Phase 8 (`apps/worker`, large subtraction) plan.

## Review checklist (from 009 lessons)
- Per-symbol domain+engine import diff clean (done above).
- Sweep ROOT config (vitest aliases, tsconfig refs, package.json — deps domain+engine, no others; pnpm-workspace).
- Kept files byte-identical modulo namespace rename; kept tests unmodified. Verbatim comments stay verbatim.
- Note the intentional build-script scaffolding divergence (tsc --build vs source's tsc) — it is toolchain
  scaffolding (decision 16), not trading logic; not a copy-never-author concern.
- State guards, not optimistic "expected clean".
