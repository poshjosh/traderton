# Decision brief: the herobids bot-consumer contract (reads, create-response, capability-validation)

**Status:** ROUTED + RULED (2026-09-12) — the decision agent settled rulings 1–5 (recorded in 004 + 001); 3 product/policy calls (A/B/C) await human ratification. See 004-decision-log 2026-09-12 "Bot-consumer contract".
**Prepared:** 2026-09-12. **Author:** coordinating agent (facts grounded in code). **Contemplator** consulted — its recommendations + reasoning are incorporated below (§7–§8), NOT ranked by me.

This brief follows `docs/008-decision-process.md §2`. It is neutral; the options carry consequences traced to the rules, and the Contemplator's recommendation is recorded per option (clearly labelled as a recommendation, not a ruling).

---

## 1. Strategic objective (top)
No trading logic or trading-state AUTHORITY runs in the herobids process; herobids is a pure REST consumer of Traderton over the boundary.

## 2. Current tactical objective
The bot-lifecycle re-point slice. herobids' bot WRITES already route over the boundary; its bot READS still hit the local `bots` table (and local `fills`/`journal_events`). This slice reconciles the consumer's bot contract with Traderton's async bot ownership. (Surfaced by the functional-suite work: 7 bots-lifecycle tests are skipped pending this decision — ledger 001, "functional suites boundary-aware".)

## 3. Rules (governing law)
- Top rule (legal isolation): no trading-state authority in herobids.
- Copy-never-author: we may improve, must NOT degrade; nothing silently dropped; **no NEW features during migration**.
- Parity, not liveness. main-branch/merge-gate untouched.

## 4. Relevant prior decisions (SETTLED — do not relitigate)
- **Traderton owns bots; `create_bot` is async fire-and-forget** — herobids' boundary call publishes `MANAGE_BOT/create_and_start`; Traderton's worker writes the bot row on the NEXT TICK, in Traderton's DB; the boundary payload carries NO bot id (Phase 9b items B–E; 004/001).
- herobids write paths (create/start/stop) re-pointed to the boundary (fail-closed 503); `maxBots` + execution-capability validation MOVED behind the boundary (herobids dropped its local pre-checks).

## 5. The question (neutral)
Now that Traderton owns bots and writes them asynchronously, what should the herobids consumer's bot contract be, across three linked dimensions: (1) where bot READS resolve; (2) the `POST /bots` response contract; (3) where execution-capability validation (e.g. paper+swap) is surfaced to the caller?

## 6. Grounded code facts (verified)
- **herobids** `apps/api/src/routes/bots.ts`:
  - `POST /bots`: calls boundary `create_bot`, returns `result.payload` as a **201** body; existing tests read `.id`. But the boundary payload has no id and NO local `bots` row is written.
  - `DELETE /bots/:id`, `POST /bots/:id/stop`, `POST /bots/:id/start`: read the LOCAL `bots` table (`db.select().from(bots).where(id, userId)`) for existence/ownership/status, THEN route the action over the boundary. Start/stop already return **202** (`starting`/`stopping`). The live-mode plan-gate (403) is a KEPT platform check, pre-boundary.
  - `GET /bots`, `/bots/:id`, `/bots/:id/costs`, `/sessions`, `/events`, `/journal`, `/journal/summary`: ALL read the LOCAL `bots` table (and local `fills`/`journal_events`) for ownership + data.
