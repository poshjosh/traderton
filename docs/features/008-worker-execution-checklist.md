# Phase 8 — `apps/worker` Execution Checklist (self-followable)

**Derived from:** [008-worker-plan.md](./008-worker-plan.md) (finalized) + a read-only import/edge
investigation of herobids `apps/worker/src` (2026-09-06). This is the concrete, ordered, green-gated
procedure. Milestone: **M1** (in-process library; no API). Source is READ-ONLY.

**Governing law:** copy, never author. Authored = deletions, `@herobids/*`→`@traderton/*` rename,
package scaffolding, and the ONE sanctioned type-relocation seam (scan-types) below. Build + copied
tests green after EVERY step. Small commits. Stop at the residual stop-gates.

> **STATUS (2026-09-06): Phase 8 BLOCKED on herobids source-fix request #2** (relocate 5 trading
> types out of `agent-protocol.ts`/`config/schema.ts` — see `docs/003` + `.ignore/source-fix-request/002-…`).
> The mechanical loop is copied (uncommitted in `packages/worker/`) but cannot compile green until
> Traderton re-syncs `@traderton/domain` with the relocated types. **Two pieces are also deferred as
> `Deferred (required for cutover)`, authored at M1-integration/Phase 9, NOT copied:** (i) `config.ts` /
> `AppConfig` → a Traderton-owned config shape (decision 2); (ii) the `index.ts` trading composition
> root (no faithful subset exists — actors are constructed by deleted startup/session/intake wiring).
> So Phase 8's deliverable is the **loop MODULES + copied parity tests (green)** as the M1 library
> surface, once the source-fix lands. `config.ts` and the composition root are excluded from the
> "verbatim copy" scope and tracked as deferred authoring.

## Investigation findings that shape this checklist (verified, not assumed)

- **CORRECTION (2026-09-06, at implement time):** the original KEEP list included a 5-file
  agent decision-intake/approval/session cluster — `agents/agent-intake-resolver.ts`,
  `agents/agent-decision-handler.ts`, `agents/actor-state-owner.ts`, `services/approval-service.ts`
  (and, transitively, `agents/instance-event-publisher.ts`). Reading them in FULL (not just top-level
  imports) showed they are **platform**, not the mechanical loop, and cannot be copied without
  authoring: they need symbols MISSING from the Traderton barrels (`agentConnections`, `AgentRepository`,
  `MessageEnvelope`, `DecisionSubmitPayload`, `getProviderIdsForRuntimeFamily`), and
  `agent-intake-resolver`'s `resolveActiveBinding()` is built on the dropped `connections`/`agentConnections`
  grant model (a "venue-account-direct" version would be AUTHORED, not copied). Consumer check: the 5-file
  cluster is imported ONLY by platform composition roots (`index.ts`, `agents/index.ts`,
  `agent-message-broker`, `agent-session-manager`, `market-intelligence/*`, …) — **zero mechanical
  trading-loop files import them.** → **Reclassified DELETE (Intentional Divergence).** The
  decision-intake / agent-grant-resolution / human-approval capabilities become **Deferred (required for
  cutover)**, owned by **Phase 9** (`apps/api` — where the boundary + venue-account-direct resolver are
  authored deliberately, per decision 4 + M1/M2). This is a clean deletion, so no source-fix is warranted.
- **The reduced KEEP set (39 mechanical files) is import-closed:** verified — **zero** KEEP→non-KEEP
  relative edges (incl. `import type`), the only non-KEEP relative edge being `./runtime-composition`
  (the sanctioned scan-types seam, Step 3). This is the copyable mechanical trading loop.
- **(superseded)** ~~all 41 KEEP files import only extracted packages + each other~~ — the top-level-only
  edge scan missed the cluster's `import type` + runtime-value edges into DELETE files; corrected above.
- **Reclassification (correction to the seed):** `venue-intelligence.ts` and `intelligence-tools.ts`
  are **DELETE**, not KEEP. They are imported only by `agent.ts` (DELETE), `scout-gating.ts` (DELETE),
  `tools/market-data.ts` (Phase 9), and the deleted `runtime-composition.ts` body — **no Phase-8 KEEP
  file imports them.** Their removal also eliminates the only consumer of the fat agent type
  `RuntimeSessionMetrics`, so the scan-types relocation stays clean.
