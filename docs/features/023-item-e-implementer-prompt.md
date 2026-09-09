# 023 — Item E Implementer Prompt (per-`ownerId` maxBots enforcement)

**Status:** ready to hand to an implementer.
**Task:** implement Phase 9b **item E** — fill the `BotLimitSeam` item D left injected-optional: author two
re-keyed `BotRepository` methods (`tryCreateBotWithLimit` / `tryMarkBotRunningWithLimit`), wire them into
`createTradingRuntime`, and add the item-D `createAndStart` second seam call. **E completes M1.**
**Authoritative brief:** [013 §7](./013-9b-authoring-plan.md) (LOCKED decisions + manifest) and
[022](./022-item-e-maxbots-proposal.md) (design record + investigation). Read both. This prompt is the
actionable checklist; **013 §7 wins on any conflict.**

---

## 0. Orient first (do not skip)

You are in **Traderton** (`/Users/chinomso.ikwuagwu/dev_ai/traderton`), extracted from **herobids**
(`/Users/chinomso.ikwuagwu/dev_ai/herobids`, READ-ONLY source) by copy-and-delete. Read the project memory
in [AGENTS.md](../../AGENTS.md) (000/001/004), then [013 §1 + §7](./013-9b-authoring-plan.md) and
[022](./022-item-e-maxbots-proposal.md). Assume no chat context.

**The law, and how E honours it (this was reframed after two human challenges — E is MOSTLY-COPY):**
- The count/insert/mark method bodies **mirror the herobids broker method line-for-line**
  (`packages/db/src/repositories.ts:905–1027`).
- The atomicity is **COPIED**, not authored: herobids' own **API path** already uses a per-user Postgres
  advisory lock for exactly this (owner-scoped, no agent row to `FOR UPDATE`), and that pattern is
  **already in Traderton** at `packages/worker/src/_deferred-authoring/api-routes/bots.ts:135`
  (`SELECT pg_advisory_xact_lock(1, hashtext(${request.userId}))`). Copy that form, re-keyed to `ownerId`.
- The **only genuinely authored surface** is the thin seam wiring in `createTradingRuntime` + the one
  item-D `createAndStart` add. Author nothing else.
- **ports-carry-values:** the `maxBots` limit *value* may be injected (per-owner override); the
  *enforcement* is Traderton's, atomic, and not bypassable through a seam.

## 1. The LOCKED decisions (013 §7.1 — do not re-litigate)

- **(1) `maxBots` is a value arg.** The repo methods take `maxBots: number` as a parameter. The
  `createTradingRuntime` seam wiring resolves it from `config.agentRiskDefaults.maxBots` (schema default 5)
  plus any consumer-injected per-`ownerId` override. The db method stays a pure value-taking primitive —
  do NOT have it read config.
- **(2) Mirror herobids' two-call create→mark.** `tryCreateBotWithLimit` inserts `status:'stopped'`;
  `tryMarkBotRunningWithLimit` marks `running`. **Do NOT insert-as-running.** `running` is the
  `WorkerRuntime.reclaimOrphans` contract (copied Phase 8 — bots WHERE `status='running'` with no live
  actor are re-started); the staged `stopped`→claim-`running`→enqueue keeps persistence and the atomic
  slot-claim distinct so a crash between the mark and the start-enqueue is recoverable. This is
  load-bearing — see 022 §3.4.
- **(3) Advisory lock = copy the API-path form.** Copy `_deferred-authoring/api-routes/bots.ts:135`'s
  `SELECT pg_advisory_xact_lock(classId, hashtext(key))` two-int form, re-keyed to `ownerId`. Use a
  reserved `classId` — the copied routes use `1` (bot-create) and `13` (credentials); pick an unused int
  for the maxBots lock and add a one-line comment noting the convention. Replaces the deleted
  `SELECT agents … FOR UPDATE`.
