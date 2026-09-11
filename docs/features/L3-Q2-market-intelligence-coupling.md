# L3-Q2 — market-intelligence → market-data/strategy coupling

**Status:** DECIDED (human, 2026-09-08) — **Option A: boundary-read.** Expose
`evaluateRegime` and `scoreCandidate` as Traderton boundary **read tools**; re-point
market-intelligence's three value-level call sites at the boundary. This unblocks deletion of
BOTH `market-data` and `strategy` from herobids. The candle-fetching classification (§4) is the
explicit open question the investigation slice must resolve before the tool contracts are final.

**Reads:** [CANONICAL-STATE.md](../CANONICAL-STATE.md) (legal-isolation, merge gate),
herobids `docs/features/2026/09/10/001-consume-traderton/004-l3d-plan.md` §H (the deferred
classification of `market-data` + `strategy`).

## 1. What Q2 is

`market-intelligence` (`apps/worker/src/market-intelligence/`, ~16k lines) is a large **surviving
platform subsystem** — the always-on discovery/assessment/monitoring brain (coordinator +
leader-election, monitor, LLM ranking, preset assessment/transitions, wake scheduling). It is
platform, not trading, so it stays in herobids. The problem: it reaches into two **trading**
packages (`market-data`, `strategy`) at three value-level call sites, keeping those packages
alive in-process and blocking their deletion (herobids `004` §H).

## 2. The exact coupling (three value call sites; everything else is type-only)

1. **`evidence-adapters.ts` → `evaluateRegime` (+ `getRequiredRegimeCandleCount`) from
   `@herobids/market-data`** (L8, L111): builds a candle-fetcher, calls
   `evaluateRegime({ benchmarkSymbol }, candleFetcher)` to compute a market **regime**, wraps the
   `RegimeResult` as assessment evidence.
2. **`coordinator.ts` → `evaluateRegime` from `@herobids/market-data`** (L379–381): same function,
   called via dynamic `await import(...)` ("to avoid circular deps"); computes a regime result
   from candles for the coordinator's monitoring.
3. **`preset-scorecard-runner.ts` → `scoreCandidate` from `@herobids/strategy`** (L10, L75):
   builds a `CandidateContext` (symbol, candles, venue) + `ScanConfig` (indicators, signal bias
   from a preset), calls `scoreCandidate(candidate, scanConfig)` to get a trading **signal**
   (confidence/direction) — a single-symbol dry-run scoring how a preset *would* signal.

All other `market-data`/`strategy` imports in market-intelligence are `import type` (types like
`PriceCandle`, `RegimeResult`, `ScannerCandleTarget`, `ProviderRegistry`) — cheap to sever
(re-declare in a shared/domain type or import from `@herobids/domain`).

## 3. Nature of the coupling → why boundary-read is correct

Both functions are **pure, read-style trading computations**: "given candles, what regime?" and
"given candles + strategy config, what signal?" Neither places an order, holds capital, or mutates
trading state. This is the platform *consulting* trading ("what would you think?"), not *doing*
trading. Per legal-isolation, analytical trading computation still belongs behind the boundary —
so expose them as **read tools** and have market-intelligence call over the wire.

This is the mirror of Q1: Q1 = trading logic the platform *runs* (drop/extract); Q2 = trading
computation the platform *consults* (boundary-read).

## 4. The open sub-question the investigation must resolve — candle-fetching

`evaluateRegime`/`scoreCandidate` take **candles** as input. The platform currently fetches those
candles itself (`scannerCandleFetcher`, the candles adapter in `evidence-adapters.ts`). The
investigation must classify:

- **(a) Candle-fetching is trading data-access** → it also goes behind the boundary; the boundary
  tool fetches candles itself; the platform passes only `{ symbol, interval, benchmarkSymbol }`.
- **(b) Candle-fetching is platform data-access** → the platform keeps fetching candles and passes
  them **in the tool payload**; the boundary tool is pure compute over provided candles.

This determines the tool contract shape (payload = candles vs. identifiers) and how much data
crosses the wire. It is the crux of the investigate→propose slice.

## 5. Decision (recorded)

**Option A — boundary-read.** Rationale: keeps the legal line sharp (all trading computation,
including analytical, behind the boundary) and unblocks deletion of **two** packages at once with
a small, well-defined surface (2 tools, 3 call sites). Rejected alternatives:
- **Option B (keep platform-side):** splits the trading packages (part behind boundary, part
  stays), muddying the "all trading behind the boundary" line and risking the legal argument
  ("is regime evaluation trading?"). Reserved only if the investigation finds the functions
  cannot be cleanly separated for the boundary.
- **Option C (sever — platform drops regime/scorecard features):** platform capability loss;
  market-intelligence is core to the agentic platform, so unlikely intended.

## 6. Next step (the investigate→propose→pause slice)

1. **Classify candle-fetching** (§4 a vs b) — the crux.
2. Design the two read-tool contracts (`evaluate_regime`, `score_candidate` — names TBD),
   including the payload shape that falls out of §4, and confirm the copy surface from
   `market-data`/`strategy` into Traderton.
3. Sever the type-only imports (re-home `PriceCandle`/`RegimeResult`/etc. to `@herobids/domain`
   or a shared type).
4. herobids-side re-point slice: the three call sites become boundary calls; then delete
   `market-data` + `strategy` from herobids (their last platform importer gone).
5. All gated on the human merge gate. Traderton-side additions on a branch; herobids-side by the
   other agent; I coordinate + review.
