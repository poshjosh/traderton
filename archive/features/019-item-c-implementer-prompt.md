# 019 — Item C Implementer Prompt (decision-intake surface)

**Status:** ready to hand to an implementer.
**Task:** implement Phase 9b **item C** — the in-process decision-intake surface (execution only, **NO
human approvals**): a thin decision router + a plain `Map<string, ExecutionActor>` registry over the
already-copied actor-owned intake, the venue-account-direct resolver seam, and `AgentTradingActor`
construct+register.
**Authoritative brief:** [013 §5](./013-9b-authoring-plan.md) (the LOCKED decisions + manifest) and
[017](./017-item-c-intake-proposal.md) (design record + herobids investigation). Read both. This prompt
is the actionable checklist; **013 §5 wins on any conflict.**

---

## 0. Orient first (do not skip)

You are working in **Traderton** (`/Users/chinomso.ikwuagwu/dev_ai/traderton`), a trading library being
extracted from **herobids** (`/Users/chinomso.ikwuagwu/dev_ai/herobids`, READ-ONLY source) by
copy-and-delete. Read the project memory named in [AGENTS.md](../../AGENTS.md) (000/001/004 at minimum),
then [013 §1 + §5](./013-9b-authoring-plan.md) and [017](./017-item-c-intake-proposal.md). Assume you have
**no chat context** — everything you need is in those docs, this prompt, and the cited source files.

**The governing law still applies here:** item C is one of the few *authored* pieces. You author **wiring
+ one thin seam only** — every trading primitive (risk gate, planner, executors, the actor-owned intake
`getIntakeDeps`/`getDecisionContext`/`getPosition`, `submitDecisionForExecution`, `validatePerTradeLevels`)
is ALREADY COPIED into `@traderton/*` (Phase 8 for the worker actors, Phase 3 for the engine). You must not
re-implement or alter any of them. If you find yourself writing trading logic (not wiring/routing), STOP —
the seam is mis-drawn.

**Ports-carry-values invariant (000/004):** the handler routes a decision **value** to the actor-owned
intake and drives the copied engine; the registry holds actor **references**; the resolver receives an
injected `venueAccountId` **value**. Nothing here may inject risk/planner/executor/reconciliation behaviour.

## 1. The context that reshaped this item (read once, then act)

013 originally described item C as "copy the intake resolver bodies + one seam." **The investigation
([017 §2](./017-item-c-intake-proposal.md)) found that was wrong**, and the decision is now locked:

- herobids has **two** intake paths. **Path 1 = actor-owned intake** (`AgentTradingActor`/`TradingActor`
  implement `ExecutionActor.getIntakeDeps/getDecisionContext/getPosition`) — **already copied into
  Traderton** (`packages/worker/src/execution-actor.ts` + `agent-trading-actor.ts` + `trading-actor.ts` +
  `validate-trade-instrument.ts` + `venue-instrument-cache.ts`). **Path 2 = the grant-fallback**
  (`AgentIntakeResolver` + `ActorStateOwner`), which resolves capital/venue-account from the platform
  `agents` table + the `agentConnections ⋈ connections` grant join **when no actor is running**.
- **LOCKED DECISION (a):** require a running actor; **DROP** the grant-fallback + `ActorStateOwner`. No
  actor → `instance_not_running` (an existing copied rejection code). This is an **Intentional Divergence**
  (already logged in [001](../../docs/001-parity-ledger.md) + [003](../../docs/003-anomalies-and-deviations.md)) — the
  grant-fallback is the legacy pre-actor path and IS the connection-grant front-end already placed
  consumer-side (decisions 11–13; the Phase-8 `resolveBotStartupContext` cut). Do **not** copy
  `agent-intake-resolver.ts`, `actor-state-owner.ts`, `agent-intake-fallback.ts`, or reference the `agents`
  table / `AgentRepository` (absent from `@traderton/db` — by design).

## 2. The three LOCKED decisions (013 §5.1 — do not re-litigate)