- **Traderton** `packages/worker/src/tools/bots.ts`: `create_bot` `dryRun` is **schema-only** (explicitly defers strategy/venue/capability/risk validation to publish time). `list_bots`/`get_bot_status` exist but are **agent-creator-scoped** (`getBotsByCreator('agent', ctx.agentId)` / reject unless `creatorId === ctx.agentId`). analytics/positions tools are likewise agent-scoped.
- **Boundary** (`packages/boundary`): serves `read-database` tools today (read-only dispatch bypasses idempotency), so a bot READ over the boundary is mechanically available — BUT there is **no OWNER-scoped bot/analytics/journal read tool**; the existing ones would filter on `creatorType='agent' AND creatorId=<userId>` → wrong result set for user-owned reads.
- **Ownership of read data:** `fills` and `journal_events` are Traderton-owned (Traderton's engine/`PgJournal` write them). So herobids' costs/journal/sessions/events endpoints currently read a LOCAL MIRROR of Traderton-owned trading state.
- **Capability validation:** `validateExecutionCapability` (paper+swap → `paper_swap_not_supported`) is `@traderton/domain` logic run at engine PUBLISH time (next tick), not synchronously in any boundary tool.

## 7. Sub-question 1 — where do bot READS resolve?
Options, consequences vs rules:
- **1(a) herobids keeps a LOCAL read-model/projection** synced from Traderton (reads stay local). → **Violates the TOP rule:** re-homes trading state (bots/fills/journal) into herobids as a second source of truth, with a sync mechanism herobids owns. Available immediately, low-latency, but is the exact authority the isolation objective removes.
- **1(b) reads go OVER THE BOUNDARY** via owner-scoped read tools; drop the local `bots`/fills/journal mirror. → Isolation-correct, staleness-free (hits Traderton's live DB). **Blocked today:** requires NEW owner-scoped Traderton read tools (owner `list_bots`/`get_bot_status` + owner/bot-scoped costs/journal/journal-summary/sessions/events). Adds per-read boundary latency. The new surface is itself a copy-never-author judgement on the Traderton side (owner-scoping is not a straight copy of the agent-scoped tools).

**Contemplator recommendation:** 1(b) is the rule-forced target; 1(a) as a durable design is **unacceptable** (top rule). BUT 1(b) is gated on new owner-scoped Traderton read surface that does not exist — so this cannot be implemented until that surface is decided/built.

## 8. Sub-question 2 — `POST /bots` response contract
- **2(a) 202 Accepted, no id (id-later).** → Honest about async ownership; consistent with start/stop already returning 202; decouples herobids from Traderton's tick. **Contract change** rippling to clients/tests that expect 201+id.
- **2(b) herobids waits/polls the boundary until the bot materializes to preserve 201+id.** → Re-introduces the coupling the async design removed (blocks the user request on Traderton's tick; needs a poll read tool that doesn't exist owner-scoped); unbounded latency; a liveness dependency the isolation + parity-not-liveness posture push against.

**Contemplator recommendation:** **2(a)** (202/no-id). 2(b) polling strongly disfavoured. The 201+id contract cannot be honoured TRUTHFULLY under async ownership (a fabricated id or stale local row would be the real degradation), so the honest 202 is preservation-of-correctness, not a feature drop. Whether a 202/no-id create is acceptable to end clients/UI is a **product-policy call** (§9).

## 9. Sub-question 3 — where is capability validation surfaced?
- **3-async: accepted, then rejected by Traderton at publish** (paper+swap fails on the next tick; visible via the bot read path once it exists). → Zero new surface, isolation-clean. **Degrades caller UX:** today paper+swap returns a synchronous 400 at create; async defers/hides the failure (and it only becomes visible once sub-q 1(b)'s read path exists).
- **3-sync: a new Traderton synchronous capability-preview boundary tool** herobids calls before responding. → Restores the immediate 400; the decision stays in Traderton (isolation-ok). But it is NEW authored Traderton surface (copy-never-author judgement) + a boundary round-trip.
- **3-local (re-add the herobids pre-check): UNACCEPTABLE** — re-homes a trading-config rule in herobids; reverses a settled decision.

**Contemplator recommendation:** async-default (3-async), with schema-only dryRun for early shape errors; do NOT re-add the local check. sync-preview vs async-only is **not rule-forced** — it's a parity/UX product call (§9).

## 10. What I could NOT determine (product-policy calls for the human)
1. Is a **202/no-id create contract** acceptable to end clients/UI? (Rules force away from a fabricated 201+id; accepting the visible contract change is a product decision.)
2. Accept **losing the synchronous paper+swap 400** (async-only), or fund a **new synchronous capability-preview** boundary tool to preserve it?
3. **Green-light the new owner-scoped Traderton read surface** (owner `list_bots`/`get_bot_status` + owner/bot-scoped costs/journal/journal-summary/sessions/events) — the gating dependency for the ENTIRE read migration. Must be built in Traderton; reconcile with copy-never-author (owner-scoping ≠ straight copy).
4. **Interim posture while (3) is unbuilt:** do herobids' local bot read endpoints stay on the local mirror TEMPORARILY (stale/empty for boundary-created bots), or get disabled/503'd until the boundary read surface lands? (Neither is clean: live = re-exposes isolation concern; disabled = drops working endpoints.)

## 11. Net
The write path is settled and coherent. This is the READ half of the same cut. The rules point to reads-over-the-boundary (1b), an honest 202 create (2a), and async capability rejection (3-async) — but 1(b) and the honest read UX are **blocked on new owner-scoped Traderton read tools that don't exist**, and that new surface is itself a copy-never-author decision for the Traderton side. Items §10.1–§10.4 need human ratification before implementation begins.
