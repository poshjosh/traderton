# 018 — 9b Continuity / Handoff

**Status:** living handoff — update as work advances.
**Created:** 2026-09-07
**Purpose:** let a fresh agent (or a future me) resume Phase 9b **exactly where we stopped** without
re-deriving the session. Read this first, then the linked docs. It captures live state + the one
pending decision; the durable detail lives in the docs it points to (don't duplicate — trust them).

---

## 0. First: read the project memory (mandatory)

Per [AGENTS.md](../../AGENTS.md), read `docs/000`–`009` (at least 000 vision, 001 ledger, 003 anomalies,
004 decision-log, 009 roadmap). The governing law is **copy, never author** — every line of trading
behaviour arrives by copying from herobids (`/Users/chinomso.ikwuagwu/dev_ai/herobids`, READ-ONLY);
the only authored things are deletions and thin seams. We are in **Phase 9b**, the sanctioned authoring
pass, deliberately **minimised** (most of 9b is still copy-and-delete; only a small bounded core is authored).

## 1. Where we are (one paragraph)

Extraction is essentially complete through the copy phases; we are partway through the **9b authoring
pass** ([013-9b-authoring-plan.md](./013-9b-authoring-plan.md) is the spine). Config surface (**item A**)
and mechanical-only narrowing (**item A′**) and the trading composition root (**item B**) are **DONE and
committed** (build green, lint clean, 2244 tests pass / 15 skipped / 0 failed). We are now in **item C
(decision-intake surface)**. The proposal is written ([017-item-c-intake-proposal.md](./017-item-c-intake-proposal.md))
and the **§4 crux is RESOLVED (2026-09-07, human): option (a)** — require a running `ExecutionActor`,
DROP the grant-fallback. Decisions are locked into [013 §5](./013-9b-authoring-plan.md) and logged as an
Intentional Divergence in [001](../../docs/001-parity-ledger.md) + [003](../../docs/003-anomalies-and-deviations.md). **No
item-C code has been written yet** — the immediate next action is to write the item-C implementer prompt
(§10).

## 2. The 9b item ledger (status at a glance — authority is 013 §1a + §4/§5)

| Item | What | Status |
|------|------|--------|
| A | Traderton-owned config shape (`AppConfigSchema` fused-file trim + loader) | ✅ DONE (commit 56ba7be) |
| A′ | mechanical-only bot boundary (`MechanicalStrategySchema` wrapper) | ✅ DONE (commit e9c035d) |
| B | trading composition root (`createTradingRuntime`, **bot-lifecycle only**) | ✅ DONE (commit 5834402; docs c5159e1) |
| **C** | **decision-intake surface (execution only, NO approvals)** | **▶ DECISIONS LOCKED (§4 crux = (a)); ready to write the implementer prompt (no code yet)** |
| D | drive-path tools (`bots.ts`/`trading.ts`) + in-process drive target + advertised strategy-schema narrowing | not started |
| E | per-`ownerId` maxBots (atomic advisory lock) | not started |
| F | M2 REST boundary adapter | not started |

Also DONE in 9b groundwork: `decision_approvals` table + repo deleted (approvals are consumer-owned —
[004](../../docs/004-decision-log.md) "Why Traderton does not own human approvals"); the M1 holistic review
([011](./011-m1-holistic-review-report.md)); the decision-response/event-model note
([014](./014-decision-response-and-event-model.md), the durable Postgres+Redis event outbox is an
**improvement deferred out of 9b** — do not build it during the authoring pass).

## 3. The item-C §4 crux — RESOLVED (2026-09-07, human): option (a)

> **DECISION (locked): (a) — require a running `ExecutionActor`; DROP the grant-fallback.** No actor →
> `instance_not_running` (existing copied rejection). The `AgentIntakeResolver` grant-fallback +
> `ActorStateOwner` session wrapper are NOT copied (Intentional Divergence — logged in
> [001](../../docs/001-parity-ledger.md) + [003](../../docs/003-anomalies-and-deviations.md); rationale in
> [013 §5.1](./013-9b-authoring-plan.md) + [017 §4](./017-item-c-intake-proposal.md)). The two riders are
> accepted: (2) item B's factory owns the `actorRegistry`; (3) item C constructs+registers the
> `AgentTradingActor` (lifecycle driver = item D). **Nothing below blocks progress — proceed to §10.** The
> explanation is retained for context.

Read [017 §4](./017-item-c-intake-proposal.md) in full. Summary:

herobids has **two intake paths**. (1) **Actor-owned intake** — `AgentTradingActor`/`TradingActor`
implement `ExecutionActor.getIntakeDeps/getDecisionContext/getPosition`; **already copied into Traderton**
(Phase 8). (2) **Grant-fallback intake** (`AgentIntakeResolver`, absent) — a **paper + orderbook only**
convenience that lets an agent submit a decision when **no trading actor is running** for it, resolving
capital/venue-account straight from the platform `agents` + `connections` tables (`shouldUseAgentGrantFallback = mode==='paper' && venueType==='orderbook'`; shadow/live/swap fail closed). It is agent-platform-coupled
(needs the `agents` table `AgentRepository` + the deleted grant join).

**Decision needed:** what does Traderton do when a decision arrives and no actor is running?
- **(a) DROP the grant-fallback, require a running actor** — coordinator's RECOMMENDATION. No actor →
  `instance_not_running` (a rejection code already in the copied contract). The paper-no-actor convenience
  is agent-side and **relocates to the consumer** (herobids still has the `agents`/`connections` tables),
  so it's not lost globally — it moves, consistent with the ownership seam. Cleanest; no `agents`-table
  dep; smallest authored surface. Record as Intentional Divergence.
- **(b) Author a venue-account-direct fallback** — reproduce no-actor intake, but source `venueAccountId`
  (injected) + `capital`/`risk` from a NEW injected "owner risk profile" port. Bigger authored surface;
  re-creates an agent-shaped concept Traderton avoids.
- **(c) Defer the no-actor path entirely.**

The human was mid-discussion understanding the grant-fallback (the coordinator explained it from the
verified code: `index.ts:818–864` composite resolver + `agent-intake-fallback.ts:16` eligibility). **Next
action = get the human's call on (a)/(b)/(c).** Coordinator leans (a). Two smaller decisions ride along
(017 §8): (2) item B's factory owns the `actorRegistry` and passes it to the handler; (3) item C
constructs+registers the `AgentTradingActor` (its start/stop lifecycle driver is item D).

## 4. Proposed item-C shape (under recommendation (a)) — for when the crux is decided

Author a **thin decision router + a plain `Map<string, ExecutionActor>` registry** over the
already-copied actor-owned intake:
- authored **slim decision handler** `submitDecision`: registry lookup → `actor.getIntakeDeps` → context →
  position → build `Decision` → `validatePerTradeLevels` → `submitDecisionForExecution` → `recordExecutionOutcome`.
  Drops the herobids paused/active-session gates, the `approval_required` fork, Telegram/pending-approval
  (all platform/consumer-owned).
- authored **venue-account-direct resolver seam** (validates the injected `venueAccountId`; replaces the
  grant join).
- authored **`AgentTradingActor` construction + registration** (uses item-B singletons + `buildAgentRiskLimits`).
- **DROP** `AgentIntakeResolver` grant-fallback + `ActorStateOwner` session wrapper (Intentional Divergence).
See the copy-vs-author manifest in [017 §5](./017-item-c-intake-proposal.md). Full detail there.

## 5. Item-C exclusions (route to owning item — do NOT author in C)
- The **drive** that CALLS `submitDecision` (publishToInbound / redis `agent:decision:reply:*`) → **item D**.
- **`InstanceEventPublisher`** event emits → **item C2** (M1 no-op stub in C).
- Human approvals → **consumer-owned** (dropped, [004](../../docs/004-decision-log.md)).
- `AgentTradingActor` **lifecycle driver** (who starts/stops it) → **item D / M1 consumer**.
- per-`ownerId` maxBots → **item E**.

## 6. The working method (how this project runs — follow it)

- **Coordinator pattern:** the human asks the coordinator to run items. Coordinator marks the task PENDING,
  triggers **Implementer** (sub-agent) → **CodeReviewer** (sub-agent) → fix-loop until no CRITICAL/HIGH →
  record Outstanding Issues → commit → mark DONE. Small fixes route back to Implementer; large ones re-plan.
- **Per authored item:** investigate-and-propose FIRST (write a proposal doc, pause for human review of the
  decisions), THEN write a **self-contained implementer prompt** (like [016-item-b-implementer-prompt.md](./016-item-b-implementer-prompt.md)),
  THEN implement. The implementer prompt must not depend on chat — it points to 013 §<item> + the proposal.
- **Verify every step:** `pnpm build` (green), `pnpm lint` (`tsc --noEmit`, clean), `pnpm test` (baseline
  **2244 passed / 15 skipped / 0 failed** as of item B — the 15 skips are credential/DB-gated integration
  suites). Existing copied tests must NEVER break (that means a copied module was altered — revert).
- **Authored code has no copy oracle** — so: keep each authored piece small/isolated/reviewed; use herobids
  as a behavioural oracle (trace authored closures to source line refs; the human floated a
  clone-herobids2-and-A/B option); label authored tests clearly (not copied parity tests).
- **Never silently drop behaviour** (AGENTS.md). Anything not copied/wired → a recorded Gap/Deferred/
  Intentional-Divergence row in 001 (+ 003 for mid-extraction deviations). This is how the item-B
  swap-token-safety deferral was handled (see below).
- **Commits:** stage specific files; do NOT commit the `.ignore/` scratch dir or the pre-existing
  `docs/features/010-...` edit (both are intentionally left uncommitted — leave them).

## 7. Live repo state (as of this handoff)

- Branch `main`. Recent commits (newest first): `c5159e1` docs A′+B DONE · `5834402` item B code ·
  `5e5cee8` item B decisions locked into 013 · `e9c035d` item A′ · `56ba7be` 9b groundwork (M1 review +
  approvals cut + config item A).
- Uncommitted (INTENTIONALLY left, not ours to commit): `.ignore/.gitignore`, `.ignore/SCRATCHPAD.md`,
  `docs/features/010-m1-holistic-review-instruction.md`. **This handoff doc (018) is a new file — commit it.**
- Build/lint/test all green at the counts above.

## 8. Known outstanding issues (recorded, not blocking) — carry forward

- **Swap-venue token-safety gating — `Deferred (required for cutover — swap bots ONLY)`** (item B). The
  composition root leaves `TradingActorDeps.swapTokenSafety: undefined` + drops the paired 1inch
  `swapNetwork` fail-closed guard, both blocked on the uncopied herobids inline `enrichTokenWithDiscovery`
  (`index.ts:93`). Orderbook/paper bots unaffected. Resolve (follow-up copy of `enrichTokenWithDiscovery`,
  or a source-fix) **before any swap-venue bot runs live.** Recorded in [001](../../docs/001-parity-ledger.md) 9b
  block + [003](../../docs/003-anomalies-and-deviations.md).
- **Advertised `create_bot.config.strategy` tool-schema** still reflects the broad `StrategySchema` (item
  A′ narrowed the *validated* boundary, not the *advertised* JSON) → narrow it in **item D** when the tool
  catalog is authored. Noted in 001 mechanical-only row + 013 A′.
- **`idGen`** was relocated as an inline literal (herobids had no discrete file) using `crypto.randomUUID()`
  (the "UUIDv7" comment is aspirational, kept verbatim). Fine; noted so no one "fixes" it.

## 9. Key docs map (where the real detail lives)

- [013-9b-authoring-plan.md](./013-9b-authoring-plan.md) — **the spine.** §1a classification (copy/seam/
  authored/improvement), §4 item B (done), §5 item C, §9 manifest, §10 stop-gates.
- [017-item-c-intake-proposal.md](./017-item-c-intake-proposal.md) — item C design record (APPROVED; §4 crux RESOLVED = (a)).
- [015-composition-root-proposal.md](./015-composition-root-proposal.md) — item B design record + herobids trace (APPROVED).
- [016-item-b-implementer-prompt.md](./016-item-b-implementer-prompt.md) — the template for a self-contained implementer prompt (item B).
- [019-item-c-implementer-prompt.md](./019-item-c-implementer-prompt.md) — **the item-C implementer prompt (ready to hand off).**
- [011-m1-holistic-review-report.md](./011-m1-holistic-review-report.md) — the pre-9b review (verdict: sound; bounded 9b scope).
- [014-decision-response-and-event-model.md](./014-decision-response-and-event-model.md) — sync/async response + the deferred durable event outbox (improvement, NOT 9b).
- [001-parity-ledger.md](../../docs/001-parity-ledger.md) — live status of every capability (source of truth for done-vs-pending).
- [004-decision-log.md](../../docs/004-decision-log.md) — the *why* (esp. decisions 7–13, mechanical-only, "Traderton does not own human approvals", M1/M2).
- [003-anomalies-and-deviations.md](../../docs/003-anomalies-and-deviations.md) — forced deviations + source-fix requests + the swap-token-safety deferral.

## 10. Immediate next action (do this)

**The §4 crux is RESOLVED (a) and the decisions are recorded** (013 §0 + §5, 001 + 003 Intentional
Divergence rows, 017 marked APPROVED). Remaining:

1. ✅ DONE — [019-item-c-implementer-prompt.md](./019-item-c-implementer-prompt.md) written (self-contained,
   modelled on [016](./016-item-b-implementer-prompt.md); sourced from [013 §5](./013-9b-authoring-plan.md)
   + [017](./017-item-c-intake-proposal.md); traces herobids `agent-decision-handler.ts` step 4→8 + the
   composite resolver's `actor?.isRunning` arm, and enumerates the dropped branches).
2. Run the coordinator loop: Implementer (hand it 019) → CodeReviewer → fix-loop (no CRITICAL/HIGH) →
   commit → mark C DONE in 013 + 001.
3. Pause before item D.

The implementer authors ONLY wiring (slim decision router + `Map<string,ExecutionActor>` registry +
venue-account-direct resolver seam + `AgentTradingActor` construct/register) over the Phase-8-copied actor
intake; the grant-fallback is dropped, not authored. See §4 for the shape.