- **`startup-context.ts`** is imported only by `index.ts` (+ its own test) → isolated; delete it,
  inject `venueAccountId` (decision 2, plan).
- **`runtime-composition.ts` scan-types seam:** exactly 5 KEEP files import from it, all **type-only**:
  `agent-trading-actor.ts` (`TechnicalScanState`), `complete-technical-scan.ts` (`ScannerHealthResult`,
  `TechnicalScanState`), `tick-gates.ts` (`RuntimeActiveWatchSummary`), `watch-types.ts`
  (`RuntimeActiveWatch`). (`venue-intelligence.ts`'s `RuntimeSessionMetrics`/`RuntimePositionSnapshot`
  import is moot — that file is DELETE.) The scan-types closure is mechanical-only:
  `TechnicalScanState` → `RegimeResult`(market-data)/`ScoredSignal`(strategy)/`PositionIndicatorUpdate`+
  `SymbolFetchOutcome`(technical-phase, KEEP)/`HybridPricingIdentity`(domain)/`ScannerHealthResult`;
  `RuntimeActiveWatch` → `WatchPurpose`/`WatchCoverageLink`/`WatchInstrumentIdentity`(watch-types, KEEP);
  `RuntimePositionSnapshot`/`ScannerHealthResult`/`RuntimeActiveWatchSummary` → primitives + `RuntimeFreshness`.
- **Parity tests are trading-owned:** `agent-risk-limits.parity.test.ts`, `agent-risk-limits.test.ts`,
  `cross-venue-lifecycle.test.ts`, `trading-actor.test.ts`, `agent-trading-actor(.lifecycle).test.ts`
  import only `@herobids/domain`(+`engine`) + relative KEEP files.

## KEEP set (41 non-test files + their `.test.ts`)

Actors/runtime: `trading-actor`, `agent-trading-actor`, `execution-actor`, `runtime`, `instance-lease`,
`actor-health-publisher`. Venue/instrument: `venue-adapter-factory`, `venue-instrument-cache`,
`public-stream-routing`, `reconciliation-orphaned-cleanup`, `instrument-population`,
`token-safety-adapter`, `swap-token-resolver`, `swap-instrument-id`, `resolve-swap-assets`,
`validate-trade-instrument`, `swap-startup-validation`. Scan: `technical-phase`,
`complete-technical-scan`, `scanner-candidate-discovery`, `scanner-candle-fetcher`, `scanner-pre-filter`,
`swap-candidate-discovery`, `candle-fetch-breaker`, `candle-fetch-retry`. Risk/gating:
`agent-risk-limits`, `live-gate`, `tick-gates`, `tick-gate-state`, `position-coverage`,
`watch-types`. (`tick-thinking` reclassified DELETE — agent scout/judge reasoning.) Utils: `config`, `redis-keys`, `crypto`, `logger`, `fmt`, `prompt-timing-context`,
`tool-result-metadata`. From subdirs: `shared/decision-validation` (mechanical per-trade-level validation, confirm it needs only
domain/engine at implement time).

**REMOVED from KEEP (reclassified DELETE — see CORRECTION above):** `agents/agent-decision-handler`,
`agents/agent-intake-resolver`, `agents/actor-state-owner`, `services/approval-service`,
`agents/instance-event-publisher`. These are the platform decision-intake/approval/session cluster;
their capabilities are Deferred-required for Phase 9.

**New file authored (sanctioned seam):** `scan-types.ts` (holds the relocated scan value-types).

## DELETE set (platform — Intentional Divergence)

