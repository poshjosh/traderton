# Phase 5 Plan (SEED) — `@traderton/venues`

**Phase:** 5 of the roadmap ([009](../009-extraction-roadmap.md)).
**Shape:** clean-package (+ one internal seam — browser-pool).
**Depends on:** `@traderton/domain` + `@traderton/market-data` (both done). NOT engine/db.
**Status:** SEED — drafted at end of Phase 4 from a light investigation of herobids
`packages/venues`. The executing agent MUST run step 1 (investigate) and finalize this plan
(step 2) against the real herobids code before implementing. Do not treat this seed as final.

## Dependency graph (light investigation, 2026-09-06)
`packages/venues/package.json` prod deps: `@herobids/domain`, `@herobids/market-data`, `ccxt`,
`viem`, `ws`; devDep `@types/ws`. Import sweep of `src/**`: non-relative imports are
`@herobids/domain` (50), `@herobids/market-data` (2), `ws` (4), `viem`/`viem/accounts`/`viem/chains`
(7), `ccxt` (4), `node:crypto` (4), `vitest` (tests). No db/engine/llm/platform-package imports.
No `@herobids/tests` fixtures. **Depends on the just-landed `@traderton/market-data`** — this is
the first phase with a second Traderton workspace dep.

## Scope (verify at step 1)
~40 files: venue adapters + streams — Hyperliquid (`hyperliquid.ts`, public/private stream,
mark-source), Bybit (`bybit.ts`, public/private stream, info, tickers), Jupiter swap
(`jupiter-swap.ts` + `jupiter-confirmation.ts`), 1inch swap (`oneinch-swap.ts`); shared
`stream-pool.ts` (PublicStreamPool), `rate-limiter.ts`, mark sources (`oracle-mark-source.ts`,
`hyperliquid-mark-source.ts`), signers (`evm-signer.ts`, `solana-signer.ts`), confirmations
(`evm-confirmation.ts`, `swap-confirmation-poller.ts`), `wallet-generation.ts`, `candle-fetcher.ts`.
Integration tests (`*.integration.test.ts` for bybit/hyperliquid/oneinch) are credential-gated —
expect them to skip without creds (note in ledger, like the Phase 2 db integration tests).

## THE ONE SEAM — `browserless-adapter.ts` (platform browser-pool → Intentional Divergence)
`browserless-adapter.ts` imports `BrowserPoolPort`, `BrowserSession`, `BrowserPoolError` from
`@herobids/domain` — types Phase 1 **deleted** from the domain slice (the `browser-pool` port).
Investigation confirms it is a **headless-browser session-pool client** (acquires CDP browser
sessions from a Browserless service via `fetch /json/new`) — a platform web-scraping/browser
concern, NOT a trading venue adapter. Consumer check across herobids: `BrowserlessAdapter` is
consumed only by `apps/worker/src/agent.ts` (platform agent runtime) + re-exported by the venues
barrel. No trading consumer. **This is the same pattern as engine's wake-gate: platform coupling
that needs a Phase-1-dropped domain port, orphaned of trading consumers → cut by deletion**
(`browserless-adapter.ts` + `browserless-adapter.test.ts` + its barrel export). Intentional
Divergence, not a stop-gate. (Guard: confirm at implement time that NO other venues file imports
the browser-pool types; if a trading adapter needs them, STOP and classify.)

## Method (copy-and-delete)
1. Scaffold `@traderton/venues` (deps `@traderton/domain` + `@traderton/market-data` workspace:* +
   `ccxt`/`viem`/`ws`; devDep `@types/ws` + `@types/node`; tsconfig references `../domain` +
   `../market-data`). Wire root tsconfig refs + vitest alias `@traderton/venues`. `pnpm install`.
2. Copy `packages/venues/src/**` verbatim; namespace-rename `@herobids/*`→`@traderton/*`
   (imports only). Get it compiling as a copy; build + copied tests green (verbatim baseline —
   note the browser-pool type import will be the only compile error, exactly like engine's wake-gate).
3. Cut the browser-pool seam: delete `browserless-adapter.ts` + `browserless-adapter.test.ts` +
   the barrel export. Build + copied tests green.

## Per-symbol domain-import diff (do at step 1 — the Phase 3/4 lesson)
Enumerate every domain symbol the venues package imports and check each against the
`@traderton/domain` barrel. Expected: all present EXCEPT `BrowserPoolPort`/`BrowserSession`/
`BrowserPoolError` (the browser-pool seam). If any OTHER symbol is missing → new seam, STOP.

## Stop-gates (per 009)
- A venues file (other than browserless-adapter) needing a Phase-1-dropped domain type, uncuttable
  by deletion → source-fix request.
- A venue adapter pulling a platform service that isn't a clean deletion → classify; escalate.
- Any venue behavioural divergence (order types, mark sources, rate limits) → consequential, STOP.

## Deliverables / acceptance
- `@traderton/venues` compiles strict against `@traderton/domain` + `@traderton/market-data`; lint clean.
- All copied venue UNIT tests green; integration tests may skip on missing creds (note in ledger).
- Forbidden-import sweep: no `@herobids/*`, no llm, no platform, no db/engine imports.
- Ledger updated: Venue adapters table (Hyperliquid/Bybit/Jupiter/1inch/PublicStreamPool/mark
  sources/rate limiter/wallet gen/candle fetcher) → Met with evidence; browser-pool →
  Intentional divergence row; note credential-gated integration tests.
- Mark Phase 5 Done in 009; seed Phase 6 (`strategy` mechanical slice) plan.

## Review checklist (from 009 lessons)
- Per-symbol domain-import diff (find seams before copying).
- Sweep ROOT config (vitest aliases, tsconfig refs, package.json, pnpm-workspace).
- Kept tests unmodified except the namespace rename. Verbatim comments stay verbatim.
- Integration-test skips are expected (credential-gated) — do not mark Met on unit tests alone
  where a venue's behaviour needs live validation; note the gate like Phase 2 db.
- State guards, not optimistic "expected clean".