- **(4) Scope.** E = the two `BotRepository` methods + the `createTradingRuntime` seam wiring + the item-D
  `createAndStart` second seam call. E does NOT touch the copied tools (`tools/bots.ts`/`trading.ts`) or
  the drive-handler routing beyond populating the seam + that one call.

## 2. Scope — what you are building

1. **`BotRepository.tryCreateBotWithLimit`** (`packages/db/src/repositories.ts`, where the Phase-2 deletion
   comment sits) — re-keyed per-`ownerId`. See §3.
2. **`BotRepository.tryMarkBotRunningWithLimit`** — re-keyed per-`ownerId`. See §3.
3. **Seam wiring** in `packages/worker/src/composition/create-trading-runtime.ts` — build a `BotLimitSeam`
   (the shape item D declared in `composition/drive-target.ts`) backed by the two new repo methods,
   resolve `maxBots` from `config.agentRiskDefaults.maxBots` (+ optional injected per-owner override), and
   populate `DriveTargetInjection.botLimit` when the drive target is built. See §4.
4. **Item-D `createAndStart` create→mark add** (`composition/drive-target.ts`) — after
   `tryCreateBotWithLimit` succeeds, call `tryMarkBotRunningWithLimit` before `enqueueLifecycle('start')`,
   mirroring the herobids broker (`agent-message-broker.ts:719` then `:741`). This closes CodeReviewer
   MEDIUM-2 (the persisted bot must read `running`). See §5.
5. **Tests** — an authored unit test + a DATABASE_URL-gated concurrency integration test. See §6.

## 3. The two `BotRepository` methods (mirror herobids; re-key the lock)

Trace source: herobids `packages/db/src/repositories.ts:905–1027`. Each is
`return this.db.transaction(async (tx) => { … })` with three steps. Reproduce the body, changing ONLY the
lock and the count/insert keying (`agents`/`userId` → `ownerId`):

