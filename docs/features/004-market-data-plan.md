# Phase 4 Plan (SEED) — `@traderton/market-data`

**Phase:** 4 of the roadmap ([009](../009-extraction-roadmap.md)).
**Shape:** clean-package.
**Depends on:** `@traderton/domain` (done). NOT engine/db/venues.
**Status:** SEED — drafted at end of Phase 3 from a light investigation of herobids
`packages/market-data`. The executing agent MUST run step 1 (investigate) and finalize this plan
(step 2) against the real herobids code before implementing. Do not treat this seed as final.

## Why this is a clean-package phase (light investigation, 2026-09-06)
`packages/market-data/package.json` prod deps: `@herobids/domain` + `node-html-parser`. An import
sweep of `src/**` shows the ONLY non-relative imports are `@herobids/domain` (4 occurrences),
`node-html-parser` (1), and `vitest` (tests). No db/engine/venues/llm/platform imports. `redis-cache.ts`
uses an **injected** `RedisCacheClient` interface (no direct ioredis import) — no extra dep needed.
So market-data copies whole and compiles against `@traderton/domain`.

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
   (imports only). Get it compiling as a copy; build + copied tests green (verbatim baseline).
3. Cut any internal seam by deletion (none obvious from the light sweep — investigate).

## Likely seams to investigate (step 1)
- Confirm none of the 4 `@herobids/domain` imports reference a domain symbol Phase 1 dropped
  (per-symbol diff against the Traderton domain barrel, the Phase 3 lesson).
- Confirm `scrapfly`/`birdeye`/`coinmarketcap` etc. carry no platform key-management coupling that
  a deletion must cut (they may take injected config/keys — verify they don't import platform config).
- Any test using a `@herobids/tests` fixture → mirror via `@traderton/tests` (Phase 3 precedent),
  fixture copied verbatim.

## Stop-gates (per 009)
- A market-data file needing a domain type Phase 1 deleted, uncuttable by deletion → source-fix request.
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
