# L3-Q1 — Backtesting disposition (Option 1 extract vs Option 2 drop)

**Status:** DECIDED (human, 2026-09-08) — **Option 2: DROP** backtesting from the consumer,
as part of the product pivot toward agentic depth over trading breadth. Backtesting is an
acceptable casualty of focus. Knowledge is preserved for a possible future Traderton rebuild
in [`future/backtesting/`](./future/backtesting/) (resurrection brief + history/provenance +
capability reference). Next step: the herobids deletion slice (§8). This doc frames the Q1 call
raised by the L3d pass (herobids `004` §H): the `backtesting` package is a
`Deferred (required for cutover)` blocker because platform code imports it in-process. It cannot
ship in the herobids platform process after cutover (it runs the live trading engine —
legal-isolation). So it had to either move **behind the Traderton boundary (Option 1)** or be
**dropped from the consumer (Option 2)**. Option 3 (keep it in-process in herobids) is rejected —
see §5.

**Reads:** [CANONICAL-STATE.md](../CANONICAL-STATE.md) (legal-isolation law, merge gate),
herobids `docs/features/2026/09/10/001-consume-traderton/004-l3d-plan.md` §H (the deferred
classification), herobids `docs/features/2026/05/01/initial/009-phase-3-plan.md` (the original
port spec), herobids `docs/features/2026/06/15/013-backtesting-agent-tools.md` (the
never-built agent-tools variant).

## 1. What backtesting is today (grounded in code)

Backtesting was ported from `aitradingbot` and deliberately re-architected so it runs the
**same `runTradingCycle()` engine as live trading**, with a `SimulatedClock` +
`HistoricalDataFeed` + `PaperExecutor` injected (herobids `003-design-decisions.md` §14–15).
That is the crux for the legal read: backtesting *is* the live trading engine, just fed
simulated clock/data. It is a live, plan-quota-limited production feature — not scaffolding.

**Current surface (exact):**

- REST route: `apps/api/src/routes/backtests.ts` — 8 endpoints (below).
- Queue: BullMQ `backtest-runs`, defined in the route, instantiated in `apps/api/src/index.ts`.
- Worker consumer: `apps/worker/src/backtest-runtime.ts` — `BacktestRuntime` (408 lines),
  `new Worker('backtest-runs', ...)`, started in `apps/worker/src/index.ts`. Handles
  `mode: 'backtest'` → `runBacktest` and `mode: 'validation'` → `runValidation`.
- Package: `@herobids/backtesting` (~1,800 lines incl. tests). Deps: `@herobids/domain`,
  `@herobids/engine` only. Public API: `SimulatedClock`, `ArrayHistoricalDataFeed`,
  `runBacktest`, `runValidation`, `parseCsvToFrames`, `MarketDataRecorder`, `replayContexts`
  + `normalizeForReplay`, `BacktestReport`/`BacktestConfig`/`Validation*` types.
- DB: 3 tables — `backtest_runs`, `replay_corpora`, `replay_market_events` (+
  `BacktestingRepository`). Journal rows are `backtest_run_id`-scoped in the shared journal.
- Config: `config/default.yaml` `backtesting:` block (concurrency, etc.).
- Frontend: only `apps/web/src/lib/api-client.ts` references it — **no dedicated UI wired**
  (gap-analysis lists "Frontend Backtests UI" as still-open).

**Completeness (what shipped vs not):**

- ✅ Complete + live: the operator backtest + validation path (all 8 endpoints, queue,
  runtime, DB, journal scoping). Core engine well unit-tested (deterministic replay, fills,
  position flips, divergence/threshold detection).
- ❌ Never built: the **agent-facing** variant (doc 013) — `run_backtest`/`get_backtest_result`/
  `cancel_backtest` tools + `BACKTESTING_SKILL`. Zero code hits. Different queue name/data model.
- ⚠️ Live-path holes (tracked, not breakage): **mechanical strategies get a noop `CandleFetcher`
  → produce no signals (hold throughout)** (`backtest-runtime.ts` ~L135–144, has a TODO);
  `hybrid` decisionMode throws "not yet supported"; `dca` rejected; **no dedicated
  `backtest-runtime.test.ts`** despite the Phase-3 spec requiring one; a functional route suite
  is still requested in `tests-beef-up.md`.

## 2. The full tool surface (why this is a mini-extraction, not a cleanup)

A faithful behind-the-boundary port needs a tool per capability. The 8 existing endpoints map
to 8 tools; two more would close known gaps (net-new, flagged):

| # | Tool | From endpoint | Purpose |
|---|------|---------------|---------|
| 1 | `import_market_data_corpus` | `POST /backtests/corpora/import/csv` | Parse CSV → frames, persist corpus |
| 2 | `get_market_data_corpus` | `GET /backtests/corpora/:corpusId` | Fetch corpus (owner-scoped) |
| 3 | `run_backtest` | `POST /backtests` | Enqueue single-strategy run → runId (poll) |
| 4 | `run_strategy_validation` | `POST /backtests/validate` | Enqueue baseline-vs-candidate run → runId |
| 5 | `get_backtest_run` | `GET /backtests/:runId` | Run status |
| 6 | `list_backtest_runs` | `GET /backtests` | List runs (paginated) |
| 7 | `get_backtest_report` | `GET /backtests/:runId/report` | Metrics (409 if not completed) |
| 8 | `get_backtest_journal` | `GET /backtests/:runId/journal` | Run-scoped journal events |
| 9 | `cancel_backtest` | *(none today)* | **NET-NEW** — gap-analysis claimed "cancel" done; no route exists |
| 10 | `list_market_data_corpora` | *(none today)* | **NET-NEW** — no list-corpora endpoint today |