**Signatures (must match the item-D `BotLimitSeam` in `drive-target.ts:87–112`, plus the `maxBots` arg — decision 1):**
```ts
async tryCreateBotWithLimit(params: {
  ownerId: string;
  venueAccountId: string;
  config: Record<string, unknown>;
  creatorType: string;
  creatorId: string;
  maxBots: number;
}): Promise<{ created: boolean; botId?: string }>;

async tryMarkBotRunningWithLimit(params: {
  botId: string;
  ownerId: string;
  creatorType: string;
  creatorId: string;
  maxBots: number;
}): Promise<boolean>;
```
(The seam in `drive-target.ts` omits `maxBots` from its call sites — the seam wiring in §4 closes over the
resolved `maxBots` and passes it through. Keep the repo method's `maxBots` as an explicit arg per decision 1.)

**Body (both methods):**
1. **Serialize (copy the API-path form, re-keyed):**
   ```ts
   await tx.execute(sql`SELECT pg_advisory_xact_lock(${MAXBOTS_LOCK_CLASS}, hashtext(${params.ownerId}))`);
   ```
   `MAXBOTS_LOCK_CLASS` = a reserved int constant (not `1` or `13`, which are taken by the copied API
   routes) with a one-line comment. Import `sql` from `drizzle-orm` (the repo file already uses `eq`/`and`/etc).
2. **Count (key on `ownerId`):**
   ```ts
   const runningRows = await tx.select({ id: bots.id }).from(bots)
     .where(and(eq(bots.ownerId, params.ownerId), eq(bots.status, 'running')));
   if (runningRows.length >= params.maxBots) return /* {created:false} | false */;
   ```
   (herobids counted by `creatorType`/`creatorId`; Traderton's limit key is `ownerId` — decision, 013 §7 /
   004. Keep `creatorType`/`creatorId` for the INSERT's columns, but COUNT by `ownerId`.)
3. **Write (mirror herobids step 3):**
   - `tryMarkBotRunningWithLimit`: read current `{status, startedAt}`; `startedAt = current.status==='running'
     && current.startedAt ? current.startedAt : now`; `UPDATE bots SET status='running', startedAt,
     stoppedAt=null, updatedAt=now WHERE id=botId`; return `true`.
   - `tryCreateBotWithLimit`: `const id = crypto.randomUUID(); const now = new Date();
     INSERT bots {id, ownerId, venueAccountId, config, status:'stopped', creatorType, creatorId,
     createdAt:now, updatedAt:now}`; return `{created:true, botId:id}`. **Columns re-keyed:** `ownerId`
     (not `userId`); **no `connectionId`** (dropped Phase 2). Match the `bots` schema (`schema/bots.ts`).

Replace the Phase-2 deletion comment block with the two methods (or place them adjacent + trim the comment
to a one-line "re-instated per-`ownerId` at item E" note). Do NOT reintroduce `userId`/`connectionId`.

## 4. Seam wiring in `createTradingRuntime`

`create-trading-runtime.ts` already constructs a `BotRepository` singleton (item D) and builds the drive
target via `createDriveTarget(injection)`. Add:
- a `botLimit: BotLimitSeam` built from the two new repo methods. The seam's `tryCreateBotWithLimit({ownerId,
  venueAccountId, config, creatorType, creatorId})` / `tryMarkBotRunningWithLimit({botId, ownerId,
  creatorType, creatorId})` call the repo methods, passing `maxBots` resolved from
  `config.agentRiskDefaults.maxBots` (+ an optional injected per-`ownerId` override if the
  `DriveTargetInjection`/runtime ports expose one — if not cleanly available, resolve to the operator
  default and note that per-owner override is a wiring extension point, do NOT author a new config table).
- populate `DriveTargetInjection.botLimit` with that seam when `createDriveTarget` is called (so item D's
  `create_and_start`/non-reclaim `start` go live).

Keep it wiring-only: the seam closes over the repo + the resolved limit; it holds no trading logic.

## 5. Item-D `createAndStart` create→mark (close MEDIUM-2)

In `drive-target.ts` `createAndStart`, after `tryCreateBotWithLimit` returns `{created:true, botId}` and
before `enqueueLifecycle('start', botId, …)`, add the mark call mirroring herobids `agent-message-broker.ts:738–743`:
```ts
const claimed = await deps.botLimit.tryMarkBotRunningWithLimit({ botId, ownerId: deps.ownerId, creatorType: 'agent', creatorId: deps.actorId });
if (!claimed) throw new Error('Agent has reached its max concurrent bots limit. Stop a bot before creating a new one.');
```
This is the only change to the item-D handler. Do NOT alter the `start`/`stop`/`restart`/`adjust_config`
arms (start already claims the slot for non-reclaim; that stays).

## 6. Verification

- `pnpm build` green, `pnpm lint` clean.
- Existing suite stays green (baseline **2308 passed / 15 skipped / 0 failed**). No copied module altered
  beyond the two new repo methods + the one `createAndStart` add.
- **Authored unit test** (labelled AUTHORED — herobids had no unit test for these methods, so this is not a
  copy oracle): under-limit `tryCreateBotWithLimit`/`tryMarkBotRunningWithLimit` succeed; at-limit →
  `{created:false}` / `false`; count is keyed on `ownerId` (a bot for a DIFFERENT `ownerId` does not count
  toward this owner's limit); `tryMarkBotRunningWithLimit` preserves `startedAt` for an already-running bot.
  (If the count/write need a live DB, put these in the integration test instead — keep whatever is a pure
  unit test deterministic.)
- **Authored concurrency integration test** (`packages/db/src/*.integration.test.ts`, DATABASE_URL-gated —
  match the existing `journal-pg.integration.test.ts` / `position-repository.integration.test.ts` skip
  pattern): fire N concurrent `tryCreateBotWithLimit` for ONE `ownerId` at `maxBots=k`; assert exactly `k`
  succeed (`created:true`) and the rest `created:false`. This is the real proof the advisory lock
  serializes; it must run against Postgres in CI (Phase 10) — locally it skips without DATABASE_URL.
- **Wire-through:** the item-D drive-target tests that asserted `bot_limit_unavailable` (seam absent) still
  pass; add/adjust a drive-target test that with the seam wired, `create_and_start` calls BOTH
  `tryCreateBotWithLimit` AND `tryMarkBotRunningWithLimit` then `enqueueLifecycle('start')` (create→mark→enqueue).
- Report the test counts.

## 7. Guardrails / stop-gates (surface, do not push past)

- **Do NOT insert-as-running** (decision 2) — it breaks the reclaim contract. Insert `stopped`, mark
  `running` separately.
- **Do NOT read the `agents` table / `AgentRepository`** (it doesn't exist) or reintroduce
  `userId`/`connectionId` columns. The limit key is `ownerId`.
- **Do NOT have the db method read config** — `maxBots` is a value arg (decision 1).
- **Do NOT invent a new advisory-lock form** — copy the API-path `pg_advisory_xact_lock(classId,
  hashtext(key))` shape (decision 3).
- If the re-key needs anything beyond a lock + count + insert/mark (e.g. authored trading logic) → STOP;
  the seam is mis-drawn.
- Do NOT touch the copied tools or the drive-handler routing beyond §5.

## 8. Done criteria + docs

- Build/lint/tests green; the seam is wired; item D's create/start are limit-enforced (no more
  `bot_limit_unavailable`).
- Update [001](../001-parity-ledger.md): `create_bot`/`start_bot` limit sub-capability →
  **Met** (per-`ownerId`, atomic); note the per-agent → per-`ownerId` Intentional Divergence; the
  "All Deferred (required for cutover) entries resolved" cutover gate advances (enumerate). Update
  [013 §7](./013-9b-authoring-plan.md) item E → DONE with the authored-vs-copied manifest + any Outstanding
  Issues from CodeReviewer. Log the per-agent→per-owner Intentional Divergence row in
  [001](../001-parity-ledger.md) + a note in [004](../004-decision-log.md) if not already present.
- Commit as its own logical commit ("9b item E: per-`ownerId` maxBots enforcement").
- **E completes M1** — then PAUSE for the M1-complete check (013 §12) before item F (M2 REST).

## 9. Key file map (start here)

Traderton:
- `packages/db/src/repositories.ts` — `BotRepository` (the Phase-2 deletion comment marks where the two
  methods go; `countRunningBotsByCreator` at ~:846 shows the count shape; `markBotRunning` at ~:911 shows
  the startedAt-preserving mark). Import `sql` from `drizzle-orm`.
- `packages/db/src/schema/bots.ts` — the `bots` columns (ownerId/venueAccountId/config/status/creatorType/
  creatorId/timestamps; no userId/connectionId).
- `packages/worker/src/_deferred-authoring/api-routes/bots.ts:135` — the `pg_advisory_xact_lock` pattern to
  COPY (re-key to `ownerId`).
- `packages/worker/src/composition/drive-target.ts` — `BotLimitSeam` shape (:87–112); `createAndStart` (§5).
- `packages/worker/src/composition/create-trading-runtime.ts` — the `BotRepository` singleton + drive-target
  build (seam wiring goes here).
- `packages/db/src/journal-pg.integration.test.ts` — the DATABASE_URL-gated integration-test skip pattern.
- `@traderton/domain` — `AgentRiskDefaultsConfig.maxBots` (`config/schema.ts`, default 5).

herobids (READ-ONLY reference — trace, never import):
- `packages/db/src/repositories.ts:905–1027` — `tryMarkBotRunningWithLimit` + `tryCreateBotWithLimit` (the
  method bodies to mirror; re-key the `SELECT agents … FOR UPDATE` → advisory lock, count by `ownerId`).
- `apps/worker/src/agents/agent-message-broker.ts:719` + `:741` — the create→mark two-call sequence.
