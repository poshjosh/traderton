# 025 — L1 In-Repo Integration Harness — Proposal

**Status:** APPROVED (2026-09-07, human) — the 4 decisions in §6 are locked: compose / gated-test /
all-four-scenarios / script-runs-migrate. **Executed on a branch** (`l1-integration-harness`), merged to
main on green (per the branch-per-verification-level model). This doc is now the design record; the
implementer prompt was 026-L1-implementer-prompt (never created as a separate file — L1 was built
directly on the `l1-integration-harness` branch; this design record + the branch are the trail).
**Level:** L1 of [024-verification-and-consumption-roadmap.md](../../docs/024-verification-and-consumption-roadmap.md)
(the in-repo end-to-end integration harness). Follows M1 code-complete.
**Feeds:** 024 (L1 row → Done on landing); the "Side-effecting parity validated" cutover gate in
[001](../../docs/001-parity-ledger.md).
**Grounding:** read-only investigation of the actual `createTradingRuntime` ports/return, the existing
smoke test + integration-db helper, the migration path, and the redis/BullMQ wiring (2026-09-07). Governed
by [AGENTS.md](../../AGENTS.md), [000](../../docs/000-vision.md), [024](../../docs/024-verification-and-consumption-roadmap.md).

> **The claim under test:** "the in-process library is consumable end-to-end — 25 tools reachable, drive
> path live, decision intake + bot lifecycle + per-owner limit enforced atomically." Today that rests on
> `pnpm test` (2315 pass) + a barrel that exports the right symbols. But **every existing test stubs the
> boundary it exercises** — the composition smoke test mocks BullMQ + `createDatabase` + redis; the db
> integration tests skip without `DATABASE_URL`; nothing has ever imported `@traderton/worker` and driven a
> real trade cycle against real infrastructure. L1 falsifies-or-substantiates the claim by doing exactly
> that, with **zero `@traderton/*` internals stubbed.**

---

## 1. What L1 is

A new integration harness that acts as a **real consumer** of `@traderton/worker`: it constructs
`createTradingRuntime({config, redis, instanceLoader})` against **real Postgres + real Redis**, drives a
paper bot lifecycle and a `submit_decision` through the real drive path, and asserts the real side-effects
(persisted rows, the decision reply, a maxBots rejection). It stubs **nothing inside `@traderton/*`** — only
the process edges that a consumer legitimately owns (the venue network for a paper bot, which never hits a
real exchange anyway).

## 2. Investigation findings (verified)

### 2a. The construction contract (`create-trading-runtime.ts`)
`createTradingRuntime(ports: TradingRuntimePorts): TradingRuntime`, where:
- `ports.config: AppConfig` — a paper `AppConfig` fixture already exists in the smoke test
  (`create-trading-runtime.test.ts` `paperConfig()`); L1 reuses/relocates it (real `database.url` +
  `redis.url`, `marketData` omitted so no provider-registry network).
- `ports.redis: Redis` (ioredis client) — used by `InstanceLease`, `createProviderRegistry`, and passed
  into `WorkerRuntimeConfig.redis`.
- `ports.instanceLoader: () => Promise<PersistedInstance[]>` — the consumer's "load running bots" hook.
- Returns `TradingRuntime`: `start`/`shutdown`/`runtime` + the item-C/D/E surfaces (`submitDecision`,
  `createDriveTarget`, `enqueueLifecycle`, `registerActor`, `constructAndRegisterAgentActor`).

### 2b. Infra is required and currently absent
- `DATABASE_URL` and `REDIS_URL` are **unset** in the environment; there is **no `docker-compose`** in the
  repo. So L1 must stand up Postgres + Redis. **`docker` is available** (`/usr/local/bin/docker`).
- **Postgres schema:** `@traderton/db` has a generated migration `drizzle/0000_init_trading_schema.sql` (22
  trading tables) + `db:migrate` (drizzle-kit). L1 applies this to the test DB before running.
- **Test-db helper exists:** `packages/db/src/test-helpers/integration-db.ts` (`openTestDb()` connects via
  `DATABASE_URL`; `truncate(...)`). The db integration tests use `describe.skipIf(!process.env.DATABASE_URL)`
  — L1 follows the **same gating pattern** so it skips cleanly in a no-infra environment and runs in CI /
  locally when infra is present.

### 2c. A real wiring seam L1 will exercise for the first time (a likely find)
`TradingRuntimePorts.redis` is typed `Redis` (ioredis client), but `WorkerRuntimeConfig.redis` is typed
`ConnectionOptions` — and `createTradingRuntime` passes the **ioredis client straight through**
(`runtimeConfig.redis = redis`), after which BullMQ does `new Queue(QUEUE_NAME, { connection: <ioredis
client> })`. BullMQ *does* accept a shared ioredis client as `connection` at runtime, but this exact path
(a real client → real BullMQ Queue/Worker → a real Redis lifecycle job processed) **has never run** — the
smoke test mocks `bullmq` entirely. L1 is the first thing to prove the enqueue→process round-trip actually
works against a real broker. (If it doesn't, that's a real bug to fix before F — precisely what L1 is for.)

### 2d. What "no `@traderton/*` stubbed" means here
- **Real:** `createTradingRuntime`, the composition singletons, `WorkerRuntime` (real BullMQ Queue/Worker),
  `InstanceLease`, the repos against real Postgres, the drive target, item-C `submitDecision`, the engine,
  the `BotLimitSeam` (real advisory lock), `TradingActor` (paper executor).
