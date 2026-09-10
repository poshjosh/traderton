# Phase 4 Plan (FINAL) — `@traderton/market-data`

**Phase:** 4 of the roadmap ([009](../009-extraction-roadmap.md)).
**Shape:** clean-package (no seams).
**Depends on:** `@traderton/domain` (done). NOT engine/db/venues.
**Status:** FINAL — investigated (step 1) against real herobids `packages/market-data` on
2026-09-06. Supersedes the seed.

## Why this is a clean-package phase with ZERO seams (step 1 findings)
`packages/market-data/package.json` prod deps: `@herobids/domain` + `node-html-parser`. An import
sweep of `src/**` shows the ONLY non-relative imports are `@herobids/domain`, `node-html-parser`
(used only by `economic-calendar.ts`), and `vitest` (tests). No db/engine/venues/llm/platform
imports; no `@herobids/tests` fixtures. `redis-cache.ts` uses an **injected** `RedisCacheClient`
interface (no direct ioredis import) — no extra dep needed.

**Per-symbol domain-import diff (the Phase 3 lesson — done up front):** market-data imports exactly
these 8 domain symbols — `EconomicEvent`, `EconomicCalendarResult`, `EconomicCalendarError`,
`EconomicCalendarProvider`, `Result`, `ok`, `err`, `PriceCandle`. **All 8 survive in the Traderton
domain slice** (`EconomicCalendar*` via `ports/economic-calendar.ts` → `ports/index.ts` → barrel;
`PriceCandle` via `ports/candle-fetcher.ts`; `Result`/`ok`/`err` via `values`). So — unlike engine's
`WakeGateConfig` — there is **no missing domain type and no seam to cut.** market-data copies whole
and compiles against `@traderton/domain`. (Guard: re-verify at implement time by building; if any
symbol turns out unexported from the barrel, that is the seam — STOP and classify.)

## Scope (verify at step 1)
~43 source files: candle fetchers (`binance-candles`, `geckoterminal`, `candle-registry`),
provider clients (`birdeye`, `coinmarketcap`, `dexscreener`, `hyperliquid-info`, `bybit-info`,
`bybit-tickers`, `scrapfly`), `price-service`, discovery (`discovery`, `discovery-seen-tracker`,
`token-search`, `token-safety`), analysis (`indicators`, `regime`, `economic-calendar`),
infra (`cache`, `redis-cache`, `provider-registry`, `rate-limiter`, `http`, `types`). All
indicators/discovery/analysis — **no LLM** (matches decisions 8–9: mechanical intelligence is fine).

## Method (copy-and-delete)
1. Scaffold `@traderton/market-data` (package.json: deps `@traderton/domain: workspace:*` +
   `node-html-parser`; tsconfig references `../domain`). Wire root tsconfig ref + vitest alias
   `@traderton/market-data`. `pnpm install`.
2. Copy `packages/market-data/src/**` verbatim; namespace-rename `@herobids/*`→`@traderton/*`
   (imports only). Get it compiling as a copy; build + copied tests green.
3. No seam-cut step: step 1 found no internal platform seam. The verbatim copy IS the deliverable
   (unlike engine, there is no wake-gate-equivalent to delete). If implement-time finds a seam,
   fall back to the per-phase pattern (classify → delete or escalate).

## Seams — NONE found at step 1 (guards retained)
- Domain-import diff: clean (all 8 symbols present — see above).
- No `@herobids/tests` fixtures in market-data tests.
- Provider clients (`scrapfly`/`birdeye`/`coinmarketcap`/`geckoterminal`/etc.) take injected
  config via `provider-registry`/`http`/`RequestGate` — no platform-config import to cut (verify
  at implement time; if a provider imports platform config, that is a seam — STOP and classify).

## Stop-gates (per 009) — none expected; the guards
- A market-data file needing a domain symbol not exported by the Traderton barrel, uncuttable by
  deletion → source-fix request. (Not expected: the 8-symbol diff is clean.)
- Any LLM/platform coupling that isn't a clean deletion → classify; escalate if consequential.

## Deliverables / acceptance
- `@traderton/market-data` compiles strict against `@traderton/domain`; lint clean.
- All copied market-data tests green.
- Forbidden-import sweep: no `@herobids/*`, no llm, no platform, no engine/db/venues imports.
- Ledger updated: "Market data / discovery", "Mechanical strategies" (regime/scan inputs) rows →
  Met with evidence; any divergence recorded.
- Mark Phase 4 Done in 009; seed Phase 5 (`venues`) plan.

## Review checklist (from 009 lessons)
- Per-symbol domain-import diff (Phase 3 lesson: find the one seam before copying).
- Sweep ROOT config (vitest aliases, tsconfig refs, package.json, pnpm-workspace) for stale/added refs.
- Kept tests unmodified except the namespace rename. Verbatim comments stay verbatim.
- State guards, not optimistic "expected clean".
