# Phase 8 Plan (FINAL classification + STOP-GATE) — `apps/worker` (trading loop)

**Phase:** 8 of the roadmap ([009](../009-extraction-roadmap.md)).
**Shape:** subtraction (LARGE, 326 files). Formal keep/delete classification done (step 1, read-only).
**Depends on:** all extracted packages (domain, db, engine, market-data, venues, strategy, backtesting — all done).
**Status:** **ACTIVE (stop-gate resolved 2026-09-06, human-approved).** The four boundary/ownership
decisions are settled — see "RESOLVED DECISIONS" below (and the RESOLVED entry in
[003](../../docs/003-anomalies-and-deviations.md)). Execution is now the mechanical loop laid out in "Method".

## RESOLVED DECISIONS (human-approved)

1. **Drive-path / boundary — NO API layer in Phase 8 (this is M1).** This is the **M1 library
   milestone** ([000-vision.md](../../docs/000-vision.md) "Two consumption milestones"). Traderton
   (pre-authoring) is packaged as a **library**; herobids consumes its in-process intake core (`actorRegistry` + `agent-intake-resolver` +
   `submitDecisionForExecution` + the two actors + `WorkerRuntime`) to **replace its existing in-process
   trading**. herobids stays the consumer and drives the core **in-process** (as it does today) — the
   platform message-broker/Redis-stream driver stays in herobids. The 005 REST/API layer is built **later**
   (Phase 9 / final authoring pass), layered above the intake core. **Phase 8 authors no boundary code**;
   it copies the intake core as a library surface and leaves the injection points open.
2. **`resolveBotStartupContext` — delete as Intentional Divergence; inject `venueAccountId`; NO source-request.**
   The connection→venueAccount front-end is a platform grant file and cuts cleanly by deletion (it terminates
   in a `venueAccountId` string; the whole venue-account-onward trading path already takes `venueAccountId`).
   Delete `startup-context.ts` (+ test). Copy the venue-account-onward path verbatim; it takes an injected
   `venueAccountId`. **Guard split on the ownership line:** connection-grant guards (`connection_not_usable`,
   `connection_venue_account_mismatch`, `missing_connection_id`, `connection_not_found`) stay herobids;
   venue-account existence guards (`missing_source_venue_account`, `source_venue_account_not_found`) move to
   Traderton (copied where they live in the kept path). Do NOT keep a hollowed `startup-context.ts`.
3. **`create_bot`/`start_bot` limit — Deferred-required; NOT source-request; NOT authored now.** No
   behaviour-preserving reshape exists (herobids' limit is `agents.maxBots`/`plan.entitlements`-keyed —
   platform; the atomic `BotRepository` limit methods were deleted Phase 2). Phase 8 copies the mechanical
   create/start path with **no native limit**. The capability stays `Deferred (required for cutover)` on the
   `create_bot`/`start_bot` rows + the cutover gate; **per-`ownerId` enforcement is authored in the final
   authoring pass** alongside the API/tenancy model. Cutover blocked until it lands (never ships weaker).
4. **Trading-tool ownership — Phase 8 = loop + intake core; Phase 9 = the 25 tool modules + boundary.**
   Confirmed per 009. Phase 8 keeps `agents/agent-decision-handler.ts` + `agents/agent-intake-resolver.ts`
   (venue-account-direct, connection binding dropped) + `agents/actor-state-owner.ts` + `shared/decision-validation.ts`;
   the `tools/` trading modules (`trading.ts`, `bots.ts`, `risk-limits.ts`, …) move in Phase 9.

## Classification (from the read-only context-gather, 2026-09-06)

The mechanical trading loop **can** be separated from the agent runtime at the module level: the KEEP core
imports only `@traderton/{domain,db,engine,venues,market-data,strategy,backtesting}` + node/bullmq/ioredis/
drizzle/pino/zod/yaml. Every platform *package* dep (`@herobids/llm`, `@herobids/documents`, AWS SES,
`@mozilla/readability`, linkedom) is a **clean deletion**. bullmq + ioredis stay as sanctioned infra
(precedented in venues/engine).

