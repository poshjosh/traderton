# L3-Q2-P — Q2 boundary read tools (investigate → propose)

**Status:** APPROVED (human, 2026-09-08) — OQ1–OQ3 resolved (§5). Implementation proceeds on a
Traderton branch. This is the Traderton-side build for the Q2 decision
([L3-Q2-market-intelligence-coupling.md](./L3-Q2-market-intelligence-coupling.md), Option A:
boundary-read). Investigate→propose→pause, same discipline as L3-P1.

## 0. Rule-precedence note (why we author candle-fetching here)

The **top rule is legal-isolation: no trading in the platform** — including no trading-data
fetching. **Copy-never-author is a subordinate tactic** (it exists to de-risk a large refactor);
when the two conflict, the top rule wins and the tactic goes inoperative for that decision.

Current practice in the source (`preset-scorecard-runner.ts`) is that **the platform pre-fetches
candles and passes them into `scoreCandidate`** — for both orderbook and swap. Copied faithfully,
that would preserve a legal coupling (the platform still doing part of the trading data pipeline).
So here the top rule overrides copy-never-author: `score_candidate` **fetches candles behind the
boundary** (authoring the fetch is permitted), and the platform ships only identifiers. It supports
**both orderbook and swap** (no degradation; matches what the platform does today; keeps ALL
candle-fetching, both kinds, on the Traderton side). Net effect: the platform stops fetching candles
entirely — regime (already via `check_regime`) and now scoring.

**Reads:** [L3-Q2-market-intelligence-coupling.md](./L3-Q2-market-intelligence-coupling.md),
[L3-Q3-venues-surviving-uses.md](./L3-Q3-venues-surviving-uses.md) (candle-fetcher join),
[CANONICAL-STATE.md](../CANONICAL-STATE.md) (legal-isolation, boundary pattern).

## 1. The headline finding — half of Q2 already exists

`evaluateRegime` is **already exposed on the Traderton boundary** as the `check_regime` tool
(`packages/worker/src/tools/market-data.ts` L260; in `marketDataTools` L387; registered in
`packages/boundary/src/registry.ts` L38; category `read-market-data`). It already fetches candles
**behind the boundary** via `CANDLE_PROVIDERS.binance` + `ctx.marketDataRegistry`; the caller passes
only the benchmark symbol + `RegimeParams`. There is **nothing to author** for the regime half —
the tool exists, is registered, and works (copy-never-author already satisfied by prior extraction).

Therefore Q2's Traderton-side build reduces to: **author one new tool, `score_candidate`.**

## 2. The candle-fetching crux — RESOLVED: behind the boundary (option a)