`agent.ts`, `structured-tool-loop.ts`, `hybrid-agent-evaluator.ts`, `hybrid-agent-prompt.ts`,
`hybrid-decision-sizing.ts`, `runtime-composition.ts` (body — after type-split), `runtime-errors.ts`,
`runtime-degradation.ts`, `runtime-resilience.ts`, `runtime-tool-visibility.ts`, `llm-selection.ts`,
`scout-dispatch.ts`, `scout-gating.ts`, `context-diff.ts`, `cost-profile.ts`, `usage-billing-service.ts`,
`agent-wake-scheduler.ts`, `agent-capabilities.ts`, `agent-intake-fallback.ts`,
**`tick-thinking.ts`** (reclassified DELETE 2026-09-06 — resolves agent scout/judge `ReasoningLevel`;
only `agent.ts` consumes it; no mechanical KEEP file imports it),
`assessment-review-message.ts`, `manual-review-runtime.ts`, `reminder-coordinator.ts`,
`browser-pool-health-publisher.ts`, `gmail-adapter.ts`, `gmail-credential-resolver.ts`, `tar-utils.ts`,
`user-event-publisher.ts`, `startup-context.ts`, **`venue-intelligence.ts`**, **`intelligence-tools.ts`**,
**`agents/agent-decision-handler.ts`, `agents/agent-intake-resolver.ts`, `agents/actor-state-owner.ts`,
`services/approval-service.ts`, `agents/instance-event-publisher.ts`** (the reclassified intake/approval
cluster — Deferred-required, Phase 9), `backtest-runtime.ts` (imports `@herobids/llm` — platform LLM
backtest orchestration), dirs `agent-evaluation/`, `alerting/`, `market-intelligence/`,
`__tests__/integration/`, platform `agents/*` (ALL — no KEEP files remain there), platform `tools/*`
(all — the trading-tool modules are Phase 9).

## Ordered procedure (green-gate after each step)

### Step 0 — branch/baseline
- Confirm clean tree at the M1-docs commit. Note current whole-repo test count (baseline 1314 passed).