So: **8 tools to port the existing surface, up to 10 to close the gaps.** Backtesting is a
~8–10-tool sub-surface with its own 3 DB tables, its own queue, and its own worker runtime —
a feature-sized extraction, not a deletion.

## 3. Option 1 — extract behind the Traderton boundary

Copy-never-author the `@herobids/backtesting` package + `BacktestRuntime` into Traderton;
expose the 8–10 tools over the 005 boundary as an **enqueue-and-poll** contract (mirroring
`submit_decision`: write tools return a `runId`/`status: pending`, clients poll the get/list/
report/journal read tools). herobids' `/backtests` route + `BacktestRuntime` become thin
boundary calls; the 3 tables + repository move to Traderton; the shared-journal `backtest_run_id`
scoping resolves behind the boundary.

**Scope / effort (High — its own investigate→propose→extract slice):**
- New 005 surface: 8–10 tool contracts, incl. the enqueue-poll shape and the **CSV/corpus payload
  shape** (historical data over HMAC+TLS — a non-trivial payload question).
- Port `@herobids/backtesting` (~1,800 lines) + `BacktestRuntime` (~408 lines) + 3 DB tables +
  `BacktestingRepository` into Traderton (mostly copy — the package deps are only domain+engine,
  both already in Traderton).
- herobids side (its own slice, like L3-P1b): route + queue + runtime become boundary calls;
  delete the herobids `backtesting` package + tables after.
- **Unblocks `engine` deletion** in herobids once backtesting no longer imports engine in-process.

**Pros:** preserves a working, quota-limited capability; correct per legal-isolation; honors
"we may improve, must not degrade."
**Cons:** feature-sized work; you'd be extracting a capability with known holes (§1) — decide
port-as-is (copy-never-author, holes included) vs treat holes as follow-ups; new CSV-over-boundary
payload design.

## 4. Option 2 — drop backtesting from the consumer

Delete the herobids `/backtests` route + queue + `BacktestRuntime` + `@herobids/backtesting`
package + the 3 tables + `BacktestingRepository` + reporting reads + the `api-client.ts`
reference + the `backtesting:` config block. No Traderton equivalent now; could be rebuilt fresh
in Traderton later.

**Scope / effort (Low–Medium — a deletion slice):**
- Delete route, queue wiring, worker runtime, package, 3 tables + repo, config block, the one
  web api-client reference, plan-limit `checkBacktestLimit`.
- **Immediately unblocks `engine` deletion** (removes a major engine importer) and shrinks the
  cutover surface by ~2,200 lines + 3 tables + a queue + a runtime.

**Pros:** simplest, fastest; smallest cutover footprint.
**Cons:** **capability loss** — a working (if incomplete) feature users can hit today goes away.
Violates "must not degrade" *unless* you consciously decide backtesting is not a capability you
carry into the Traderton era.

## 5. Option 3 — keep in-process in herobids (REJECTED)

Leaving `backtesting` + its `engine` dependency running in-process in herobids means the **live
trading engine keeps running in the platform process** — the exact thing the extraction exists
to eliminate (legal-isolation). It also keeps `engine` undeletable. Rejected unless a legal read
holds that *simulated* trading (no real capital, no live venue) sits outside the constraint —
that is a legal judgment, not a code decision, and would have to be recorded explicitly.

## 6. Decision (recorded)

**Option 2 — DROP.** The product is focusing on **agentic capability** (agent tools like
`agent-browser`, `browse_interactive`, more planned) over trading breadth. Backtesting is a
feature-sized extraction (§2–3) and only partly complete (§1), so it is not worth extracting now
and cannot stay in-process (§5). It is dropped as a conscious scope call, not a failure. To avoid
losing hard-won knowledge, the reasoning, history, and technical surface are preserved in
[`future/backtesting/`](./future/backtesting/) so a future Traderton implementation starts from
knowledge, not zero. Proceed to the herobids deletion slice (§8).

## 6b. Recommendation (pre-decision, retained for the record)

The deciding factor is legal-isolation + product value. Backtesting runs the real trading engine,
so Option 3 is out. Between 1 and 2 it is a **product call**: is backtesting a capability worth a
feature-sized extraction?

- It is **live, quota-limited, and reachable by users today** → argues for **Option 1** (keep it,
  extract it), porting copy-never-author with its known holes carried as follow-ups.
- But it is **incomplete** (mechanical = no signals, no agent tools, thin tests, no wired UI) and
  is a **~10-tool + 3-table + queue + runtime** extraction → if you judge it low-value relative to
  that cost, **Option 2** (drop, rebuild fresh in Traderton later) is defensible and much cheaper.

My lean is **Option 1** on the "don't degrade a live capability" principle, but the size makes
**Option 2** a legitimate scope-shedding call that is yours to make. Whichever you pick becomes a
tracked slice; the loser is recorded here with the rationale.

## 7. If Option 1 — next step

Its own investigate→propose→pause slice (like L3-P1): design the 8–10 tool contracts + the
enqueue-poll shape + the CSV/corpus-over-boundary payload, confirm the copy surface, decide
port-as-is vs fix-the-holes. Then a herobids-side L3-P1b-style slice to re-point `/backtests` at
the boundary and delete the herobids package + tables. Both gated on the human merge gate.

## 8. If Option 2 — next step

A herobids deletion slice: remove route + queue + runtime + package + 3 tables + repo + config +
web reference + `checkBacktestLimit`; verify `engine` deletion is unblocked (one importer down);
record backtesting as a dropped capability (rebuildable fresh in Traderton later) in `004` §H and
CANONICAL-STATE.