Q2 §4 (and Q3's candle-fetcher item) asked whether candle-fetching is (a) behind the boundary or
(b) passed in the payload. **Answer: (a).** Evidence:
- `check_regime` already fetches candles behind the boundary (the established pattern).
- Traderton's worker already has the machinery: `CANDLE_PROVIDERS.binance.fetchCandles(registry, symbol, {interval, limit})` for symbol fetches, and `createScannerCandleFetcher`/`VenueCandleFetcher`
  (`packages/worker/src/scanner-candle-fetcher.ts`) for venue-aware (orderbook→Binance, swap→GeckoTerminal by network+poolAddress).
- `evaluateRegime` itself takes a `candleFetcher` callback (not candles) — it is *designed* for
  the fetcher to live behind it.

So boundary tools take **identifiers** (symbol/venue/interval), not candle arrays. Callers never
ship candles over the wire. This also settles the Q3 candle-fetcher item identically.

## 3. What `score_candidate` must wrap

`scoreCandidate(candidate: CandidateContext, config: ScanConfig): ScoredSignal | null`
(`packages/strategy/src/scan-engine.ts`; exported from `@traderton/strategy`).
- `CandidateContext` takes `candles: PriceCandle[]` **directly** (unlike `evaluateRegime`). So the
  tool must fetch candles behind the boundary first, then build the `CandidateContext`.
- `ScanConfig = { indicators: IndicatorConfig; signalBias: 'trend-following'|'mean-reverting'; maxResults? }`.
  `IndicatorConfig` is a large optional-nested config (rsi/macd/volume/choch/vwap/priceAction/
  supportResistance/confidence weights).
- Returns `ScoredSignal | null` (null when confidence < `minConfidence`).

## 4. Proposed design for `score_candidate`

A new read tool, `category: 'read-strategy'` (or `read-market-data` if we don't want a new
category prefix — see Open Question 1). Shape mirrors `check_regime`:

- **Input (Zod schema):** `{ symbol, instrumentId?, venue?, venueType?: 'orderbook'|'swap', interval?, candleLimit?, config: ScanConfig }`. The `config` mirrors `ScanConfig` (indicators + signalBias).
  Candle identifiers only — NO candle array in the payload.
- **execute(params, ctx):**
  1. Guard `ctx.marketDataRegistry` (same `market_data_not_configured` guard as `check_regime`).
  2. Fetch candles behind the boundary: for orderbook/symbol targets use
     `CANDLE_PROVIDERS.binance.fetchCandles(ctx.marketDataRegistry, symbol, {interval, limit})`
     (the reachable path today); swap-pool scoring needs the venue-aware scanner fetcher — see
     Open Question 2.
  3. Build `CandidateContext { symbol, instrumentId, candles, venue, venueType }`.
  4. `const signal = scoreCandidate(candidate, config)`.
  5. Return `{ success: true, data: { signal } }` (signal may be `null` → a valid "no signal"
     read result, not an error). Map rate-limit/fetch errors exactly as `check_regime` does.
- **Registration:** add `scoreCandidateTool` to a `strategyTools` array (new) or to `marketDataTools`;
  wire into `buildToolRegistry()` in `packages/boundary/src/registry.ts`.
- **Read-only dispatch:** because the category resolves to `read`, the dispatcher runs it directly
  (bypasses idempotency) — no write machinery. Confirmed via `dispatcher.ts` `isSideEffecting`.

## 5. Open questions — RESOLVED (human, 2026-09-08)

1. **Category prefix → REUSE `read-market-data`.** No new `ToolCategory` member. `score_candidate`
   is categorized `read-market-data` (read-only; the suffix is descriptive only, no behavior impact).
2. **Swap scope → fetch behind the boundary; support BOTH orderbook AND swap** (OQ2 option b). Per
   the §0 rule-precedence note, the platform must stop fetching candles; `score_candidate` fetches
   candles itself behind the boundary via the venue-aware `createScannerCandleFetcher` /
   `VenueCandleFetcher` (orderbook→Binance, swap→GeckoTerminal by network+poolAddress), and the
   caller passes only identifiers. No orderbook-only downgrade. This requires surfacing a scanner
   candle fetcher onto the tool context (§ implementation).
3. **Context factory tolerance.** Confirm the boundary context factory (`bin.ts`) builds a
   `TradingToolContext` for a read tool for an owner **without** a venue account (a pure market read
   must not require one). Verified as part of implementation; if it forces venue-account resolution,
   the read path must tolerate its absence.

## 6. Scope summary + why it's small

- **`evaluate_regime`:** already done (`check_regime`). herobids re-points `coordinator.ts` +
  `evidence-adapters.ts` regime calls at `check_regime`. No Traderton code.
- **`score_candidate`:** one new thin read tool wrapping the existing `scoreCandidate`, fetching
  candles behind the boundary via the existing machinery. Authored surface = the tool adapter + Zod
  schema + registration + a copied test. No new trading logic.
- Candle-fetching resolved as behind-the-boundary (settles Q2 §4 and Q3 candle-fetcher).

## 6b. IMPLEMENTED (2026-09-08, branch `q2-read-tools`)

`score_candidate` built and verified. Changes:
- **`packages/worker/src/tools/strategy.ts`** (new) — `scoreCandidateTool` (`read-market-data`),
  builds a `ScannerCandleTarget` (orderbook | swap), fetches candles behind the boundary via
  `ctx.scannerCandleFetcher`, calls `scoreCandidate`, returns `{ signal, candlesEvaluated }`
  (signal may be `null` = valid no-signal). Uses the canonical `IndicatorConfigSchema` from
  `@traderton/domain` for the config (no `z.record`).
- **`packages/worker/src/tools/strategy.test.ts`** (new) — 8 adapter tests (orderbook + swap
  fetch-behind-boundary, null passthrough, guards, rate-limit mapping, read-only category).
- **`packages/worker/src/tools/index.ts`** + **`packages/worker/src/index.ts`** — export
  `strategyTools` + `createScannerCandleFetcherFromConfig`.
- **`packages/boundary/src/registry.ts`** — register `strategyTools`.
- **`packages/boundary/src/subject-resolver.ts`** — THE read-tool seam: read-only categories
  short-circuit to a minimal injection (ownerId+actorId), skipping the venue-account requirement
  (a pure market read needs none — resolves OQ3). Venue fields left empty (never consumed by a read).
- **`packages/domain/src/trading/tool-contract.ts`** — add optional `scannerCandleFetcher` to
  `TradingToolContext`.
- **`packages/worker/src/scanner-candle-fetcher.ts`** — add `createScannerCandleFetcherFromConfig`
  (builds the fetcher + rate limiters from `marketData` config; keeps market-data internals out of
  the boundary package).
- **`packages/boundary/src/bin.ts`** — wire `scannerCandleFetcher` onto the context (undefined when
  `marketData` absent → tool degrades to `market_data_not_configured`).

Verified: `pnpm build` clean; `pnpm lint` clean; full suite **2389 passed / 39 skipped / 0 failed**
(+8 new). `evaluate_regime` needs NO Traderton code (already `check_regime`).

### Review + rework (2026-09-08, CodeReviewer)

Independent review: the critical authorization question (does the read-only resolver short-circuit
create a cross-owner hole?) → **NO HOLE**. Read tools enforce ownership by `ctx.agentId` (set from
the signed subject on both resolver branches); the empty venue coords are never consumed by a read;
`isReadOnlyCategory` matches the dispatcher's own read/write split. Reworked the review findings:
- **HIGH (fixed):** added 3 subject-resolver unit tests for the seam — read category returns the
  minimal injection; a read succeeds with zero venue accounts (where a write fails
  `precondition.not_ready`); a read never consults the bot row even when the payload names a `botId`.
- **MEDIUM (documented, not fixed):** the candle-fetch double-acquire (~half throughput) is inherent
  to the copied `createScannerCandleFetcher`; per copy-never-author it is NOT re-authored here —
  documented in `scanner-candle-fetcher.ts` as a tracked follow-up (share one bucket per provider
  inside the copied fetcher).
- **LOW:** noted, no change (timeoutMs/maxWaitMs conflation; per-call swap fetcher is correct).

Re-verified: build + lint clean; full suite **2392 passed / 39 skipped / 0 failed** (+3 resolver tests).

## 7. Next step (on approval)

1. Resolve OQ1–OQ3 (category, swap scope, context-factory check).
2. Author `scoreCandidateTool` + schema + registration on a Traderton branch (off `l3-p1-provision`
   or a fresh `q2-read-tools` branch — human's call).
3. Copy the parity test for the scoring path (copy-never-author the assertions from the source
   scan-engine tests).
4. Verify: `pnpm build` + `pnpm lint` + `pnpm test` green; the new tool dispatches read-only.
5. Pause for review; then the herobids re-point of the 3 call sites is a separate herobids slice
   (its brief references `check_regime` + `score_candidate`), gated on the human merge gate.