### Step 1 — Scaffold the worker package (M1 library surface, no API)
- Create the worker package dir (recommend `apps/worker` to mirror source layout; it's a workspace member).
- `package.json`: name `@traderton/worker`, type module, `build: tsc --build` + `clean`, scripts NO `dev`/`start`
  server entry required for M1 (library surface) — keep `build`/`clean` at minimum; deps = extracted
  `@traderton/{domain,db,engine,venues,market-data,strategy,backtesting}` (workspace:*) + sanctioned infra
  actually imported by the KEEP set (`bullmq`, `ioredis`, `drizzle-orm`, `pino`, `pino-pretty`, `yaml`, `zod`) —
  **NO** `@herobids/llm`/`@traderton/llm`, `@herobids/documents`, `@aws-sdk/*`, `@mozilla/readability`, `linkedom`,
  `zod-to-json-schema` (verify each against actual KEEP imports at implement time; drop any not imported).
  devDeps `@types/node`, `@types/ws` if needed.
- `tsconfig.json`: extends base, outDir/rootDir, exclude tests, references domain+db+engine+venues+market-data+
  strategy+backtesting (only those the KEEP set imports — trim to actual).
- Wire root `tsconfig.json` ref + `vitest.config.ts` alias `@traderton/worker` (+ ensure `@traderton/tests` alias
  already present). `pnpm install`.
- **Green-gate:** `pnpm install` clean; empty package builds.

### Step 2 — Copy the KEEP set verbatim + namespace rename
- Copy each KEEP `.ts` + its `.test.ts` from source verbatim. Copy the 3 KEEP `agents/*`, `shared/decision-validation`,
  `services/approval-service`. Do NOT copy any DELETE file.
- Rename `@herobids/*`→`@traderton/*` in imports only. Verbatim comments/strings stay verbatim (Phase 3/7 lesson).
- **Do NOT yet** fix the `runtime-composition.js` type imports (Step 3 handles them) or the `startup-context` import
  (Step 4). Expect the copy to not compile until those seams are cut — that's fine (Phase 3 precedent).
- **Green-gate (partial):** the copied test files that don't depend on the two open seams should be collectable;
  full build waits for Steps 3–4.

### Step 3 — Cut the scan-types seam
- Create `scan-types.ts`; move VERBATIM from `runtime-composition.ts` these + their closure:
  `RuntimeFreshness`, `RuntimePositionSnapshot`, `RuntimeActiveWatch`, `RuntimeActiveWatchSummary`,
  `ScannerHealth`, `ScannerHealthResult`, `TechnicalScanState`, and the `export type { HybridPricingIdentity }
  from '@traderton/domain'` re-export. (These are copied lines, relocated — not authored shapes.)
- Repoint the 5 KEEP importers' `from './runtime-composition.js'` → `from './scan-types.js'`
  (`agent-trading-actor`, `complete-technical-scan`, `tick-gates`, `watch-types` — and any other KEEP file the
  build flags). Type-only imports; no logic touched.
- Do NOT copy `runtime-composition.ts` at all (its body is platform → DELETE; only its scan value-types survive,
  relocated). Confirm no KEEP file still imports `./runtime-composition`.
- **Green-gate:** `scan-types.ts` compiles against domain/market-data/strategy/technical-phase/watch-types.

### Step 4 — Cut the startup-context seam (inject venueAccountId)
- Do NOT copy `startup-context.ts`/`.test.ts` (platform grant front-end → Intentional Divergence).
- In the trading composition (Step 5), the code path that consumed `startupContext.resolvedVenueAccountId` now
  receives an **injected `venueAccountId`** (the M1 consumer supplies it). Bring across ONLY the venue-account
  existence guards (`missing_source_venue_account`, `source_venue_account_not_found`) where they live in the kept
  path; the connection-grant guards stay herobids (not copied).

### Step 5 — Split index.ts into a trading composition root
- From source `index.ts`, keep ONLY the trading-composition assembly (WorkerRuntime wiring, stream pool, venue-adapter
  factory, both actors, reconciliation, actor-health, scanner) + the injected-`venueAccountId` startup path. Drop the
  platform composition (agent-evaluation, alerting, market-intelligence, agents/*, manual-review, reminder,
  browser-pool, usage-billing, llm, documents, **the decision-intake/approval cluster**) and the maxBots start-guard
  (Deferred-required; not copied).
- **The decision-intake wiring (agent-decision-handler/intake-resolver/approval) is OUT** — that surface is Phase 9.
  The M1 composition assembles the loop (actors + scan + reconcile) with an injected `venueAccountId` and an open
  drive injection point; it does NOT wire a `submit_decision` intake path in Phase 8.
- Leave the drive injection point OPEN — no API/broker driver authored (M1: consumer drives in-process).
- This is the largest hand-assembly; keep it a faithful subset of source lines (delete platform blocks in place),
  not a re-authored file. If, after removing the platform + intake blocks, a clean faithful-subset trading composition
  is not possible without authoring non-trivial glue → **STOP-GATE** (it may mean the trading composition in source is
  too entangled with the intake wiring to subset — surface it; the loop itself, driven by tests, still lands).

### Step 6 — AgentTradingActor callback seam
- Leave the optional agent callbacks (`emitAgentWake?`, `onTechnicalScanComplete?`, `onJournalEvent?`,
  `onPersistScanCandidates?`, `onPersistScanMetrics?`) UNWIRED (fail-open when absent — source already does this).
  No code change beyond not injecting them from the composition root.

### Step 7 — Delete confirmation + forbidden-import sweep
- Confirm no DELETE file was copied. Grep the worker src: no `@herobids/*`, no `@traderton/llm`, no `@herobids/llm`,
  no `documents`/`@aws-sdk`/`readability`/`linkedom` imports, no `./runtime-composition`, no `./startup-context`,
  no `./venue-intelligence`, no `./intelligence-tools`, no platform `agents/*` or `tools/*` imports.

### Step 8 — Full green
- `pnpm --filter @traderton/worker build`, `pnpm lint`, `pnpm test`. All copied trading-loop tests green
  (`agent-risk-limits.parity`, `cross-venue-lifecycle`, `trading-actor`, `agent-trading-actor`+lifecycle,
  scanner/technical-scan, tick-gates, etc.). Note any gated/integration skips. Report counts.

### Step 9 — Docs + mark Done
- Ledger 001: trading-loop / actor / scan / stream-pool rows → Met with evidence; `create_bot`/`start_bot` remain
  `Deferred (required for cutover)`; add Intentional Divergence rows for the worker platform deletions
  (agent runtime, evaluation, alerting, market-intelligence, browser-pool, gmail, usage-billing, startup-context
  connection front-end, venue-intelligence, intelligence-tools) — nothing silently dropped.
- 009: Phase 8 → Done with commit range + green evidence + lessons.
- Seed Phase 9 (`apps/api`) plan.

## Residual stop-gates (STOP and surface; do not author past)
- Step 5: if the trading composition root can't be a faithful subset of source without authoring non-trivial glue.
- Any KEEP file needing a domain/db/engine symbol not in the Traderton barrels.
- Any copied trading-loop parity test that can't pass unmodified (beyond namespace rename + removed
  deleted-subject blocks).
- Any NEW consequential divergence beyond the four already resolved in the plan.
- `backtest-runtime.ts` / `services/approval-service.ts` / any file whose KEEP-vs-DELETE turns out ambiguous when
  read in full — classify explicitly; if genuinely ambiguous, surface.