### KEEP (trading-loop, mechanical)
`trading-actor.ts` (self-driven bot loop), `agent-trading-actor.ts` (mechanical execution/scan context —
name is misleading; imports zero platform markers; agent coupling is only *optional injected callbacks*
`emitAgentWake?`/`onTechnicalScanComplete?`/`onJournalEvent?`/`onPersist*?` — cut by leaving them unwired),
`execution-actor.ts`, `runtime.ts` (`WorkerRuntime` — bullmq trading-instance-lifecycle queue + leases),
`instance-lease.ts`, `actor-health-publisher.ts`, `venue-adapter-factory.ts`, `venue-instrument-cache.ts`,
`public-stream-routing.ts`, `reconciliation-orphaned-cleanup.ts`, `instrument-population.ts`,
`technical-phase.ts`, `complete-technical-scan.ts`, `scanner-*`, `swap-candidate-discovery.ts`,
`candle-fetch-breaker/retry.ts`, `token-safety-adapter.ts`, `swap-token-resolver.ts`, `swap-instrument-id.ts`,
`resolve-swap-assets.ts`, `validate-trade-instrument.ts`, `swap-startup-validation.ts`, `live-gate.ts`,
`config.ts`, `redis-keys.ts`, `crypto.ts`, `logger.ts`, `fmt.ts`, `position-coverage.ts`, `watch-types.ts`,
`agent-risk-limits.ts` (mechanical risk contract — `agent-risk-limits.parity.test` subject),
`tick-gates.ts`/`tick-gate-state.ts`/`tick-thinking.ts` (mechanical gating — re-verify tick-thinking),
`intelligence-tools.ts`, `venue-intelligence.ts`, `prompt-timing-context.ts`; `agents/agent-decision-handler.ts`
+ `agents/agent-intake-resolver.ts` (SEAM, see below) + `agents/actor-state-owner.ts` (`actorRegistry`);
`shared/decision-validation.ts`; `services/approval-service.ts` (confirm at implement time).

### DELETE (platform)
`agent.ts` (174KB LLM agent runtime), `structured-tool-loop.ts`, `hybrid-*`, `runtime-composition.ts` (body —
see type-split seam), `runtime-errors/degradation/resilience/tool-visibility.ts`, `llm-selection.ts`,
`scout-*`, `context-diff.ts`, `cost-profile.ts`, `usage-billing-service.ts`, `agent-wake-scheduler.ts`,
`agent-capabilities.ts`, `agent-intake-fallback.ts`, `assessment-review-message.ts`, `manual-review-runtime.ts`,
`reminder-coordinator.ts`, `browser-pool-health-publisher.ts`, `gmail-*`, `tar-utils.ts`,
`user-event-publisher.ts` (confirm); dirs `agent-evaluation/`, `alerting/`, `market-intelligence/`,
most of `agents/` (session-manager, message-broker, runtime-launcher, docker/nomad, stream-consumer, health,
reconnect, crash-loop, ephemeral-redis, capability-policy, sandbox), platform `tools/*`
(code/shell/filesystem/browser/email/messaging/skills/memory/tasks/web-access/http-client/workspace/ssrf),
`__tests__/integration/`.

### SEAM (within-file / within-app)
- **`index.ts` (135KB):** genuinely half trading-composition-root, half platform-composition-root. Split into
  a **trading composition root** (KEEP, assembled from copied parts) + platform root (stays herobids). The
  split point + the boundary-driver wiring is authored → part of stop-gate #1.
- **`runtime-composition.ts`:** DELETE the platform body, but relocate the mechanical scan value-types it
  exports (`TechnicalScanState`, `ScannerHealth(Result)`, `RuntimePositionSnapshot`, `HybridPricingIdentity`
  re-export) into a small `scan-types.ts` beside `complete-technical-scan.ts` (thin type-relocation seam;
  Intentional Divergence; autonomous once the shape is approved).
