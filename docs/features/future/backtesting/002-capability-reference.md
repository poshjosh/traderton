# Backtesting — Capability Reference

**Audience:** the engineer/agent building backtesting in Traderton, using this as the port spec.
This is the concrete, factual surface as it existed in the source (herobids) at drop. Shapes are
transcribed from the source code so a rebuild is a port, not a reinvention. Source file paths are
in `../herobids` (read-only). See `000-resurrection-brief.md` for the *why* and the fixes to apply.

## 1. Tool surface (8 existing endpoints → tools; +2 net-new to close gaps)

The source exposed 8 REST endpoints (`apps/api/src/routes/backtests.ts`). A Traderton rebuild
exposes these behind the boundary as tools, enqueue-and-poll (write → `runId`; read → poll).

| # | Tool | Source endpoint | Purpose |
|---|------|-----------------|---------|
| 1 | `import_market_data_corpus` | `POST /backtests/corpora/import/csv` | Parse CSV → frames (`parseCsvToFrames`), persist a named corpus. Returns `corpusId`, `importedFrames`, start/end timestamps. |
| 2 | `get_market_data_corpus` | `GET /backtests/corpora/:corpusId` | Fetch a corpus (owner-scoped). |
| 3 | `run_backtest` | `POST /backtests` | Enqueue single-strategy run. Body: `strategyType`, `config`, `corpusId`, `venue`, `symbol`. Returns `{ id: runId, status: 'pending' }`. |
| 4 | `run_strategy_validation` | `POST /backtests/validate` | Enqueue baseline-vs-candidate run. Body: `corpusId`, `venue`, `symbol`, `baseline{strategyType,config}`, `candidate{...}`, optional `thresholds{maxDecisionDivergencePct,maxPnlRegressionPct}`. Returns `{ id, status: 'pending', mode: 'validation' }`. |
| 5 | `get_backtest_run` | `GET /backtests/:runId` | Run status (owner-scoped). |
| 6 | `list_backtest_runs` | `GET /backtests` | List runs (paginated: limit 1–500, offset). |
| 7 | `get_backtest_report` | `GET /backtests/:runId/report` | Metrics for a completed run; 409 if `status !== 'completed'`. |
| 8 | `get_backtest_journal` | `GET /backtests/:runId/journal` | `backtest_run_id`-scoped journal events; filter by `type`, paginated. |
| 9 | `cancel_backtest` | *(none — never existed)* | NET-NEW. Gap-analysis claimed done; no route shipped. |
| 10 | `list_market_data_corpora` | *(none)* | NET-NEW. No list-corpora endpoint existed. |

**Validation at the boundary** (source used zod): strategy config via `StrategySchema`;
backtest params via a `BacktestConfigSchema` (`warmUpFrames` int≥0, `maxPositionSize` decimal,
`maxOpenPositions` int≥1, `maxDrawdown` decimal); CSV import via a `CsvImportSchema`
(venue, symbol, csvText, column-index mapping `{timestamp,price,volume?,high?,low?,open?,close?}`,
`skipRows?`, `delimiter?`); validation via a `ValidationRequestSchema`. Early guards rejected
corpus/venue and corpus/symbol mismatches before enqueue.

## 2. Execution model

Enqueue-and-poll via BullMQ queue `backtest-runs`:
- API creates a `backtest_runs` row (`insertBacktestRun`), then `queue.add('backtest'|'validation', payload)`.
- On enqueue failure: `markBacktestFailed(runId, {message})` + 503.
- Worker `BacktestRuntime` consumes: loads frames from the corpus, runs `runBacktest`/`runValidation`,
  transitions status (`markBacktestRunning` → `markBacktestCompleted`/`markBacktestFailed`), writes
  the run-scoped journal.
- Client polls tools 5–8 for status/report/journal.

**In Traderton:** replace the BullMQ+worker with the boundary's job mechanism, but keep the same
lifecycle (pending → running → completed/failed) and the invoke→poll contract used by `submit_decision`.

## 3. DB tables (3)

