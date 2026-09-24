# L3-Q3 — venues surviving platform uses (classify-and-route)

**Status:** DECIDED (human, 2026-09-08) — **classify-and-route.** The surviving `@herobids/venues`
uses are not one thing; they split three ways. Resolution:
- **`BrowserlessAdapter` → re-home OUT of `venues`** (it is not trading — it is the agentic browser).
- **Venue adapters + wallet-gen → behind the Traderton boundary** (core trading; wallet-gen
  coordinates with L3-P1/L3-P1b provisioning).
- **Candle-fetcher → joined to Q2** (same code path as `evidence-adapters` `scannerCandleFetcher`).
- **Public price stream → resolved without a streaming channel:** the stream follows the executor
  behind the boundary; the platform reads latest price via a plain poll tool.

**Reads:** [CANONICAL-STATE.md](../CANONICAL-STATE.md) (legal-isolation, merge gate),
[L3-Q2-market-intelligence-coupling.md](./L3-Q2-market-intelligence-coupling.md) (the candle-fetcher
join), herobids `docs/features/initial/features/2026/09/10/001-consume-traderton/004-l3d-plan.md` §H (deferred `venues`).

## 1. What Q3 is

`@herobids/venues` is the trading venue-adapter package (exchange adapters Hyperliquid/Bybit, swap
adapters Jupiter/1inch, public/private streams, mark sources, signers, confirmation pollers, wallet
generation). It is trading infrastructure and belongs behind the boundary — but it has **7 surviving
platform importers** blocking its deletion. The L3d report named only "public-stream + BrowserlessAdapter";
the full audit found more, and — the key finding — **they are not all the same kind of thing.** Q3 is a
per-use classification.

## 2. The surviving uses, classified

**Group 1 — genuinely trading (→ behind the boundary):**
- `apps/api/src/routes/accounts.ts` → `HyperliquidAdapter`, `JupiterSwapAdapter`, `OneInchSwapAdapter`.
- `apps/api/src/routes/setup.ts` + `apps/api/src/index.ts` + `apps/api/src/routes/chat.ts` →
  `generateWallet`, `deriveSolanaAddress` (trading-account key/wallet provisioning; overlaps L3-P1/L3-P1b).

**Group 2 — trading market-data feeds (→ behind the boundary, read-style):**
- `apps/worker/src/index.ts` → `PublicStreamPool`; `apps/worker/src/public-stream-routing.ts` →
  `BybitPublicStream`, `HyperliquidPublicStream`, `VenueStreamConnector` (the public price stream — see §4).
- `apps/worker/src/scanner-candle-fetcher.ts` → `VenueCandleFetcher` (candle fetching — **same path Q2
  uses**; classified jointly with Q2 §4).

**Group 3 — NOT trading (misfiled → re-home):**
- `apps/worker/src/agent.ts` → `BrowserlessAdapter` — the **agentic browser** backing the
  `browse_interactive` tool (`browserPool`, implements `BrowserPoolPort` from `@herobids/domain`). It has
  nothing to do with trading; it merely lives in the `venues` package. Core to the agentic product.

All other `venues` imports in surviving code are `import type` (cheap to sever).

## 3. Public price stream — how it is actually consumed (the crux, resolved)

We initially framed the stream as a hard boundary problem: an exchange WebSocket pushes prices
continuously (yes — that is the current herobids state), and a never-ending push flow does not fit a
request/response boundary. Investigation showed that framing is wrong. Evidence (all in
`packages/engine/src/stream-market-data-feed.ts` + `shadow-executor.ts`):

- **Almost every consumer reads latest-value from a map, not a flow.** `StreamMarketDataFeed` keeps a
  `tickers` map; consumers call `getTicker(symbol)` (ShadowExecutor L49/104/138/143/191; the
  market-intelligence regime path). That is a **read**, not a flow.
- **The only true per-tick consumer is the ShadowExecutor** (`shadow-executor.ts:251` registers an
  `onTrade` handler for a limit-order fill heuristic — "did a trade print at my limit price?"). That is
  **trading execution**, in `engine`, being extracted behind the boundary anyway.
- **The code already treats polling as an equal substitute.** `StreamMarketDataFeed` has a
  `fallbackFetcher`: on socket failure it polls and populates the *same* ticker map, and even
  **synthesizes trade events** from polled prices so the per-tick heuristic keeps working. The author
  already decided the live stream is an optimization, not a requirement.

**Therefore the streaming-boundary problem dissolves:**
- The stream that feeds the executor **follows the executor behind the boundary** — Traderton owns the
  venue socket because Traderton runs the executor that consumes it. No flow crosses the wire.
- The platform's only remaining price need (market-intelligence) is **latest price / candles** — a plain
  **poll read tool**, the same family as Q2's `evaluate_regime`. No websocket-over-boundary, no push channel.

## 4. Decision (recorded)

**Classify-and-route:**
1. **`BrowserlessAdapter`:** re-home out of `@herobids/venues` into a platform/agentic module (where the
   browser tooling lives). Pure re-home, not a boundary decision. Removes a non-trading blocker cleanly and
   serves the agentic focus. *Quick win — independently sequenceable, unblocks nothing-else-dependent.*
2. **Venue adapters (`Hyperliquid`/`Jupiter`/`1inch`) + `generateWallet`/`deriveSolanaAddress`:** behind the
   boundary. Wallet-gen coordinates with L3-P1/L3-P1b (provisioning). API `accounts.ts`/`setup.ts`/`chat.ts`
   become boundary calls.
3. **`VenueCandleFetcher` (candle-fetcher):** decided jointly with **Q2 §4** (identical `scannerCandleFetcher`
   path). Whatever Q2 concludes for candle-fetching (payload-carries-candles vs fetch-behind-boundary) applies
   here.
4. **Public price stream:** **stream follows the executor behind the boundary; platform reads latest price via
   a poll tool. No streaming channel on the boundary is needed.** (§3.)

Only after all four are routed does `@herobids/venues` lose its last surviving platform importer and become
deletable from herobids.

## 5. Next step (the investigate→propose→pause slice)

1. **`BrowserlessAdapter` re-home** — smallest, independent; can go first as a quick win.
2. Design the boundary surface for the venue adapters + wallet-gen (coordinate with L3-P1b so provisioning
   and adapter access share one design).
3. Public-price read tool (`get_latest_price` or similar) — the platform's poll replacement for the stream;
   confirm the ShadowExecutor's stream is fully on the Traderton side of the boundary (no platform consumer
   left needing a flow).
4. Candle-fetcher — resolve under Q2.
5. herobids-side re-point + delete `venues` once all importers are gone. All gated on the human merge gate;
   Traderton-side additions on a branch; herobids-side by the other agent; I coordinate + review.
