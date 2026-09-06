# Phase 8 Plan (FINAL classification + STOP-GATE) — `apps/worker` (trading loop)

**Phase:** 8 of the roadmap ([009](../009-extraction-roadmap.md)).
**Shape:** subtraction (LARGE, 326 files). Formal keep/delete classification done (step 1, read-only).
**Depends on:** all extracted packages (domain, db, engine, market-data, venues, strategy, backtesting — all done).
**Status:** **BLOCKED (stop-gate)** — classification complete; four coupled boundary/ownership decisions
require human approval before any code moves (009 stop-gates 1–4). See "STOP-GATE" below.

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

## STOP-GATE — four coupled decisions needed before code moves (009 stop-gates 1–4)

1. **Drive-path / 005 boundary shape (stop-gate #1 + shape).** The mechanical decision core
   (`actorRegistry` + `agent-intake-resolver` + `submitDecisionForExecution` + the two actors + `WorkerRuntime`)
   is copyable. But it is driven **today** by the platform `AgentMessageBroker` reading a **Redis stream**
   (`DECISION_SUBMIT`). Traderton must be driven by the **005 HTTPS boundary** (`POST /internal/v1/tools:invoke`
   → `submit_decision`). That driver is **authored boundary infrastructure, not copied trading logic.**
   DECISION: what does Phase 8 copy (in-process actor/intake core, driven by a test/stub harness) vs. what is
   authored, and is the HTTP `submit_decision` handler in Phase 8 or **deferred to Phase 9**?

2. **`startup-context.ts` / `agent-intake-resolver.ts` binding (stop-gate #1 + #3).**
   `resolveBotStartupContext` resolves `bot.connectionId` → `connections.resolvedVenueAccountId` → venue account
   and validates `bot.connectionId`/`bot.userId` — **all dropped by decisions 11–13**; it cannot compile against
   `@traderton/db` and cannot be cut by deletion. Traderton must bind `venueAccountId` **directly** (decision 13).
   DECISION: **herobids source-fix request** to reshape `resolveBotStartupContext` to a venue-account-direct form,
   **or** a Traderton-authored soft-seam resolver? AND: dropping the platform connection-status/mismatch guards
   (`connection_venue_account_mismatch`, `connection_not_usable`, …) is a **consequential behavioural divergence**
   — confirm it is an accepted Intentional Divergence whose safety intent is preserved venue-account-side
   (herobids-on-Traderton not weaker than herobids-today).

3. **`create_bot`/`start_bot` limit KEY (stop-gate #4, shape).** Enforcement today is agent-keyed +
   `agents`-row-locked (`agent-message-broker.ts`, `index.ts` start-guard) — the Phase-2 Deferred-required item.
   Traderton has no `agents` table. DECISION: the new limit key — **per-`ownerId` / per-`venueAccountId` /
   operator config**. This sets Traderton's tenancy/ownership model at the boundary (touches decisions 10–13).
   Do NOT author a speculative key.

4. **Trading-tool ownership: Phase 8 vs Phase 9 (stop-gate #2).** 009 assigns the 25 tool endpoints to Phase 9
   (api). Recommend Phase 8 keeps the loop + actor/intake; Phase 9 owns the tool modules + boundary handlers.
   DECISION: confirm the split (also `user-event-publisher.ts`, `services/approval-service.ts` ownership).

Autonomous ONCE decided: KEEP-core copy, `runtime-composition.ts` type-split, `index.ts` composition-root split,
all platform deletions, the `AgentTradingActor` callback-seam, and bringing the trading-loop parity tests across
(`agent-risk-limits.parity.test`, `cross-venue-lifecycle`, actor-lifecycle, scanner/technical-scan — confirm each
trading-owned at implement time).
