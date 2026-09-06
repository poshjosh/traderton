# Phase 3 Plan (SEED) — `@traderton/engine`

**Phase:** 3 of the roadmap ([009](../009-extraction-roadmap.md)).
**Shape:** clean-package (+ internal seams).
**Depends on:** `@traderton/domain` (done). NOT db/venues/market-data (engine is domain-only).
**Status:** SEED — drafted at end of Phase 2 from the dependency graph. The executing agent
MUST run step 1 (investigate) and finalize this plan (step 2) against the real herobids
`packages/engine` code before implementing. Do not treat this seed as the final classification.

## Why this is a clean-package phase
Verified (Phase 1 investigation): `packages/engine/src` imports ONLY `@herobids/domain`
(137 imports, all via domain ports) — no db, venues, market-data, or llm. So engine can be
copied whole and compiled against `@traderton/domain`; it reaches venues/db/marks only through
domain port interfaces (dependency injection), not imports. ~34 source files.

## Goal
Extract `@traderton/engine` verbatim: risk gate, order manager + order-state machine, planner
(`planDecision`), executors (Paper/Shadow/Live/SwapLive incl. live timeout mgr + recovery),
position/equity/daily-loss trackers + rehydrate, fill accounting, stop-loss monitor +
per-trade-level validator, circuit breaker (per venue), fee simulator + paper slippage, journal
(event types), trading cycle (`runTradingCycle`), decision intake (`submitDecisionForExecution`
+ context-hash guard), instrument executor (`executeDecision`), reconciliation (orderbook + swap
loaders), wake gate, mark source/selector. Compiles strict against `@traderton/domain`; all
copied engine tests green.

## Highest-stakes surface — RISK GATE
`packages/engine/src/risk-gate.ts` `checkRisk()` is the highest-stakes parity surface
([001](../001-parity-ledger.md) risk-gate table). Its exact rules + error codes must reproduce
verbatim; risk-reducing plans (`close`/`reduce`) bypass entry-side checks. **The copied risk-gate
parity tests are the acceptance gate — they must pass unmodified.** Any divergence here is
consequential (stop-gate). Do not touch risk logic beyond namespace rename.

## Method
Copy-and-delete. Copy the whole `packages/engine` verbatim, compile as a copy against
`@traderton/domain`, bring engine tests across (parity harness), then cut any internal platform
seam by deletion. Build + copied tests green after each step. Wire into root tsconfig refs +
vitest aliases (`@traderton/engine`).

## Likely internal seams to investigate (step 1)
- **`wake-gate`**: domain dropped `WakeGateConfig` (platform, Phase 1). If engine's wake-gate
  imports it, that's a seam — check whether engine's wake-gate is trading (fill/mark-driven) or
  the platform preset-review wake. Classify; delete or seam per findings. Possible stop-gate if
  it needs a dropped domain type.
- Any engine file importing a domain symbol deleted in Phase 1 (LLM/agent-policy/platform-assess
  types). The domain slice is already trading-only, so such an import = a real seam to resolve.
- Confirm executors reach venues/db ONLY via domain ports (expected), not direct imports.

## Stop-gates (per 009)
- Risk-gate behavioural divergence → consequential, escalate.
- An engine file needing a domain type Phase 1 deleted, where deletion/seam can't cut it without
  authoring → source-fix request.
- Any capability herobids will rely on Traderton for that can't be cleanly copied → Deferred-
  REQUIRED ledger entry (per the herobids-becomes-a-consumer model, 000/004).

## Deliverables / acceptance
- `@traderton/engine` compiles strict against `@traderton/domain`; lint clean.
- All copied engine tests green — **risk-gate parity tests especially**.
- Forbidden-import sweep: no `@herobids/*`, no llm, no platform imports.
- Ledger updated: risk-gate exact-rules table + engine-subsystems rows → Met with evidence;
  any divergence/deferral recorded.
- Seed the Phase 4 (`market-data`) plan.

## Review checklist additions (from Phase 1/2 lessons — 009)
- Sweep ROOT config (vitest aliases, tsconfig refs) for stale/added references.
- Check for stray/0-byte/untracked files in the package.
- Verify kept tests are unmodified except for removed deleted-subject blocks.
- Confirm the plan stated guards, not optimistic "expected clean".