- **`tools/` trading modules** (`trading.ts`, `bots.ts`, `risk-limits.ts`, `account.ts`, `analytics.ts`,
  `price.ts`, `market-data.ts`, `watch.ts`, `find-instrument.ts`, `resolvers.ts`, `schema.ts`): the 25-tool
  surface — **009 assigns the 25 tool endpoints to Phase 9 (api)**. Ownership question below.

## Method (execution — now unblocked)

`apps/worker` is an APP but Phase 8 ships it as a **library surface** (decision 1 above): a Traderton worker
package that exposes the in-process intake core + the mechanical loop, consumable by herobids in-process. No
REST/API. Copy-and-delete, leaf-first, build + copied tests green after each step, small commits.

1. **Scaffold** a Traderton worker package (deps on the extracted `@traderton/*` packages + bullmq/ioredis/
   drizzle/pino/zod/yaml — the sanctioned infra; NO `@herobids/llm`/`documents`/SES/readability/linkedom).
   Mirror Traderton toolchain conventions (decision 16); retarget operator config (Redis/DB URLs, queue/service
   names) to Traderton (decision 1), not copied verbatim. Wire root tsconfig ref + vitest alias.
2. **Copy the KEEP set verbatim** (see classification) + namespace-rename `@herobids/*`→`@traderton/*`. Bring the
   trading-loop parity tests across (`agent-risk-limits.parity.test`, `cross-venue-lifecycle`, actor-lifecycle,
   scanner/technical-scan — confirm each trading-owned at implement time).
3. **Cut the seams:**
   - Delete `startup-context.ts` (+ test) — Intentional Divergence (decision 2 above); the kept path takes an
     injected `venueAccountId`.
   - `runtime-composition.ts`: relocate the mechanical scan value-types (`TechnicalScanState`, `ScannerHealth(Result)`,
     `RuntimePositionSnapshot`, `HybridPricingIdentity` re-export) into a small `scan-types.ts` beside
     `complete-technical-scan.ts`; delete the platform body (thin type-relocation seam).
   - `index.ts`: split into a **trading composition root** (KEEP, assembled from copied parts) + drop the platform
     composition. Leave the drive injection point open (herobids-consumer drives in-process).
   - `AgentTradingActor`: leave the optional agent callbacks (`emitAgentWake?`/`onTechnicalScanComplete?`/…) unwired
     (fail-open when absent, as source already does).
   - Delete all platform files/dirs per the classification (`agent.ts`, `hybrid-*`, `agent-evaluation/`, `alerting/`,
     `market-intelligence/`, platform `agents/*`, platform `tools/*`, llm/documents/ses coupling).
4. **Guard split (decision 2):** connection-grant guards stay herobids; venue-account existence guards
   (`missing_source_venue_account`, `source_venue_account_not_found`) come across where they live in the kept path.

## Acceptance
- Traderton worker library compiles strict against the extracted packages; lint clean.
- Copied trading-loop tests green (note any gated/integration tests).
- Forbidden-import sweep: no `@herobids/*`, no llm, no documents/ses, no platform agent-session imports.
- Ledger updated: trading-loop / actor / scan rows → Met with evidence; `create_bot`/`start_bot` remain
  `Deferred (required for cutover)` (per-`ownerId` limit authored at final pass); every deleted platform
  subsystem recorded as Intentional Divergence; nothing silently dropped.
- Mark Phase 8 Done in 009; seed Phase 9 (`apps/api`) plan.

## Stop-gates during implementation (residual guards)
- If a KEEP file needs a domain/db/engine symbol not in the Traderton barrels → source-fix request.
- If a KEEP file's platform coupling can't be cut by deletion without authoring non-trivial trading logic → stop.
- If a trading-loop parity test can't pass unmodified (beyond namespace rename + removed deleted-subject blocks) → stop.
- Any NEW consequential divergence beyond the four resolved above → stop and surface.
