# 022 — Per-`ownerId` maxBots enforcement (item E) — Proposal

**Status:** APPROVED (2026-09-07, human) — the 4 decisions in §6 are locked (after two human challenges
corrected the framing: E is mostly-COPY, not "highest authored-content"). Decisions locked into
[013 §7](./013-9b-authoring-plan.md). This doc is now the design record.
**Phase:** 9b item E (per-`ownerId` maxBots atomic enforcement). Follows item D (DONE). **End of M1.**
**Feeds:** [013-9b-authoring-plan.md](./013-9b-authoring-plan.md) §7 (item E). The self-contained
implementer brief lives in 013 §7; the implementer prompt is [023](./023-item-e-implementer-prompt.md).
**Grounding:** read-only investigation of the herobids limit primitives + the Traderton `BotRepository`
+ the item-D `BotLimitSeam` (2026-09-07). Governed by [000](../000-vision.md) (ports-carry-values;
minimum-authoring; herobids-as-oracle; "not weaker than herobids-today"), [004](../004-decision-log.md)
(decisions 10–13; per-`ownerId` limit key decided 2026-09-06), [013 §7](./013-9b-authoring-plan.md).

> **This is a mostly-COPY item, smaller than "highest authored-content" first framed** (corrected
> 2026-09-07 after two human challenges). The count+insert+mark bodies **mirror the herobids method
> line-for-line**. The atomicity re-key is **not authored either** — herobids' OWN API path already uses a
> per-user Postgres advisory lock for exactly this (`_deferred-authoring/api-routes/bots.ts:135`,
> `pg_advisory_xact_lock(1, hashtext(userId))`, already copied into Traderton); the broker used an
> `agents`-row-lock only because it had an agent row. Traderton is owner-scoped like the API path, so E
> **copies the API-side advisory-lock pattern**, re-keyed `agents`-row → `ownerId`. The only genuinely
> authored surface is the thin seam wiring in `createTradingRuntime`. Everything else traces a herobids
> source (the broker method body + the API advisory-lock pattern).

---

## 1. What item E is (from 013 §7 + decision log + the item-D seam)

Fill the two-method `BotLimitSeam` that item D left injected-optional, so `create_bot`/`start_bot` are
limit-enforced. Concretely: author `tryCreateBotWithLimit` + `tryMarkBotRunningWithLimit` on the
`@traderton/db` `BotRepository` (re-keyed per-`ownerId`), then wire them into `createTradingRuntime` so the
drive target's `botLimit` seam is populated. When the limit is reached, reject with the herobids-parity
error the item-D handler already throws (`Agent has reached its max concurrent bots limit…`). This resolves
the `create_bot`/`start_bot` `Deferred (required for cutover)` sub-capability and the cutover gate "All
Deferred (required for cutover) entries resolved."

## 2. Investigation findings (verified in herobids + Traderton)

