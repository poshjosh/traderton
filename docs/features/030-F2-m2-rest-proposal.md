# 030 — F2 investigate-and-propose (M2 REST boundary — idempotency, deadline, side-effecting dispatch, status endpoint, verification)

**Status:** APPROVED (2026-09-08, human). Decisions D1–D5 locked (see §8); F2 sub-split (§6) confirmed;
rate-limiting stays out (§7). Decisions mirrored into [013 §8](./013-9b-authoring-plan.md); implementation
proceeds slice-by-slice (F2a → F2b → F2c), pausing between each for human review.
**Branch:** `f-m2-rest` (continues from F1 `583fb8d`; HEAD `f3c1093`).
**Reads:** [005](../005-consumer-boundary-contract.md) (the contract), [013 §8](./013-9b-authoring-plan.md)
(F decisions + F1/F2 split), [028](./028-F-m2-rest-proposal.md) (the F proposal F1 came from),
[003](../003-anomalies-and-deviations.md) (deferrals). F1 is the read-only shell already landed
(`packages/boundary`, `@traderton/boundary`).

---

## 1. What F2 is (from 013 §8.1(4), §8.2, and 005)

F2 completes the M2 REST boundary by adding, over the F1 shell:

1. **A Postgres `boundary_invocations` idempotency store** — new `@traderton/db` table + migration + repo.
   Key `(consumer_id, owner_id, tool_name, idempotency_key)`; stores request fingerprint, requestId,
   correlationId, state, terminal response, timestamps, expiry. Retention configurable
   (`boundary.idempotencyRetentionHours: 168`, not hard-coded).
2. **Deadline enforcement** — reject an already-expired `deadlineAt` before validation; re-check before
   downstream side effects (005 §Deadlines).
3. **Side-effecting tool dispatch** — remove F1's read-only gate so `execute-trade`/`write-database` tools
   dispatch, wiring the real `TradingToolContext` (real Redis + the item-C/D drive path) the boundary needs.
4. **The status endpoint** — `GET /internal/v1/invocations/:requestId` → `TradertonToolInvocationStatusV1`
   (`in_progress` | `terminal`+`result`); never triggers a second execution.