- **(a) Require a running actor; DROP the grant-fallback.** As above. No `AgentIntakeResolver`, no
  `ActorStateOwner`, no `agents`-table dependency, no grant join.
- **(b) Item B's factory owns the `actorRegistry`** (`Map<string, ExecutionActor>`). Item C receives it
  (injected) and the handler resolves actors from it; register/deregister are exposed by B and used by C
  when it constructs the `AgentTradingActor`. B and C compose over **one** map — do not create a second.
- **(c) Item C constructs + registers the `AgentTradingActor`** (deferred from item B). Item C authors
  construction + registration + exposes the start/stop hook; the **lifecycle driver** (who calls
  start/stop) is item D / the M1 consumer — **not** item C. Do not author a session manager.

## 3. Scope — what you are building (and NOT building)

**Building (authored):**
1. an **`actorRegistry: Map<string, ExecutionActor>`** wiring — a plain map, owned by item B's factory
   (extend `createTradingRuntime` to construct it and expose `register`/`deregister` + pass it to the
   handler). NOT `ActorStateOwner`.
2. an **authored slim decision handler** `submitDecision(...)` that routes a submitted decision to the
   registered actor's intake and drives the copied engine (see §5).
3. an **authored composite `DecisionIntakeResolver`** (running-actor branch ONLY — see §5 step 1), if you
   keep herobids' resolver indirection; or fold the registry lookup directly into the handler. Either is
   fine — the running-actor branch is the whole behaviour.
4. an **authored venue-account-direct resolver seam** — validates the injected `venueAccountId` + the
   venue-account-existence guards Traderton owns; replaces `resolveActiveBinding`'s grant join.
5. **`AgentTradingActor` construction + registration** — build its `AgentTradingActorDeps` from the item-B
   singletons + `buildAgentRiskLimits` + a per-actor `createFillFirstMarkSource`, register in the map,
   expose a construct+register hook (+ a stop/deregister hook).
6. an **authored handler test** (labelled AUTHORED).

**NOT building** (route to owning item — §7): human approvals; the drive that CALLS `submitDecision`;
`InstanceEventPublisher` event emits; the `AgentTradingActor` lifecycle driver; per-`ownerId` maxBots; any
REST. Expose seams/hooks for these; author none of them.

## 4. What to DROP from the herobids reference (the copy-and-delete of the handler)

Trace source: herobids `apps/worker/src/agents/agent-decision-handler.ts` (`handleDecisionSubmit`) and the
composite resolver at `apps/worker/src/index.ts:818–864`. The herobids handler is ~897 lines because it
interleaves platform concerns. **Keep only the execution pipeline; drop these branches** (all
platform/consumer-owned, verified in the source read):

| Dropped branch (herobids) | Why |
|---------------------------|-----|
| step 1 `agentRepo.getAgent` paused/stopped gate | needs `agents` table (platform); consumer owns agent lifecycle |
| step 2 `isActiveSession`/`stale_session` gate | agent session lifecycle (platform) — `ActorStateOwner` territory |
| step 3/3a `authorizationMode` + the entire `approval_required` block (short codes, `approvalRepo`, Telegram, `emitDecisionPendingApproval`, user notifications) | **approvals are consumer-owned**; `decision_approvals` deleted ([004](../../docs/004-decision-log.md)) |
| the `agentState.canUseGrantFallback(...) → agentIntakeResolver.*` fallback arms in the composite resolver (index.ts:834, 843, 852) | **the dropped grant-fallback** (decision a) — keep only the `actor?.isRunning` arm |
| the `updateRiskLimits` refresh that reads `agentRepo.getAgent(instanceId)` (index.ts:820–831) | its source is the `agents` table (platform). Either drop the runtime-refresh, or refresh from injected values — do NOT read `agents`. Prefer dropping it for M1 unless a copied injected source exists; if you drop it, note it as a small divergence in 013 §5 / the ledger |
| all `eventPublisher.emit*` / `publish*` / `recordFailure`(decisionFailureRepo) side-channels | event emits → **item C2** (M1 no-op stub); do not wire `InstanceEventPublisher` here |