### 2a. The herobids primitives (the trace source — `packages/db/src/repositories.ts:905–1027`)
Both are `this.db.transaction(async (tx) => …)` with the same three-step body:
1. **Serialize:** `SELECT agents.id FROM agents WHERE id = creatorId FOR UPDATE` (row-lock the agent so two
   concurrent lifecycle ops can't both read "under limit"). Comment (verbatim): *without this, two
   concurrent transactions under READ COMMITTED both see the same count and both proceed.*
2. **Count:** `SELECT bots.id WHERE creatorType=… AND creatorId=… AND status='running'`; if
   `count >= maxBots` → return `false` / `{created:false}`.
3. **Write:** `tryMarkBotRunningWithLimit` → `UPDATE bots SET status='running', startedAt, stoppedAt=null`
   (preserving `startedAt` if already running); `tryCreateBotWithLimit` → `INSERT bots {…, status:'stopped'}`
   and return `{created:true, botId}`.

### 2b. What Traderton's `BotRepository` already has vs what was deleted (`packages/db/src/repositories.ts:812–1171`)
- **Present:** `getBotById`, `getBotsByCreator`, `countRunningBotsByCreator` (byte-identical count logic to
  herobids step 2), `markBotStopped`, `markBotRunning` (already preserves `startedAt`), `updateBotConfig`,
  `restoreBotConfig`, `restoreBotRuntimeState`, `isVenueAccountOwnedBy`, `getVenueAccountById`.
- **Deleted (Phase 2, documented in an in-file comment):** `createBot`, `tryCreateBotWithLimit`,
  `tryMarkBotRunningWithLimit` — *"enforced a per-AGENT maxBots limit by row-locking the platform `agents`
  table — platform-coupled (Intentional Divergence)… Limit-enforced creation/start is a Deferred-REQUIRED
  Traderton capability owned by the bot-lifecycle phase."* This is exactly item E.
- So E adds **two methods** back (re-keyed), reusing the existing count logic. The count query even already
  exists as `countRunningBotsByCreator` — E's transactional body can reuse that shape inside `tx`.

### 2c. The `bots` schema supports the re-key (`schema/bots.ts`)
`bots.ownerId` (`notNull`, indexed `idx_bots_owner_id`), `creatorType`/`creatorId` (indexed),
`venueAccountId` (FK, `restrict`), `status`, `config`, timestamps. Phase 2 dropped `userId`→`ownerId`,
dropped `connectionId`. So the insert E authors writes `{ownerId, venueAccountId, config, status:'stopped',
creatorType, creatorId, …}` — no platform columns. **The limit key = `ownerId`** (decision 2026-09-06;
Traderton tenancy), NOT `creatorId`/agent.

### 2d. The item-D seam E must satisfy (`composition/drive-target.ts:87–112`)
```
tryCreateBotWithLimit(spec: { ownerId; venueAccountId; config; creatorType; creatorId })
  : Promise<{ created: boolean; botId?: string }>
tryMarkBotRunningWithLimit(spec: { botId; ownerId; creatorType; creatorId })
  : Promise<boolean>
```
Note the seam signatures take **`ownerId`** (not the herobids `userId`/`maxBots` args) and **omit an
explicit `maxBots`** — so E resolves the limit value itself (§3.3). `creatorType`/`creatorId` are still
carried (they scope the persisted bot row + the `getBotsByCreator` tool queries — decision (a), item D).

### 2e. Atomicity: the advisory lock is COPIED from herobids' API path (not authored)
herobids has **two** limit paths, and they serialize differently for a reason: the **broker** path
(`agent-message-broker` → `tryCreateBotWithLimit`) had an `agents` row, so it used `SELECT agents.id …
FOR UPDATE`; the **API** path (`apps/api` bot-create, keyed on the user, no single agent row to lock)
used a **Postgres advisory lock keyed on the user**. That API pattern is **already copied into Traderton**
(quarantined): `_deferred-authoring/api-routes/bots.ts:135` — `SELECT pg_advisory_xact_lock(1,
hashtext(${request.userId}))` inside a `db.transaction`, and `credentials.ts:77` uses the same form
(classId `13`). A plain transaction is **not** enough under READ COMMITTED (herobids' own broker comment
says so). Traderton is owner-scoped like the API path (no `agents` row), so E **copies the API advisory-lock
pattern**, substituting `ownerId` for the user id. This is copy-and-re-key, not a novel invention — the
`pg_advisory_xact_lock(classId, hashtext(key))` two-int form + the reserved-classId convention already
exist in the copied API routes.

## 3. Proposed shape (the authored primitive)

### 3.1 Two `BotRepository` methods, re-keyed per-`ownerId`
Author `tryCreateBotWithLimit` + `tryMarkBotRunningWithLimit` on `@traderton/db` `BotRepository`, each a
`this.db.transaction(async (tx) => …)` that mirrors the herobids body (§2a) with two changes:
- **Serialize on `ownerId`** instead of `SELECT agents … FOR UPDATE`, **copying the API-path form** already
  in Traderton (`_deferred-authoring/api-routes/bots.ts:135`): `await tx.execute(sql\`SELECT
  pg_advisory_xact_lock(${CLASS_ID}, hashtext(${ownerId}))\`)` at the top of the transaction, with a
  reserved `CLASS_ID` (the copied routes use `1` for bot-create, `13` for credentials — pick an unused int
  for the maxBots lock and note the convention). `pg_advisory_xact_lock` auto-releases at commit/rollback
  (no manual unlock), serializing all create/start ops for the same `ownerId`.
- **Count by `ownerId`** (the limit key) rather than by `creatorId`: `WHERE ownerId = $ownerId AND
  status='running'`. Everything else — the `count >= maxBots` compare, the `startedAt`-preserving mark, the
  `status:'stopped'` insert with `crypto.randomUUID()` — is copied from the herobids method verbatim.

**Signature note:** to satisfy the item-D seam (§2d) the public methods take `{ownerId, …}` and no
`maxBots` arg; E resolves the limit inside (§3.3) OR the wiring passes it in — see §3.3 open point.

### 3.2 Wire the seam in `createTradingRuntime`
Populate `DriveTargetInjection.botLimit` with a `BotLimitSeam` backed by the two new `BotRepository`
methods (the factory already constructs a `BotRepository` singleton — item D). Once wired, item D's
`create_and_start` + non-reclaim `start` go fully live (no more `bot_limit_unavailable`).

### 3.3 The limit value (`maxBots`)
herobids: `agent.maxBots ?? agentRiskDefaults.maxBots ?? 5` — a per-agent override falling back to the
operator default. Traderton has no `agents` row, so **the limit = `config.agentRiskDefaults.maxBots`**
(operator default, present; §2c/schema default 5). **Per-owner override** (a consumer that wants a
higher/lower cap for a specific `ownerId`) is an injected value at M1 — the consumer can supply it through
the seam wiring, not a Traderton-owned table. Proposal: the seam wiring resolves `maxBots` from
`config.agentRiskDefaults.maxBots` and passes it into the repo method (keeps the repo method a pure
value-taking primitive; the "which limit for this owner" policy stays in the injectable wiring, not the db
layer). **Open point (§6.1):** repo-method-takes-`maxBots` (recommended) vs repo reads config.

### 3.4 The create-path running-slot claim (carried from item D — CodeReviewer MEDIUM-2)
herobids `create_and_start` calls BOTH `tryCreateBotWithLimit` (insert `stopped`) AND
`tryMarkBotRunningWithLimit` (mark `running`) before enqueuing start. **This two-call sequence is
load-bearing, not incidental** (investigated 2026-09-07 — there is a reason): `running` is the
**reclaim contract**. `WorkerRuntime.reclaimOrphans` (copied, Phase 8) loads bots WHERE `status='running'`
and re-starts any with no live actor — so `running` specifically means "should have an actor." Insert is
kept as `stopped` (persisted, counts toward the limit) and the transition to `running` is the atomic
**slot-claim**, distinct from persistence; if the process crashes after the `running` mark but before
`botStart` enqueues, the reclaim sweep recovers it — which only works because `running` = "reclaim me."
Inserting directly as `running` (my earlier shortcut) would collapse that separation and put the row in the
reclaim set before the start is even enqueued. **RETRACTED — E mirrors herobids: `tryCreateBotWithLimit`
inserts `stopped`, then `tryMarkBotRunningWithLimit` marks `running`.** This means the item-D `createAndStart`
must call **both** seam methods (create → mark) like the herobids broker, which also cleanly closes
CodeReviewer MEDIUM-2 (a small item-D handler wiring add, done as part of E's seam-wiring). **Resolved — no
open point.**

## 4. Copy-vs-author manifest

| Piece | Bucket | Note |
|-------|--------|------|
| the count logic (`count running WHERE … status='running'`) | mirrors COPY | byte-identical to herobids step 2 / the existing `countRunningBotsByCreator` |
| the mark body (`UPDATE status='running', startedAt-preserving`) | mirrors COPY | traces herobids `tryMarkBotRunningWithLimit` step 3 |
| the insert body (`INSERT … status='running'|'stopped', crypto.randomUUID()`) | mirrors COPY | traces herobids `tryCreateBotWithLimit` step 3 (columns re-keyed: `ownerId`, no `userId`/`connectionId`) |
| the per-`ownerId` advisory-lock serialization | **COPY (API-path pattern, re-keyed)** | copies `_deferred-authoring/api-routes/bots.ts:135` `pg_advisory_xact_lock(classId, hashtext(key))`; substitutes `ownerId` for the user id |
| the create→mark two-call sequence (`stopped` then `running`) | mirrors COPY | traces herobids broker `create_and_start` (:719 + :741); load-bearing for the reclaim contract (§3.4) |
| the `BotLimitSeam` wiring in `createTradingRuntime` + the item-D create→mark call | **AUTHORED (wiring, the only authored surface)** | binds the two repo methods; resolves `maxBots` from `agentRiskDefaults` (+ injected per-owner override); adds the second seam call in `createAndStart` (closes MEDIUM-2) |

**Net authored surface: just the seam wiring** (bind the two repo methods + resolve `maxBots` + add the
create→mark call in the item-D handler). The count/insert/mark bodies mirror the herobids broker method;
the advisory lock copies the herobids API-path pattern. This preserves herobids' atomicity guarantee
("not weaker than herobids-today", 000) by copying how herobids already solved it owner-side.

## 5. Verification plan (authored — no copy oracle)
herobids had **no unit test** for these methods (they were exercised via the broker), so E is authored
without a copy oracle → verify against the source behaviour + a concurrency test:
- Build/lint green; existing suite stays green (currently 2308 passed / 15 skipped).
- **Authored unit test** (labelled): under-limit create/start succeeds; at-limit returns
  `{created:false}` / `false`; the count is keyed on `ownerId` (a second owner is unaffected); reclaim
  (already-running) start is exempt.
- **Authored concurrency integration test** (`*.integration.test.ts`, DATABASE_URL-gated — matching the
  existing `journal-pg.integration.test.ts` / `position-repository.integration.test.ts` pattern): N
  concurrent `tryCreateBotWithLimit` for one `ownerId` at limit=k create exactly k bots (the advisory lock
  holds). This is the real proof of the atomicity re-key; it must run against Postgres in CI (Phase 10).
- Wire-through: item D's `create_and_start`/`start` no longer return `bot_limit_unavailable`; the drive
  target tests that asserted the seam call still pass with a live seam.

## 6. Decisions (resolved 2026-09-07, human)
1. **§3.3 — `maxBots` value = (a) AGREED.** The repo method takes `maxBots` as an arg; the
   `createTradingRuntime` wiring resolves it from `config.agentRiskDefaults.maxBots` (Traderton operator
   default) + any consumer-injected per-`ownerId` override. The db method stays a pure value-taking
   primitive; the "which limit for this owner" policy lives in the injectable wiring. **Traderton owns the
   default + enforcement; the consumer may inject a per-owner override value (never enforces).**
2. **§3.4 — create-path claim = MIRROR HEROBIDS (two calls).** Investigation confirmed the two-call
   sequence (`tryCreateBotWithLimit` inserts `stopped` → `tryMarkBotRunningWithLimit` marks `running`) is
   load-bearing: `running` is the `reclaimOrphans` contract (copied Phase 8 — bots WHERE `status='running'`
   with no live actor are re-started). The staged `stopped`→claim-`running`→enqueue keeps persistence and
   the atomic slot-claim distinct so crash recovery stays coherent. The earlier "insert-as-running"
   shortcut is **retracted**. Item-D `createAndStart` gains the second seam call (create→mark), closing
   MEDIUM-2.
3. **Advisory-lock keying = COPY the API-path form.** Not authored — copy
   `_deferred-authoring/api-routes/bots.ts:135`'s `pg_advisory_xact_lock(classId, hashtext(key))` two-int
   form, re-keyed to `ownerId`, with a reserved `classId` (the copied routes use `1`/`13`; pick an unused
   int + note the convention).
4. **Scope of E = CONFIRMED.** E is: the two `BotRepository` methods (re-keyed) + the `createTradingRuntime`
   seam wiring + the item-D `createAndStart` second-seam-call (create→mark). E does NOT touch the copied
   tools or the drive-handler routing logic beyond populating the seam + the one create→mark add.

**Next:** 013 §7 rewritten as the self-contained implementer brief + a `023` implementer prompt (like 021),
then implement → review → commit. **E completes M1** — pause after E for the M1-complete check (013 §12)
before item F (M2 REST).