- **Legitimately at the edge (a consumer owns these, so the harness supplies them, not Traderton):** the
  paper bot uses the paper executor (no real venue network by design); `marketData` omitted (no provider
  network). If a scan tick needs a candle fetcher, use a paper/dca bot whose path doesn't require live
  market data — keep the harness deterministic without stubbing Traderton internals.

## 3. Proposed shape

A DATABASE_URL+REDIS-gated integration test (or a small `examples/` consumer script wrapped in a test),
living in `packages/worker` (the consumer's natural vantage), e.g.
`packages/worker/src/composition/runtime.integration.test.ts`, `describe.skipIf(!DATABASE_URL || !REDIS_URL)`.

**Scenarios (each asserts REAL side-effects, no Traderton stubbing):**
1. **Construct + lifecycle:** `createTradingRuntime(paperConfig, realRedis, loader)` → `start()` →
   `shutdown()` clean, with an empty loader (proves composition + real BullMQ + lease against live infra —
   the never-run path of §2c).
2. **Create + start a paper bot (drive path + lifecycle + limit):** build the drive target
   (`createDriveTarget({ownerId, actorId, ownerMode:'paper', venue, venueType:'orderbook', venueAccountId, …})`),
   `publishToInbound(MANAGE_BOT, {action:'create_and_start', config: paperBot})` → assert: a `bots` row
   persisted for the `ownerId` transitioning `stopped`→`running`; a `WorkerRuntime` lifecycle job enqueued
   + processed; the actor registered. (First real proof of `enqueueLifecycle` → BullMQ → `processJob`.)
3. **Submit a decision (drive round-trip + engine + reply):** register a running paper actor, then
   `publishToInbound(DECISION_SUBMIT, {decisionId, instrumentId, intent:'go_long', targetSize, _expectsReply:true})`
   → assert item-C `submitDecision` drove `submitDecisionForExecution` and a real plan/fill/position
   persisted (paper executor) + the `agent:decision:reply:${id}` key written in the shape `tools/trading.ts`
   `blpop` reads. (First real proof of the full decision round-trip.)
4. **maxBots enforced atomically:** with `maxBots=k`, create+start k paper bots for one `ownerId`, then the
   (k+1)th `create_and_start` is rejected with the herobids-parity limit message; a second `ownerId` is
   unaffected. (First real proof of the advisory-lock limit against live Postgres — complements the db-layer
   concurrency test.)

**Infra setup (harness prerequisite, NOT product code):**
- A `docker-compose.integration.yml` (Postgres + Redis) at repo root + a small script
  (`scripts/it-up.sh` / `package.json` `test:integration`) that: starts the containers, exports
  `DATABASE_URL`/`REDIS_URL`, applies the `@traderton/db` migration, runs the gated vitest, tears down.
  This is test/dev scaffolding (not `@traderton/*` trading code), so it is authored freely — it wires
  copied modules, authors no trading behaviour.

**Cleanup between scenarios:** `truncate(client, 'bots','decisions','execution_plans','orders','fills',
'positions', …)` + `redis FLUSHDB` on a dedicated test DB/Redis (the helper's `truncate` pattern).

## 4. Copy-vs-author

L1 is a **verification harness**, not a copy or an authored trading feature — so the copy-never-author law
applies as: **the harness authors NO trading behaviour and stubs NO `@traderton/*` internals**; it only
authors consumer-side wiring + test/infra scaffolding (compose file, the harness script, the assertions).
Any trading behaviour it observes must come from the real library. If the harness finds itself needing to
stub a Traderton internal to make a scenario pass, that is a signal the library isn't actually consumable
there — surface it as a finding, don't stub around it.

## 5. Verification / done criteria
- The gated harness runs green against real Postgres + Redis (locally via the compose script; skips cleanly
  without infra so the default `pnpm test` stays green at 2315/17 + these as additional skips).
- All four scenarios pass with real persisted side-effects — OR any that fail expose a real consumability
  gap, which is fixed as a bug through the normal review-fix loop before L1 is called done (nothing papered
  over). **Either outcome is a successful L1** — it converts the "consumable" claim from asserted to
  demonstrated (or finds the gap).
- Update [024](../../docs/024-verification-and-consumption-roadmap.md) L1 → Done with the evidence (what ran, what
  it proved, any gap found+fixed); note the harness command in the repo. Advance the 001 "Side-effecting
  parity validated" gate accordingly (partial — full parity is L2).

## 6. Decisions (resolved 2026-09-07, human)
1. **Infra = compose.** A repo `docker-compose.integration.yml` (Postgres + Redis) + a `test:integration`
   script that L1 (and later the db integration tests) share — one reusable local-infra path; docker is
   available.
2. **Form = gated test.** A `*.integration.test.ts` in `packages/worker`, `describe.skipIf(!DATABASE_URL ||
   !REDIS_URL)` — reuses the existing vitest gating + `openTestDb` helper; assertable + CI-native.
3. **Depth = all four scenarios.** Construct+lifecycle on live infra; create_and_start paper bot
   (drive+lifecycle+BullMQ round-trip); submit_decision (round-trip+engine+reply); maxBots rejection at
   k+1. L1 is the consumability proof, so it exercises the three never-run seams, not a token.
4. **Migration = script.** The `test:integration` script runs `db:migrate` against the test DB before
   vitest; the harness stays about behaviour, not schema bootstrapping.

**Execution:** on the `l1-integration-harness` branch. `026` implementer prompt is written next, then
implement → review → test → update 024/001 → merge on green. L1 green (or gap-found-and-fixed) unblocks
L2 and F.
