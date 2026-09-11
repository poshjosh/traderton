# Backtesting — Resurrection Brief

**Audience:** a future LLM agent (or engineer) tasked with building backtesting in Traderton,
with no prior context. Read this first. Then use `002-capability-reference.md` as the port
spec and `001-history-and-provenance.md` to go read the original code in git history.

## 1. What backtesting is

Backtesting replays **historical market data** through the **exact same trading engine that
runs live** — with a simulated clock, a historical data feed, and a paper executor injected in
place of the real ones. You feed it a window of past prices for a symbol, a strategy config, and
risk limits; it runs the strategy decision-by-decision over that window and reports what would
have happened: fills, realized P&L, decision/rejection/error counts, final position.

There is a second mode, **validation**: run two strategies (a *baseline* and a *candidate*) over
the same data and compare them — decision divergence and P&L regression against thresholds. This
is how you prove a strategy change is safe before shipping it.

The single most important design fact: **it reuses the live engine, by deliberate choice.** The
source system's predecessor (`aitradingbot`) had a *separate* backtest engine, which drifted out
of sync with live behavior and produced backtests that lied. The herobids port fixed this by
injecting `SimulatedClock` + `HistoricalDataFeed` + `PaperExecutor` into the same
`runTradingCycle()` used in production. **Preserve this principle in any Traderton rebuild.** A
backtest that doesn't run the real engine is worse than no backtest — it produces confident
wrong answers.

## 2. Why it was dropped (so you understand this wasn't a failure)

The product pivoted toward **agentic capability** — giving AI agents richer tools (`agent-browser`,
`browse_interactive`, and more planned) — rather than deepening the trading feature set.
Backtesting is trading logic; keeping it meant either a feature-sized extraction behind the
Traderton boundary (an 8–10 tool surface + 3 DB tables + a queue + a worker runtime) or leaving
the live trading engine running in the platform process, which the legal-isolation constraint
forbids. Given the pivot, backtesting was judged **not worth the extraction cost right now** and
dropped as a conscious scope call. It is a casualty of focus, not of quality. If and when
Traderton wants it, this folder is the head start.

## 3. The constraints that shaped it (and will shape the rebuild)

- **Legal-isolation.** Trading logic must not run in the consumer/platform process. In Traderton
  terms: backtesting belongs **behind the boundary**, exposed as tools, never in-process in a
  consumer. This is why the rebuild is a boundary tool surface, not a library the platform links.
- **Enqueue-and-poll.** A backtest is a long-running job, not a request/response. The source
  modeled this as a BullMQ queue with a worker runtime; a Traderton rebuild should mirror
  `submit_decision`'s invoke→poll shape: a write tool returns a `runId` + `status: pending`, and
  read tools return status/report/journal as the job progresses.
- **Corpus-first.** Historical data is imported once into a named *corpus* (from CSV or recorded
  live), then referenced by id when you run a backtest. Don't ship raw frames in the run payload —
  the source tried that in an early agent-tools design and abandoned it. Import → reference.
- **Determinism.** Same corpus + same strategy config ⇒ identical report. The source unit-tests
  guarantee this. Keep it — it's what makes validation meaningful.

## 4. What to do DIFFERENTLY (the holes — do not inherit these)

The source implementation was **live but incomplete**. A rebuild should close these rather than
copy them forward:

1. **Mechanical strategies produced no signals.** The worker injected a *noop* `CandleFetcher`
   that returned `[]`, so `MechanicalStrategy` couldn't compute indicators and just held for the
   whole run. There was a standing TODO to build a `CandleFetcher` backed by the historical feed.
   **A rebuild must feed candles from the corpus** so mechanical strategies actually backtest.
   Without this, backtesting only works for momentum/LLM strategies — a large silent gap.
2. **`hybrid` decisionMode was unsupported** (threw "not yet supported"); **`dca` was rejected.**
   Decide up front which decision modes the rebuild supports and cover them.
3. **The agent-facing variant was never built.** A design doc (herobids `013-backtesting-agent-tools.md`)
   proposed `run_backtest`/`get_backtest_result`/`cancel_backtest` tools + a `BACKTESTING_SKILL`
   so *agents* could self-serve backtests. It was never implemented. Given the agentic pivot,
   **this is probably the most valuable part to build first** in Traderton — expose backtesting
   as agent tools from day one, not just as an operator REST surface.
4. **Thin wiring tests.** The core engine was well unit-tested, but the worker runtime (the glue
   that pulls a job, runs it, persists status) had **no dedicated test** despite the original spec
   requiring one. Test the job-processing path in the rebuild.
5. **No `cancel`.** A cancel capability was claimed done in a gap-analysis but no endpoint ever
   existed. If you want cancel, it's net-new.

## 5. Strategic recommendation for a Traderton rebuild

- **Build it as agent tools first** (the never-built `013` vision), aligned with the product's
  agentic direction — let agents run and read backtests as part of their reasoning loop.
- **Behind the boundary, enqueue-and-poll**, mirroring `submit_decision`.
- **Reuse Traderton's live engine** (the equivalent of `runTradingCycle`) — never a separate loop.
- **Corpus import + reference**, with a real candle fetcher so all strategy types work.
- Scope: expect ~8–10 tools, 3 tables (runs, corpora, market-events), a queue, a runtime — a
  feature-sized effort. `002-capability-reference.md` is your port spec.
- Most of the engine logic can be **copied** from the source package (git history — see the
  provenance doc); the authored surface is the boundary adapter + the candle-fetcher fix.

The knowledge is preserved. The rebuild is a port with three fixes (candles, decision modes,
agent tools), not a from-scratch reinvention.
