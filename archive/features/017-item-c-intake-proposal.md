# 017 — Decision-Intake Surface (item C) — Proposal

**Status:** APPROVED (2026-09-07, human) — the §4 crux is RESOLVED as **option (a)**; riders §8.2/§8.3
accepted. Decisions locked into [013 §5](./013-9b-authoring-plan.md). This doc is now the design record.
**Phase:** 9b item C (decision-intake surface — execution only, NO human approvals).
**Feeds:** [013-9b-authoring-plan.md](./013-9b-authoring-plan.md) §5 item C.
**Grounding:** read-only investigation of the herobids intake cluster (2026-09-07). Governed by
[000](../../docs/000-vision.md) (ports-carry-values; M1→M2), [004](../../docs/004-decision-log.md) (decisions 7–13;
"Traderton does not own human approvals"), [013 §4.5](./013-9b-authoring-plan.md) (item B exclusions
routed here).

> **The investigation changed the picture from what 013 §4.5 assumed.** 013 described item C as "copy the
> intake resolver bodies + one authored seam (venue-account-direct `resolveActiveBinding`)." Reading the
> code, there are actually **two distinct intake paths**, and the copyable one is *already in Traderton*.
> This reframes the seam and raises a shape question (§4). Nothing is implemented; this is for your call.

---

## 1. What item C is (from 013 §4.5 + decision log)

Author the in-process decision-intake surface that lets a submitted trading decision reach the copied
engine (`submitDecisionForExecution`), plus the `ExecutionActor` registry that item B deferred, plus
constructing/registering the `AgentTradingActor` (agent-direct execution). **Execution only — NO human
approvals** (approvals are consumer-owned; `decision_approvals` deleted; see [004](../../docs/004-decision-log.md)).

## 2. Investigation findings (verified in herobids + Traderton)

### 2a. There are TWO intake paths in herobids — 013 conflated them

**Path 1 — actor-owned intake (ALREADY COPIED into Traderton).**
`AgentTradingActor` implements the `ExecutionActor` contract and provides its **own**
`getIntakeDeps` / `getDecisionContext` / `getPosition` (`agent-trading-actor.ts:841–974`). `TradingActor`
(bots) implements the same contract. When an actor is **running**, it *is* the intake source — decisions
route to the registered actor, which supplies execution context. **This path is already in the Traderton
tree** (Phase 8 copied `AgentTradingActor` + `execution-actor.ts` [the `ExecutionActor`/`IntakeResult`/
`IntakeRejection` contract] + `validate-trade-instrument.ts` + `venue-instrument-cache.ts`).

**Path 2 — grant-fallback intake (ABSENT; agent/platform-coupled).**
`AgentIntakeResolver` (`agents/agent-intake-resolver.ts`, NOT in Traderton) is a **paper-mode fallback for
when NO actor is registered**. It is built on the platform grant model:
- `resolveActiveBinding()` joins `agentConnections ⋈ connections` (deleted platform tables) +
  `getProviderIdsForRuntimeFamily('trading')`.
- `getIntakeDeps()` reads `agentRepo.getAgent(agentId)` (the platform **`agents` table** — absent from
  `@traderton/db`) for `capital` / `risk` / `riskOverrides` / `executionDefaults.mode`, and **fails closed
  unless the agent is paper-mode**.
Its `getDecisionContext` / `getPosition` / `buildPersistence` bodies use only copyable deps, but the class
as a whole is gated on `AgentRepository` + the grant join — i.e. it is the *agent-direct-without-a-running-
actor* convenience, which is platform-shaped.

### 2b. `ActorStateOwner` is not the thin registry 013 assumed
`agents/actor-state-owner.ts` (ABSENT) wraps the registry with **agent-session semantics**
(`pendingSessions`/`ownerSessions`/`grantFallback` keyed on `sessionId`; imports the agent
`agent-intake-fallback.js` machinery). The genuinely-thin, trading-clean part is the underlying
`actorRegistry: Map<string, ExecutionActor>` it holds by reference. The session/fallback wrapper is
platform (agent session lifecycle).

### 2c. What's already present vs absent (Traderton)
- **Present (copied):** `execution-actor.ts` (`ExecutionActor` + `IntakeResult` + `isIntakeRejection`),
  `AgentTradingActor` (+ its actor-owned intake), `TradingActor`, `validate-trade-instrument.ts`,
  `venue-instrument-cache.ts`, `buildAgentRiskLimits`, and the engine `submitDecisionForExecution` /
  `validatePerTradeLevels` / `DecisionContextHashMismatchError`.
- **Absent:** `agent-intake-resolver.ts`, `agent-decision-handler.ts`, `actor-state-owner.ts`,
  `agent-intake-fallback.ts`, `AgentRepository` (the `agents` table — platform), `InstanceEventPublisher`
  (→ item C2), the drive path (`publishToInbound` / redis reply → item D).