5. **The 7 required-verification tests** (005 §Required Verification) — the F acceptance gate.
6. **The runnable stack + dev signing helper** — the compose stack (boundary + Postgres + Redis) + a
   committed signing helper, per 013 §8.1(4) (forced by test #7 and the signed-call tests).
7. **The deferred F1 authz check** — 005 §Authorization item 3 ("actor provenance valid for the requested
   tool"), deferred from F1 (docs/003).

The **law holds**: F2 authors boundary machinery + injects VALUES and dispatches to the already-copied tools;
it authors no trading behaviour. The one nuance is §2 below — part of F2 is now **copy**, not author.

---

## 2. Copy-never-author correction (the biggest finding — please note)

**013 §8.3 and 028 §6 assert F is "AUTHORED — no herobids equivalent."** For F1 (HMAC/envelope/dispatch)
that was true. **For F2's idempotency store it is NOT true.** herobids has a real, proven idempotency oracle:

- `herobids/apps/api/src/services/blueprint-idempotency.ts` — `computeInstantiateRequestHash(...)`: a
  deterministic SHA-256 over a recursively key-sorted, binding-set-deduped normalized object. This is exactly
  the "request fingerprint" 005 needs.
- `herobids/apps/api/src/routes/blueprints.ts` (`POST /blueprints/:id/fork` ~L1074; the instantiate route
  ~L1903): inside a `db.transaction`, `SELECT pg_advisory_xact_lock(hashtext(lockKey))` → look up the
  existing request by `(userId, idempotencyKey)` → **same hash → return stored response** (idempotent
  replay); **different hash → conflict**; else execute + persist. This is precisely the 005 control flow.
- Backing tables `herobids/packages/db/src/schema/blueprint-fork-requests.ts` +
  `blueprint-instantiation-requests.ts` — `idempotencyKey`, `requestHash`, `responsePayload jsonb`,
  `createdAt`, `uniqueIndex(userId, idempotencyKey)`.

**How it differs from 005 (why it is a PARTIAL oracle, not drop-in):**
- Key is `(userId, idempotencyKey)`; 005 wants the 4-tuple `(consumer_id, owner_id, tool_name,
  idempotency_key)`.
- **Synchronous replay-or-conflict only — no `in_progress`/`state`.** 005 requires an `in_progress`
  transitional state + the status endpoint. herobids has no in-flight concept.
- **No `deadlineAt`/expiry/retention.** 005 requires retention (168h) + timestamps + expiry.
- It is a JWT HTTP route (`request.userId`), not an HMAC boundary.

**No deadline-enforcement oracle exists** in herobids (searched — only unrelated in-code timeout loops).
Deadline enforcement is genuinely all-authored.

**Proposed disposition (this is a decision — see §8, D1):** the fingerprint hashing + the
advisory-lock→lookup→same/different-hash control flow are **COPIED/adapted** from `blueprint-idempotency.ts`
+ the blueprints route (behaviour-preserving, re-keyed to the 005 4-tuple); the `in_progress`/status/
retention/expiry pieces are **AUTHORED** (no oracle). This corrects the F docs' "no equivalent" framing and
keeps us honest to copy-never-author. It also mirrors the item-E precedent (copy herobids' own advisory-lock
form, re-key it). Whether to copy-adapt or author fresh is D1.

---

## 3. Where F2 intercepts (the wiring points, from the current code)

The F1 envelope already parses `idempotencyKey` and `deadlineAt` (both required, `contract.ts`), and the
closed failure union **already includes `deadline.expired`** — no contract additions there. Interception:

- **Deadline pre-check:** in `dispatcher.dispatch()` right after envelope+version parse, before payload
  validation — `now > deadlineAt` → `deadline.expired` (retryable=false). 005: "rejects a request whose
  deadline has already passed before validation."
- **Deadline re-check before side effects:** see D3 — literal ("before *every* side effect", requires
  plumbing `deadlineAt` into the drive path) vs pragmatic (one re-check immediately before `tool.execute`).
- **Idempotency:** wrap dispatcher step 7 (`tool.execute`). After authz, before execute: persist the
  invocation row (`state=in_progress`, fingerprint) under the advisory lock keyed on the 4-tuple; a reused
  key with the same fingerprint → return `in_progress` status or the stored terminal result; a different
  fingerprint → `validation.invalid_payload`. After execute: update the row to terminal with the mapped
  result. The dispatcher has **no db handle today** — F2 injects the `boundary_invocations` repo (or a thin
  idempotency service) into `DispatcherDeps`.
- **Status endpoint:** a new `GET /internal/v1/invocations/:requestId` route in `app.ts` reads the same
  store by `requestId`. `app.ts` `toSignedRequest` already strips the query string (F1's M2 fix), so
  path-signing is ready. `TradertonToolInvocationStatusV1` is **not yet in `contract.ts`** (only in 005
  prose) — F2 authors the type.
- **Read-only gate:** dispatcher step 4 must now admit `execute-trade`/`write-database` tools. Idempotency +
  deadline are what make that safe (they exist to protect side effects).

---

## 4. The side-effecting context gap (F1 NOOP → F2 real)

F1's `bin.ts` `baseContextFactory` returns a **NOOP context** (NOOP Redis, `publishToInbound` = no-op, no
`botRepo`). Read-only tools tolerate it; side-effecting tools need a real one:

- `submit_decision` calls `ctx.publishToInbound(DECISION_SUBMIT, …)` then **awaits `ctx.redis.blpop(replyKey,
  30)`** for the engine reply.
- `create_bot` calls `ctx.publishToInbound(MANAGE_BOT, {action:'create_and_start', …})`.
- `stop_bot`/`start_bot`/`adjust_bot_config` use `ctx.botRepo.*`, `ctx.redis.publish`, `ctx.publishToInbound`.

So F2's context factory must supply, per signed subject: (a) a **real Redis client** (`ioredis`); (b) a real
**`publishToInbound`** = `createDriveTarget(injection)` from a live `createTradingRuntime(…)` (needs real
Postgres `DATABASE_URL` + Redis + `AppConfig`); (c) a real `ctx.botRepo`. The `TradingToolContextFactory`
seam already exists — F2 wires a real factory; the dispatcher itself needs no change to *call* it.

**The gap that forces a decision (D2):** 005 carries only `ownerId` + `actor`. The drive target needs
`venue`/`venueType`/`venueAccountId`/`ownerMode` per owned actor. Where do these come from at the boundary?
Options: (a) author a subject→injection **resolver** that reads them from the bot/venue-account row the
operation targets (e.g. from the `bots` row for a `MANAGE_BOT`, or a per-owner default venue account); (b)
carry them as additional signed subject fields (a 005 contract change — heavy, needs a version rollout); (c)
operator config maps `ownerId` → default injection. This is a real authored seam with no oracle — D2.

---

## 5. `@traderton/db` conventions F2 follows (no new patterns)

- **Migration:** author `packages/db/src/schema/boundary-invocations.ts` (pgTable), export from
  `schema/index.ts`, run `pnpm --filter @traderton/db db:generate` → produces `drizzle/0001_*.sql`. Column
  style copied from `bots.ts`/`blueprint-fork-requests.ts` (`text` PK, `timestamp({withTimezone:true})`,
  `jsonb().$type<…>()`, `uniqueIndex(...)`).
- **Repo:** a `BoundaryInvocationRepository` class, `constructor(private readonly db: Database)`,
  `this.db.transaction(tx => …)` with `pg_advisory_xact_lock(<CLASS>, hashtext(<key>))` — structurally the
  item-E `BotRepository` pattern (a new lock class constant, e.g. `BOUNDARY_LOCK_CLASS = 18`).
- **Tests:** `boundary-invocations.integration.test.ts`, `DATABASE_URL`-gated (`describe.skipIf(!DATABASE_URL)`),
  `openTestDb`/`truncate` helpers — the item-E `bot-limit.integration.test.ts` pattern.

---

## 6. Proposed F2 sub-split (mirrors the F1/F2 discipline — landable in reviewable slices)

F2 is larger than F1; propose three commits on `f-m2-rest`, each build+lint+test green:

- **F2a — the store.** `boundary_invocations` schema + migration + `BoundaryInvocationRepository`
  (advisory-lock lookup/persist/terminalize, fingerprint hashing copied-adapted per D1, retention/expiry) +
  its DATABASE_URL-gated integration test. No boundary wiring yet. *Verifies §1.1 in isolation.*
- **F2b — dispatcher integration.** Wire the repo into `DispatcherDeps`; deadline pre-check + re-check (per
  D3); idempotency wrap around `tool.execute`; open the read-only gate to side-effecting tools; the status
  endpoint + `TradertonToolInvocationStatusV1`; item-3 provenance check (per D4); the real
  context factory in `bin.ts` (subject→injection per D2). *Verifies §1.2–1.4, 1.7.*
- **F2c — the stack + verification.** The compose file (boundary + Postgres + Redis) + dev signing helper +
  an integration test runner that migrates then runs the 7 required-verification tests. *Verifies §1.5, 1.6,
  and the F acceptance gate.*

Each slice: Implementer → CodeReviewer → fix-loop → commit, per the coordinator loop. F2c is the merge-gate
enabler ("run locally + staging for a while").

---

## 7. What stays out of F2 (scope discipline)

- No per-resource `api-routes/**` (signed-off Gap, unchanged).
- No new tools — capability rides the copied 25 tools.
- No merge to `main` — the merge gate (herobids consumes the library; all tests pass; run local+staging a
  while; manual approval) is still unmet; F2 landing green on the branch does not change that.
- No rate-limiting (`rate_limit.exceeded` stays an unused-but-reserved code unless a tool emits it) — 005
  does not require F to implement a limiter; flag if you disagree.

---

## 8. Decisions needed before implementing (please steer)

- **D1 — idempotency: copy-adapt vs author fresh.** RECOMMEND **copy-adapt** the fingerprint hashing +
  advisory-lock control flow from herobids `blueprint-idempotency.ts` + the blueprints route (re-keyed to the
  005 4-tuple), author only the `in_progress`/status/retention/expiry deltas. This corrects the F docs'
  "no equivalent" claim and honours copy-never-author (the item-E precedent). Alternative: author fresh
  (simpler mental model, but re-invents proven, tested source logic — weaker parity story).
- **D2 — subject→injection resolver.** How does the boundary get `venue`/`venueType`/`venueAccountId`/
  `ownerMode` from a signed `ownerId`+`actor`? RECOMMEND **(a) an authored resolver that reads the target
  bot/venue-account row** (the operation names the bot; the row carries `venueAccountId`), with a
  per-owner default where no bot is named. Needs your call — it is an authored seam with no oracle.
- **D3 — deadline "re-check before each side effect": literal vs pragmatic.** RECOMMEND **pragmatic**: a
  pre-validation reject + one re-check immediately before `tool.execute`. Literal per-side-effect re-checks
  would thread `deadlineAt` down into `create-trading-runtime`/`drive-target` (into copied-tool territory) —
  more surface, closer to authoring in the core. Flag: pragmatic is a slight divergence from 005's "every
  side effect" wording → log in 003 if chosen.
- **D4 — item-3 actor-provenance policy source.** 005 §Authz item 3 has no oracle and no existing table/enum.
  RECOMMEND a **static per-tool (or per-category) allow-map** in the boundary (e.g. which `actor.type` may
  invoke `execute-trade` tools), authored + documented, enforced in dispatcher step 6. Needs your call on the
  policy shape.
- **D5 — the compose stack: author fresh vs reuse the `l1-integration-harness` branch's
  `docker-compose.integration.yml`.** That harness is NOT on this branch (it lives on
  `l1-integration-harness`, left as-is per your earlier direction). RECOMMEND **author fresh, minimal**
  (boundary + Postgres + Redis) as a durable F2c artifact rather than rebasing harness scaffolding — the
  harness was explicitly kept off main as YAGNI. Confirm.

Also confirm the **F2 sub-split (§6)** and that **rate-limiting stays out (§7)**.

### 8.1 Resolved (2026-09-08, human)

- **D1 → COPY-ADAPT.** Copy-adapt the fingerprint hashing + advisory-lock→lookup→same/different-hash flow
  from herobids `blueprint-idempotency.ts` + the blueprints route (re-keyed to the 005 4-tuple); author only
  the `in_progress`/status/retention/expiry deltas. Correct the stale "no equivalent" claim in 013 §8.3 /
  028 §6. Backlog: an **author-fresh** replacement is a recorded later-option (see docs/010).
- **D2 → AUTHORED RESOLVER.** Author a subject→injection resolver that reads `venue`/`venueType`/
  `venueAccountId`/`ownerMode` from the target bot/venue-account row (per-owner default where no bot is
  named). Authored seam, no oracle — logged as such.
- **D3 → PRAGMATIC.** Pre-validation reject + one re-check immediately before `tool.execute`; do NOT thread
  `deadlineAt` into the copied drive path. Slight divergence from 005's "every side effect" wording → log in
  003. Backlog: **literal per-side-effect re-check** is a recorded later-option (docs/010).
- **D4 → OPTION B** (operator-config allowed actor types per consumer, NOT an invented per-tool rule map).
  Item 3 is satisfied as "the asserted `actor.type` is one the operator configured this consumer to assert"
  — a VALUE the operator injects (ports-carry-values), defaulting to all four types. No authored product
  policy. Backlog: **tightening B into a per-tool allow-map (Option A)** is a recorded later-option (docs/010),
  to be taken only once real product provenance rules exist.
- **D5 → AUTHOR FRESH.** Author a fresh, minimal compose stack (boundary + Postgres + Redis) as a durable
  F2c artifact; do NOT rebase the `l1-integration-harness` branch's compose (kept off main as YAGNI).
- **F2 sub-split (§6):** CONFIRMED (F2a store → F2b dispatcher integration → F2c stack+verification).
- **Rate-limiting (§7):** CONFIRMED OUT — `rate_limit.exceeded` stays a reserved-but-unused code.

---

## 9. Recommendation

Proceed with F2 as three slices (§6), **D1 = copy-adapt**, **D2 = authored resolver reading the target
row**, **D3 = pragmatic re-check**, **D4 = static per-tool allow-map**, **D5 = fresh minimal compose**.
On your steer, I will lock the decisions into 013 §8, write the F2a implementer prompt, and run the
coordinator loop — pausing between F2a/F2b/F2c as with F1.