### `backtest_runs` (source: `packages/db/src/schema/backtest-runs.ts`)
`id` (pk, text), `user_id` (→ users, nullable), `strategy_type` (notNull),
`config` (jsonb, notNull — full config snapshot at creation), `corpus_id` (text),
`venue` (notNull), `symbol` (notNull), `status` (notNull default `pending`;
`pending|running|completed|failed`), `metrics` (jsonb — filled on completion),
`error` (jsonb `{message, stack?}`), `started_at`, `completed_at`, `created_at` (defaultNow).
Indexes: status, strategy_type, created_at. For `validation` runs, `strategy_type = 'validation'`
and the full request is stored in `config`.

### `replay_corpora` (source: `packages/db/src/schema/replay-corpora.ts`)
`id` (pk), `user_id` (→ users, nullable), `name` (notNull), `source` (notNull — e.g.
`"csv-import:..."` or `"live-recording"`), `venue` (notNull), `symbols` (notNull,
comma-separated), `format_version` (int, default 1), `metadata` (jsonb), `start_at`, `end_at`,
`created_at`. Index: venue.

### `replay_market_events` (source: `packages/db/src/schema/replay-market-events.ts`)
Append-only normalized market data. `id` (pk), `corpus_id` (notNull), `venue` (notNull),
`symbol` (notNull), `event_type` (notNull — `ticker|trade|candle|mark`), `price` (numeric,
notNull), `event_at` (tz, notNull), `data` (jsonb — bid/ask, volume, OHLC, etc.).
Indexes: (corpus_id, symbol, event_at); (corpus_id, event_type).

Plus: journal rows carry a `backtest_run_id` scope in the shared journal (source
`packages/db/src/schema/journal-events.ts` + `journal-pg.ts` `query({backtestRunId,...})`).

## 4. Package public API (source: `packages/backtesting/src/index.ts`)

```
SimulatedClock                         // deterministic clock
ArrayHistoricalDataFeed                // in-memory frame feed
HistoricalFrame, HistoricalDataFeed    // types
runBacktest                            // single-strategy replay loop
BacktestConfig                         // run config type
BacktestReport                         // metrics type (see §5)
MarketDataRecorder, MarketEventRecord  // capture live data into a corpus
parseCsvToFrames                       // CSV → frames
CsvColumnMapping, CsvImportOptions     // types
runValidation                          // baseline-vs-candidate
ValidationComparison, ValidationResult, ValidationThresholds, DecisionDiff  // types
replayContexts, normalizeForReplay, normalizeForReplayBatch                 // stored-context replay
StoredDecisionContext, ContextReplayResult, ContextReplaySummary,
  PersistedDecisionContext, PersistedDecisionRow                            // types
```

## 5. `BacktestReport` metrics shape (source: `backtest-report.ts`)

```
runId, botId?, venue, symbol,
totalFrames,        // processed, excluding warm-up
warmUpFrames,       // skipped
totalDecisions,     // cycles that produced a decision
strategyErrors, riskRejections, executionFailures, totalFills,
finalPosition,      // PositionState
realizedPnl,        // string (from position tracker)
startTimestamp, endTimestamp
```
`buildReport()` derives the counts by scanning the per-cycle `TradingCycleResult[]`.

## 6. Config block (source: `config/default.yaml`)

```yaml
backtesting:
  warmupLookbackBars: 200
  maxDataGapMs: 60000
  persistJournal: true
  concurrency: 2       # BullMQ consumer concurrency for backtest jobs
```

## 7. Known holes to fix in the rebuild (do NOT port as-is)

Repeated from the resurrection brief §4 because they belong with the reference:
1. **Mechanical strategies got a noop `CandleFetcher` (returned `[]`) → no signals, hold-only.**
   Build a candle fetcher backed by the corpus. (`backtest-runtime.ts` ~L135–144, has a TODO.)
2. `hybrid` decisionMode threw "not yet supported"; `dca` rejected. Decide supported modes.
3. Agent-facing tools (`013` doc) never built — build them first for Traderton.
4. No dedicated worker-runtime test. Test the job-processing path.
5. No `cancel` endpoint despite gap-analysis claim — net-new if wanted.
