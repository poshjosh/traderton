# Backtesting — History and Provenance

**Audience:** anyone who needs to verify a claim in the resurrection brief or go read the
original code. This is the "where it came from, where it got to, and where to find it" doc.
All file paths and commits below are in the **source system, herobids**
(`../herobids` relative to the traderton repo), which is READ-ONLY. Backtesting was never
ported into Traderton — it was dropped. The code lives only in herobids git history.

## 1. Timeline — where we started, where we got to, where we'd like to be

### Started: aitradingbot (the predecessor)
Backtesting originated in `/Users/chinomso.ikwuagwu/dev_ai/aitradingbot/`. That project had a
**separate backtest engine** (`packages/backtesting/src/engine.ts` in the old project). Its
flaw, called out explicitly in the herobids design decisions, was **divergence**: the separate
backtest loop drifted from live behavior, so backtests didn't reflect reality.

### Ported + re-architected into herobids (Phase 3)
When the code was brought into herobids, the separate engine was **deliberately eliminated**.
The decision (herobids `docs/features/2026/05/01/initial/003-design-decisions.md`, §14–15,
~lines 385–421): the backtest path injects `SimulatedClock`, `HistoricalDataFeed`, and
`PaperExecutor` into **the same engine code that runs live** — no separate backtest loop —
"to eliminate divergence bugs that plague the old project's separate backtesting engine."

The build spec was herobids `docs/features/2026/05/01/initial/009-phase-3-plan.md`. It called
for: a dedicated `backtest-runs` queue + a `BacktestRuntime` in the worker; execution through
`runTradingCycle()` with `PaperExecutor`; journal rows scoped by `backtest_run_id`; the API
route `apps/api/src/routes/backtests.ts` and the worker `apps/worker/src/backtest-runtime.ts`.
**Implementation commit: `1168fe0e` — "Impl docs/features/2026/05/initial/009-phase-3-plan.md"**
(this is where the `backtest-runs` queue name first appears in the code).

### Where it got to (state at drop)
- **Operator path: complete and live.** All 8 REST endpoints, the queue, the worker runtime,
  DB persistence, journal scoping, and the comparative `validation` mode all shipped and ran.
  It was a plan-quota-limited production feature (`maxConcurrentBacktests` entitlement).
- **Agent-facing path: never built.** A later design, herobids
  `docs/features/2026/06/15/013-backtesting-agent-tools.md`, proposed agent tools
  (`run_backtest`/`get_backtest_result`/`cancel_backtest`) + a `BACKTESTING_SKILL` + a
  different (agent-keyed, frames-in-payload) data model. Zero code was ever written for it —
  confirmed by grep returning only the doc, and by the shipped queue being `backtest-runs`
  (plural, operator model) not the doc's `backtest-run`.
- **Known live-path holes** (see resurrection brief §4): noop `CandleFetcher` for mechanical
  strategies, `hybrid` unsupported, `dca` rejected, no dedicated runtime test.
- **Gap analysis** (herobids `docs/features/2026/06/06/009-re-assessment/001-gap-analysis.md`)
  marked "Backtests — create, list, get, cancel ✅" at the backend level (note: `cancel` was
  marked done but no endpoint exists — a doc/code mismatch). "Frontend Backtests UI" was listed
  as a still-open frontend item; only `apps/web/src/lib/api-client.ts` referenced it.

### Where we'd like to be (future Traderton)
Rebuilt behind the Traderton boundary as **agent tools first** (the never-built `013` vision),
reusing Traderton's live engine, with the candle-fetcher hole fixed so all strategy types work.
See `000-resurrection-brief.md` §5.

### Dropped (this extraction)
During the Traderton extraction, backtesting was classified `Deferred (required for cutover)`
in herobids `docs/features/2026/09/10/001-consume-traderton/004-l3d-plan.md` §H, then
**dropped** by the Q1 decision (`docs/features/L3-Q1-backtesting-disposition.md`, Option 2) as
part of the agentic pivot.

## 2. Provenance trail — the source files (in herobids, read-only)

### The engine package: `packages/backtesting/`
Deps: `@herobids/domain`, `@herobids/engine` only. Public API exported from
`packages/backtesting/src/index.ts`. Files (with line counts at drop):
- `replay-runner.ts` (170) — `runBacktest()`: the single-strategy replay loop.
- `validation-runner.ts` (244) — `runValidation()`: baseline-vs-candidate comparison.
- `context-replay.ts` (217) — `replayContexts`, `normalizeForReplay(Batch)`: re-run stored
  decision contexts (DB-shape → replay-shape).
- `backtest-report.ts` (74) — `buildReport()` + the `BacktestReport` metrics interface.
- `historical-data-feed.ts` (57) — `ArrayHistoricalDataFeed` + `HistoricalDataFeed`/
  `HistoricalFrame` types.
- `simulated-clock.ts` (20) — `SimulatedClock`.
- `market-data-recorder.ts` (73) — `MarketDataRecorder`: capture live data into a corpus.
- `importers/` — `parseCsvToFrames` + `CsvColumnMapping`/`CsvImportOptions`.
- Tests: `backtesting.test.ts` (372), `validation.test.ts` (425),
  `market-data-recorder.test.ts` (134) — these prove the engine logic (determinism, fills,
  position flips, divergence detection, threshold failures). ~1,800 lines total incl. tests.

### The worker consumer: `apps/worker/src/backtest-runtime.ts` (408)
`BacktestRuntime` — `new Worker('backtest-runs', ...)`. Started in `apps/worker/src/index.ts`.
Handles `mode: 'backtest'` → `runBacktestJob` → `runBacktest`, and `mode: 'validation'` →
`runValidationJob` → `runValidation`. Marks status transitions
(`markBacktestRunning`/`markBacktestCompleted`/`markBacktestFailed`), writes a
`backtest_run_id`-scoped journal. **Contains the noop-`CandleFetcher` TODO (~L135–144).**

### The API producer: `apps/api/src/routes/backtests.ts`
`backtestRoutes(app, backtestQueue, db, plansConfig)`. `BACKTEST_QUEUE_NAME = 'backtest-runs'`.
The 8 endpoints (see `002-capability-reference.md`). Enqueues via `backtestQueue.add(...)`.
Queue instantiated + routes registered in `apps/api/src/index.ts`.

### DB: `packages/db/src/schema/`
- `backtest-runs.ts` — `backtest_runs` table.
- `replay-corpora.ts` — `replay_corpora` table.
- `replay-market-events.ts` — `replay_market_events` table.
- `BacktestingRepository` (in `packages/db`) — the data access.

### Config
`config/default.yaml` `backtesting:` block.

## 3. How to retrieve the code

The `backtesting` package and its wiring still exist on the herobids `consume-traderton` branch
(they are `Deferred` there, not yet deleted, at the time this doc was written). To read the
implementation as it stood:

```
git -C ../herobids show 1168fe0e -- <path>          # the Phase-3 impl commit
git -C ../herobids log --oneline --all -- "packages/backtesting/*"   # its change history
cat ../herobids/packages/backtesting/src/replay-runner.ts            # while it survives on the branch
```

Once herobids deletes the package (the Option-2 deletion slice), use `git log --all` +
`git show <commit>:<path>` against commit `1168fe0e` and later to recover any file.