## 3. Proposed shape (the clean Traderton intake)

Author a **thin decision router + a plain `Map<string, ExecutionActor>` registry**, over the
already-copied actor-owned intake:

1. **`actorRegistry: Map<string, ExecutionActor>`** — a plain map (NOT `ActorStateOwner`; that's agent
   session machinery). Item B's factory owns it; actors register on start, deregister on stop/crash. Both
   `TradingActor` (bots) and `AgentTradingActor` register here.
2. **An authored slim decision handler** — `submitDecision(decision)`:
   resolve the target `ExecutionActor` from the registry → `actor.getIntakeDeps(instrumentId)` (rejection
   → typed failure) → `actor.getDecisionContext` → `actor.getPosition` → build `Decision` →
   `validatePerTradeLevels` → `submitDecisionForExecution(decision, context, position, intakeDeps)` →
   `actor.recordExecutionOutcome`. This is authored *wiring* that drives the copied engine — it
   re-implements no trading logic. Drops the herobids paused/active-session gates, the `approval_required`
   fork, and the Telegram/pending-approval branches (all platform / consumer-owned).
3. **`AgentTradingActor` construction + registration** — the agent-direct actor deferred from item B:
   build its deps (via the item-B singletons + `buildAgentRiskLimits` + a per-actor `createFillFirstMarkSource`),
   register it in `actorRegistry`. Its lifecycle driver (who starts/stops it) is the M1 consumer /
   item D — item C authors construction + registration + exposes the hook.
4. **The venue-account-direct resolver seam** — replaces `resolveActiveBinding`'s grant join: Traderton
   receives an **injected `venueAccountId`** (decisions 11–13) and validates only the venue-account
   existence guards it owns (`missing_source_venue_account`, `source_venue_account_not_found`), never the
   platform connection-grant guards (those stay consumer-side).

**Ports-carry-values check:** the handler routes a decision **value** to the actor-owned intake + drives
the engine; the registry holds actor references; nothing injects risk/planner/executor behaviour. ✓

## 4. CRUX — RESOLVED 2026-09-07 (human): option (a), drop the grant-fallback

> **DECISION: (a) — Traderton accepts a decision only for a registered, running `ExecutionActor`; no
> actor → `instance_not_running` (an existing copied rejection code). The `AgentIntakeResolver`
> grant-fallback + `ActorStateOwner` session wrapper are NOT copied (Intentional Divergence).**
>
> **Rationale (strengthened by git + code evidence, 2026-09-07):**
> 1. **It is the legacy pre-actor path.** herobids git history: `AgentIntakeResolver` was created
>    2026-06-12 (`d82db5e7` "Enable agents submit trade decisions") as the *original* agent-direct
>    trading path. When the `ExecutionActor`/`AgentTradingActor` concept landed 2026-06-14
>    (`898c82da`, plan `001-agent-execution-actor/001-plan.md`), the resolver was **demoted to a
>    "paper-only fallback … testing, agents with no binding, degraded mode"** (plan doc line 225,
>    verbatim) — its scope narrowed, not deleted. We extract the intended design (the actor), not the
>    demoted vestige.
> 2. **It IS the connection-grant front-end Traderton already cut.** `resolveActiveBinding` returns
>    `{ id: connections.id, venue: connections.provider, venueAccountId: connections.resolvedVenueAccountId }`
>    from `agentConnections ⋈ connections` — i.e. a "binding" is the **agent↔connection grant**. That
>    layer stays platform (decisions 11–13); Traderton takes an injected `venueAccountId`. This is the
>    SAME seam already cut for bots in Phase 8 (the `resolveBotStartupContext` deletion), applied to the
>    agent-direct path. "Agent with no binding" = no active connection grant = a consumer-side grant
>    state → Traderton has no `venueAccountId` to execute against → reject. Not a dropped trading
>    capability; a relocated grant concern (the consumer keeps `agents`/`connections` and its own
>    paper/testing convenience).
>
> Options (b) author a venue-account-direct fallback and (c) defer were **not** chosen. Below is the
> original framing, retained for the record.

### Original framing (for the record)

**What happens when a decision arrives for an actor that is NOT running?** herobids answers with the
`AgentIntakeResolver` **grant-fallback**: a paper-mode path that resolves intake straight from the
`agents` row + the connection grant, *without a running actor*. Traderton cannot copy it cleanly — it
needs the platform `AgentRepository`/`agents` table and the `agentConnections`/`connections` grant join,
none of which Traderton owns.

Options:

- **(a) DROP the grant-fallback — require a running actor (RECOMMENDED).** Traderton accepts a decision
  only for a **registered** `ExecutionActor`; no actor running → typed rejection (`instance_not_running`,
  which already exists in the copied `IntakeRejection` codes). The venue-account-direct resolver's only
  job becomes validating the injected `venueAccountId`. Cleanest; no `agents`-table dependency; matches
  "Traderton owns execution, the consumer owns identity/grants." **Cost:** drops herobids' paper-mode
  "trade before starting an actor" convenience. Is that convenience a parity obligation, or agent-side
  sugar? My read: it's agent-side (it's literally the *agent* grant fallback, paper-only) → droppable as
  Intentional Divergence, recorded.
- **(b) Author a venue-account-direct fallback resolver.** Reproduce `getIntakeDeps` without a running
  actor, but source `venueAccountId` from injection and `capital`/`risk`/`riskOverrides` from… where?
  Those came from the `agents` row. So (b) forces *more* injected ports (an "owner risk profile" port) —
  more authored surface, and it re-creates an agent-shaped concept Traderton deliberately doesn't own.
- **(c) Defer the no-actor path entirely** — item C wires only the running-actor route; the fallback (if
  ever needed) is a later, separately-justified item.

**Recommendation: (a)** — drop the grant-fallback, require a running actor, record it as Intentional
Divergence (agent paper-mode convenience, not a trading-execution obligation). This makes item C a clean
authored router + registry over the already-copied actor-owned intake + the venue-account-direct
validation seam. If you disagree (e.g. the no-actor paper path is a hard parity requirement), that pushes
toward (b) and a bigger authored surface — worth knowing before I spec it.

## 5. Copy-vs-author manifest (under recommendation (a))

| Piece | Bucket | Note |
|-------|--------|------|
| `ExecutionActor`/`IntakeResult` contract | already COPIED | Phase 8 (`execution-actor.ts`) |
| Actor-owned intake (`AgentTradingActor.getIntakeDeps/...`) | already COPIED | Phase 8 |
| `actorRegistry: Map<string, ExecutionActor>` | AUTHORED (trivial) | plain map; NOT `ActorStateOwner` |
| Slim decision handler (route → actor intake → `submitDecisionForExecution`) | AUTHORED (wiring) | drops approval/session/telegram branches |
| venue-account-direct resolver (injected `venueAccountId` + venue-account guards) | AUTHORED (thin seam) | replaces `resolveActiveBinding` grant join |
| `AgentTradingActor` construction + registration | AUTHORED (wiring) | uses item-B singletons + `buildAgentRiskLimits` |
| `AgentIntakeResolver` grant-fallback | DROPPED (Intentional Divergence) | agent paper-mode convenience; needs `agents` table |
| `ActorStateOwner` session/grant-fallback wrapper | DROPPED (Intentional Divergence) | agent session lifecycle (platform) |

## 6. Exclusions — NOT in item C (routed elsewhere)

| Excluded | Goes to | Note |
|----------|---------|------|
| The **drive** that CALLS `submitDecision` (publishToInbound / redis `agent:decision:reply:*`) | item D | C authors the handler; D calls it |
| `InstanceEventPublisher` emits (decision accepted/rejected/plan/exec events) | item C2 | M1 no-op stub in C |
| Human approvals (`approval_required` fork, pending-approval, Telegram) | consumer-owned | dropped ([004](../../docs/004-decision-log.md)) |
| `AgentTradingActor` lifecycle driver (who starts/stops it) | item D / M1 consumer | C exposes the construct+register hook |
| per-`ownerId` maxBots | item E | — |

## 7. Verification plan (authored — no copy oracle)
- Build/lint green; existing 2244 tests stay green.
- Authored handler test (labelled): a registered stub `ExecutionActor` receives a routed decision and the
  handler drives `submitDecisionForExecution`; a decision for an unregistered actor → `instance_not_running`
  rejection; a `validatePerTradeLevels` failure → typed rejection. Deterministic (stub actor + stub engine
  boundary; do not stub the handler's own routing).
- Trace the handler's execution path against herobids `agent-decision-handler.ts` (the non-approval branch)
  so it's reviewable against the reference.

## 8. Open decisions for your steer
1. **§4 crux — (a) drop the grant-fallback / require a running actor [recommended], (b) author a
   venue-account-direct fallback with injected risk profile, or (c) defer the no-actor path.** This is the
   one that shapes item C's size.
2. Registry ownership: item B's factory owns the `actorRegistry` and passes it to the handler + exposes
   register/deregister — agree? (keeps B and C composing over one map.)
3. `AgentTradingActor` in C vs later: confirm C constructs+registers it (per 013 §4.5a it was deferred
   from B to C), with its start/stop lifecycle driver as item D.

On the call for §4 (and 2/3), the decisions were locked into [013 §5](./013-9b-authoring-plan.md) and the
self-contained implementer prompt written as [019-item-c-implementer-prompt.md](./019-item-c-implementer-prompt.md)
(modelled on 016) — next: implement, review, commit, and pause before item D. (The number is 019, not 018;
018 is the 9b continuity handoff.)