**Keep (author as wiring):** the step-4-onward execution pipeline — `getIntakeDeps` (+ `isIntakeRejection`
handling), the instrument-mismatch check (skip for `actorType === 'agent'`), `getDecisionContext`,
`getPosition`, build the `Decision`, the `validatePerTradeLevels` per-trade-level check (the
`POSITION_GROWING_INTENTS` block), `submitDecisionForExecution(decision, context, position, intakeDeps)`,
the `safetyOverrideId` merge, `recordExecutionOutcome`, and the `DecisionContextHashMismatchError` →
typed-rejection catch. Return a typed result (accepted / rejected{code,message,retryable} / error) — the
same status vocabulary herobids' `setSyncReply` used (`accepted`/`rejected`/`error`), **minus**
`pending_approval` (dropped).

## 5. Exact shape of the authored handler

Proposed layout (confirm against Traderton conventions; the guard is "compiles green + reads clean"):
`packages/worker/src/composition/decision-intake.ts` (handler + registry wiring + venue-account resolver
seam + `AgentTradingActor` construct/register) + `.../decision-intake.test.ts` (authored test). Keep the
registry construction in `create-trading-runtime.ts` (item B's factory) per decision (b).

`submitDecision(decision-input)` flow (drive the COPIED engine; author no trading logic):
1. **Resolve the target `ExecutionActor`** from the registry by actor id. If none or `!actor.isRunning` →
   return `instance_not_running` (retryable). **This is the whole "no grant-fallback" decision** — there
   is no second arm. (Reference: index.ts:818–864, keep only the `actor?.isRunning` branch.)
2. `const intake = await actor.getIntakeDeps(instrumentId)` → if `isIntakeRejection(intake)` return the
   typed rejection (`code`/`message`/`retryable`); if `undefined` return `instance_not_running`.
   Do NOT re-implement the circuit-breaker counters unless a copied helper provides them — the breaker
   state in herobids lived on the handler; for M1 keep the rejection typed and simple, and record any
   dropped breaker nuance as a small divergence if you drop it.
3. instrument-mismatch check: if `intake.actorType !== 'agent'` and `instrumentId !== intake.symbol` →
   `instrument_mismatch` rejection. (Agents are multi-symbol — skip.)
4. `getDecisionContext` → none ⇒ `no_context`; `getPosition` → none ⇒ `no_position_state`.
5. build the `Decision` (verbatim field mapping from the reference: `venueAccountId` comes from
   `intake.venueAccountId` — this is the injected value that flowed through the venue-account-direct seam,
   NOT a grant join).
6. `validatePerTradeLevels` for position-growing intents with SL/TP (the `POSITION_GROWING_INTENTS` block).
7. `submitDecisionForExecution(decision, context, position, depsWithOverride)`; handle
   `result.riskRejected` / `result.preExecutionRejection` / `result.executionFailed` /
   `result.executionResult` → map to the typed result; call `actor.recordExecutionOutcome?.(success)`.
8. catch `DecisionContextHashMismatchError` → `context_hash_mismatch` rejection; other throws →
   `execution_error`.

**Venue-account-direct resolver seam (§5.1 / 017 §3.4):** the injected `venueAccountId` is what the
actor's own intake already carries (the actor was constructed with it — bots via item B, the agent actor
via §6 below). The "seam" is: **validate the venue-account-existence guards Traderton owns**
(`missing_source_venue_account`, `source_venue_account_not_found` — these codes exist in the copied
`IntakeRejectionCode` closure / the actor's intake) and **never** resolve the platform connection-grant
guards. In practice, if the copied actor-owned `getIntakeDeps` already returns those venue-account
rejections, the seam is satisfied by routing through the actor — confirm this in `agent-trading-actor.ts`
and do not author a parallel grant resolver.

## 6. `AgentTradingActor` construct + register (decision c)

Construct the agent-direct actor and register it (its lifecycle driver is item D). Build
`AgentTradingActorDeps` (defined in `packages/worker/src/agent-trading-actor.ts:99`) — it mirrors the
bot `TradingActorDeps` item B populated, but agent-flavoured (multi-instrument):
- singletons from item B: `venueAdapterFactory`, `journal`, `idGen`, the 8 repos, mark source, stream pool.
- `riskLimits` via **`buildAgentRiskLimits`** (the AGENT path — `packages/worker/src/agent-risk-limits.ts`),
  NOT the bot inline mapping. Its inputs (`capital`, `riskPosture`, `agentRiskDefaults`, `riskOverrides`)
  are **injected values** (from the consumer / config), NOT read from an `agents` row.
- `venueAccountId` = **injected** (decisions 11–13). `markSource` = per-actor
  `createFillFirstMarkSource({ actorId: agentId, fallbackSource: <B's markSelector>, ... })`.
- status/event callbacks (`onJournalEvent`, `emitAgentWake`, `onTechnicalScanComplete`, etc.) → **M1 no-op
  stubs** (→ item C2). `onCrashed` → deregister from the registry (trading lifecycle, keep).
- swap-token-safety deps stay as item B left them (`swapTokenSafety: undefined`) — the existing Deferred
  divergence covers it; do not re-open it.

Expose `constructAndRegisterAgentActor(...)` + a `stopAndDeregisterAgentActor(agentId)` hook. Do **not**
call them from a session manager — item D / the consumer drives lifecycle.

## 7. Exclusions — do NOT author these here (route to the owning item)

| Excluded | Goes to | Note |
|----------|---------|------|
| the **drive** that CALLS `submitDecision` (`publishToInbound` / redis `agent:decision:reply:*`) | item D | C authors the handler; D calls it |
| `InstanceEventPublisher` emits (accepted/rejected/plan/exec/pending events) | item C2 | M1 = no-op stubs |
| human approvals (`approval_required`, short codes, Telegram, `approvalRepo`) | consumer-owned | dropped ([004](../../docs/004-decision-log.md)) |
| `AgentTradingActor` **lifecycle driver** (who start/stops it) | item D / M1 consumer | C exposes construct+register + stop hooks only |
| agent paused/stale-session gates, `AgentRepository` | consumer-owned | needs the `agents` table (absent by design) |
| per-`ownerId` maxBots | item E | — |
| M2 REST boundary | item F | — |

## 8. Guardrails / stop-gates (surface, do not push past)

- **Any temptation to read the `agents` table / `AgentRepository`** → STOP; that is the dropped
  grant-fallback / platform surface (decision a). The inputs come from injected values.
- **Any temptation to write trading logic** (risk, planning, execution, position math — not routing) →
  STOP; the seam is mis-drawn (ports-carry-values).
- **A missing copied dependency** (a symbol the handler/actor construction needs that isn't in a Traderton
  barrel) → STOP; it is a seam, not something to author. Surface it (like item B surfaced the live-gate).
- **The grant-fallback turns out to be needed for a legitimate running-actor decision** → STOP and
  re-read 017 §4; it should not be — the running-actor branch is self-sufficient.
- Do NOT edit any copied module to make wiring fit — if a copied module does not compose, surface it.

## 9. Verification (authored — no copy oracle)

- `pnpm build` green, `pnpm lint` clean (`tsc --noEmit`).
- **Existing 2244 copied tests stay green** (you add a surface; you change no copied module). If a copied
  test breaks, you altered something you shouldn't have — revert and reconsider.
- **Authored handler test** (`decision-intake.test.ts`, clearly labelled AUTHORED — not a copied oracle),
  deterministic (stub `ExecutionActor` + stub engine boundary; do NOT stub the handler's own routing):
  - a registered, running stub actor receives a routed decision → the handler drives
    `submitDecisionForExecution` and returns `accepted` (with plan id) on success.
  - a decision for an **unregistered** (or `isRunning === false`) actor → `instance_not_running`.
  - an actor whose `getIntakeDeps` returns an `IntakeRejection` → that typed rejection is surfaced.
  - a `validatePerTradeLevels` failure → typed `level.*` rejection.
  - (optional) a `DecisionContextHashMismatchError` from the engine boundary → `context_hash_mismatch`.
- **Trace** the handler's kept path against herobids `agent-decision-handler.ts` step 4→8 (§4 above) and
  the composite resolver's `actor?.isRunning` arm (index.ts:818–864) so it is reviewable against the
  reference, diverging only where 013 §5 / this prompt says (drop grant-fallback, drop approvals, drop
  session/paused gates, no-op event emits).

## 10. Done criteria + docs

- Build/lint/tests green; `@traderton/worker` still consumable through its barrel; the handler + registry
  + agent-actor construct/register are exported where item D can reach them.
- Update: [001](../../docs/001-parity-ledger.md) — move the `submit_decision` **intake/execution** surface toward
  Met (note the drive path is item D, events are item C2); the grant-fallback Intentional Divergence row is
  already present (no new row needed — just cross-reference item C as implemented). Update
  [013 §5](./013-9b-authoring-plan.md) item C → DONE with the authored-vs-copied manifest of what you
  actually wrote, and note any seam you surfaced (e.g. the `updateRiskLimits` refresh source, or a missing
  symbol). Record any Outstanding Issues (non-CRITICAL/HIGH) from CodeReviewer at the bottom of 013.
- Commit as its own logical commit ("9b item C: decision-intake surface").
- **Then PAUSE** — item D (drive target + tools) is next and is gated on human review of C.

## 11. Key file map (start here)

Traderton (copied — reuse, do not alter):
- `packages/worker/src/execution-actor.ts` — `ExecutionActor` contract, `IntakeResult`, `IntakeRejection`,
  `IntakeRejectionCode` (incl. `instance_not_running`), `isIntakeRejection`.
- `packages/worker/src/agent-trading-actor.ts` — `AgentTradingActor` (+ `AgentTradingActorDeps` at :99,
  the struct you populate; its actor-owned `getIntakeDeps`/`getDecisionContext`/`getPosition` at ~:841–974).
- `packages/worker/src/trading-actor.ts` — `TradingActor` (bots; also an `ExecutionActor`, registered by B).
- `packages/worker/src/agent-risk-limits.ts` — `buildAgentRiskLimits` (the agent risk path).
- `packages/worker/src/composition/create-trading-runtime.ts` — item B's factory (extend it to own the
  `actorRegistry` + expose register/deregister + pass it to the handler).
- `@traderton/engine` — `submitDecisionForExecution`, `validatePerTradeLevels`,
  `DecisionContextHashMismatchError`, `DecisionIntakeDeps`, `DecisionContext`, `PositionState`, `RiskLimits`.
- `@traderton/domain` — `Decision`, `DecisionId`, `VenueAccountId`, `InstrumentId`, `Decimal`, intents.

herobids (READ-ONLY reference — trace, never import):
- `apps/worker/src/agents/agent-decision-handler.ts` — `handleDecisionSubmit`; **keep step 4→8, drop the
  rest** (§4). `POSITION_GROWING_INTENTS`/`formatLevelValidationMessage` live in
  `apps/worker/src/shared/decision-validation.ts`.
- `apps/worker/src/index.ts:818–864` — the composite `DecisionIntakeResolver`; **keep the `actor?.isRunning`
  arm, drop the `agentState.canUseGrantFallback → agentIntakeResolver` arms**.
- `apps/worker/src/agents/agent-intake-resolver.ts`, `actor-state-owner.ts`, `agent-intake-fallback.ts` —
  the DROPPED grant-fallback / session machinery. Read them once to confirm the seam; do **not** copy them.
