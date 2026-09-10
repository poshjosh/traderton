# 026 — L1 Implementer Prompt (in-repo integration harness)

**Status:** ready to hand to an implementer. **Executed on the `l1-integration-harness` branch.**
**Task:** build the L1 end-to-end integration harness — a real consumer of `@traderton/worker` that runs
`createTradingRuntime` against **real Postgres + real Redis** and drives a paper bot + a decision + a
maxBots rejection, with **zero `@traderton/*` internals stubbed**.
**Authoritative brief:** [025-L1-integration-harness-proposal.md](./025-L1-integration-harness-proposal.md)
(design record + decisions) and [024](../024-verification-and-consumption-roadmap.md). Read both. This
prompt is the actionable checklist; **025 wins on any conflict.**

---

## 0. Orient first

You are in **Traderton** (`/Users/chinomso.ikwuagwu/dev_ai/traderton`), on branch
`l1-integration-harness`. Read [AGENTS.md](../../AGENTS.md), [000](../000-vision.md),
[024](../024-verification-and-consumption-roadmap.md), and [025](./025-L1-integration-harness-proposal.md).
Assume no chat context.

**What L1 is and is not:**
- L1 is **verification scaffolding**, not a trading feature and not a copy. It proves the claim "the
  in-process library is consumable end-to-end." Everything to date stubs its boundary; L1 stubs **nothing
  inside `@traderton/*`**.
- **The law applied to L1:** author no trading behaviour; stub no `@traderton/*` internal. You author only
  consumer-side wiring + test/infra scaffolding (a compose file, a script, the harness + assertions). Any
  trading behaviour the harness observes must come from the real library. **If you find yourself needing to
  stub a Traderton internal to make a scenario pass, STOP — that is a consumability finding to surface, not
  to stub around.**
- **Either outcome is a successful L1:** green proves consumability; a real failure exposes a gap to fix as
  a bug (via the coordinator's review-fix loop) before L1 is done. Do not paper over a gap to get green.

## 1. Decisions (LOCKED — 025 §6)
1. **Infra = compose.** A repo `docker-compose.integration.yml` (Postgres + Redis) + a `test:integration`
   script.
2. **Form = gated test.** A `*.integration.test.ts` in `packages/worker`, `describe.skipIf(!DATABASE_URL ||
   !REDIS_URL)` — same gating as `packages/db/src/journal-pg.integration.test.ts`.
3. **Depth = all four scenarios** (§4).
4. **Migration = script.** The `test:integration` script runs the `@traderton/db` migration against the
   test DB before vitest (the harness does not bootstrap schema).

## 2. Infra scaffolding (author freely — dev/test only, no trading behaviour)

- **`docker-compose.integration.yml`** at repo root: a Postgres service (v16+; a DB named e.g. `traderton`,
  user/pass `traderton`/`traderton` to match `drizzle.config.ts`'s default) + a Redis service (v7+). Expose
  ports (5432/6379 or non-default to avoid clashes — your call; the script exports the matching URLs).
- **`scripts/it.sh`** (or equivalent) wired as `package.json` `"test:integration"`: (1) `docker compose -f
  docker-compose.integration.yml up -d`; (2) wait for pg+redis health; (3) export
  `DATABASE_URL`/`REDIS_URL`; (4) apply the schema — `pnpm --filter @traderton/db exec drizzle-kit migrate`
  (drizzle.config reads `DATABASE_URL`, applies `packages/db/drizzle/0000_init_trading_schema.sql`); (5)
  `pnpm vitest run` the gated harness (a focused include, so `test:integration` runs the integration
  suite, not the whole tree); (6) `docker compose … down -v` on exit (trap). Keep it a plain shell script;
  don't over-engineer.
- The default `pnpm test` MUST stay green unchanged: the harness is gated, so with no `DATABASE_URL`/
  `REDIS_URL` it **skips** (adds to the skip count, 0 failures). Confirm this.

## 3. The construction contract (verified — build the consumer against this)
`createTradingRuntime(ports): TradingRuntime` (`packages/worker/src/composition/create-trading-runtime.ts`):
- `ports.config: AppConfig` — **reuse the paper `AppConfig` fixture** already in
  `create-trading-runtime.test.ts` (`paperConfig()`): `marketData` omitted (no provider network), paper
  execution. Set `database.url` = `process.env.DATABASE_URL`, `redis.url` = `process.env.REDIS_URL`.
  Consider relocating the fixture to a shared test helper so both the smoke test and L1 use one copy (do
  NOT edit the smoke test's behaviour — if relocating is fiddly, duplicate the fixture in the harness).
- `ports.redis: Redis` — a **real ioredis client** (`new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null })`
  — BullMQ requires `maxRetriesPerRequest: null` on its connection; if the shared client trips BullMQ, that
  is itself a finding — see §5 note).
- `ports.instanceLoader: () => Promise<PersistedInstance[]>` — the harness supplies bots to rehydrate
  (`[]` for scenario 1; a running paper bot for reclaim if a scenario needs it).
- Returns `TradingRuntime`: `start`/`shutdown`/`runtime`, plus `submitDecision`, `createDriveTarget(injection)`,
  `enqueueLifecycle`, `registerActor`/`deregisterActor`, `constructAndRegisterAgentActor`.

## 4. The four scenarios (each asserts REAL side-effects; nothing in `@traderton/*` stubbed)

Use a dedicated test DB + Redis; between scenarios `truncate(client, 'bots','decisions','execution_plans',
'orders','fills','positions', …)` (the `@traderton/db` `truncate` helper) + `redis.flushdb()`.

1. **Construct + lifecycle on live infra.** `createTradingRuntime(paperConfig, realRedis, async () => [])`
   → `await start()` → `await shutdown()` clean. Proves composition + real BullMQ Queue/Worker + the
   `InstanceLease` against live Postgres+Redis — **the never-run path** (025 §2c: the ioredis client is
   passed straight into `WorkerRuntimeConfig.redis` typed `ConnectionOptions`, then `new Queue({connection})`).
2. **Create + start a paper bot (drive → lifecycle → BullMQ round-trip).** Build the drive target:
   `const publishToInbound = runtime.createDriveTarget({ ownerId:'owner-1', actorId:'agent-1',
   ownerMode:'paper', venue:'hyperliquid', venueType:'orderbook', venueAccountId:'va-1' })`. First seed the
   venue account row the bot FK-references (`venue_accounts` — insert `{id:'va-1', ownerId:'owner-1',
   venue:'hyperliquid', …}` via the db, since `bots.venueAccountId` is a `restrict` FK). Then
   `await publishToInbound(AGENT_MESSAGE_TYPES.MANAGE_BOT, { action:'create_and_start', config: paperBot })`
   where `paperBot` is a paper DCA/orderbook config (reuse `paperBotConfig()` shape). **Assert:** a `bots`
   row persisted for `owner-1` reaching `status:'running'` (create inserts `stopped`, the create→mark
   claims `running`); a `WorkerRuntime` lifecycle job was enqueued + processed (the actor exists in
   `runtime.actorRegistry` / the actors map). Proves `enqueueLifecycle` → real BullMQ → `processJob` →
   `ActorFactory` end-to-end.
3. **Submit a decision (drive round-trip → engine → reply).** With a running paper actor registered (from
   scenario 2, or construct+register one), `await publishToInbound(AGENT_MESSAGE_TYPES.DECISION_SUBMIT,
   { decisionId, instrumentId, intent:'go_long', targetSize:'1', rationaleSummary:'it', _expectsReply:true })`.
   **Assert:** item-C `submitDecision` drove `submitDecisionForExecution` and a real plan/fill/position
   persisted (paper executor) OR a typed rejection persisted a decision-failure — either is a real
   engine-driven outcome; assert whichever the paper path produces deterministically; AND the
   `agent:decision:reply:${decisionId}` key was written in the shape `tools/trading.ts`'s `blpop` reads
   (`{status, planId?, …}`). Proves the full decision round-trip against real infra.
4. **maxBots enforced atomically.** Set the harness config's `agentRiskDefaults.maxBots = k` (small, e.g.
   2) OR inject `maxBotsOverride: k` on the drive target. Create+start k paper bots for `owner-1`; the
   (k+1)th `create_and_start` is **rejected** with the herobids-parity limit message; a `create_and_start`
   for `owner-2` still succeeds (per-owner keying). Proves the real advisory-lock limit against live
   Postgres (complements the db-layer concurrency test, which is the pure-concurrency proof).

Keep each scenario deterministic. Paper mode means no real venue network; do not stub the paper executor —
use it.

## 5. Guardrails / findings discipline
- **Stub nothing inside `@traderton/*`.** Real `createTradingRuntime`, `WorkerRuntime`, BullMQ, repos,
  drive target, `submitDecision`, engine, `BotLimitSeam`, `TradingActor`.
- **If a scenario cannot pass without stubbing a Traderton internal, or a real seam breaks** (e.g. BullMQ
  rejects the shared ioredis client; a repo insert fails; the reply key never appears; the advisory lock
  doesn't serialize) → that is a **consumability gap**. STOP and report it precisely (what broke, where,
  the error). The coordinator routes it as a bug fix (review-fix loop) before L1 is done — DO NOT stub
  around it or weaken the assertion.
- The infra/compose/script/harness scaffolding is authored freely (it's dev/test, not trading) — but it
  must exercise the real library, not simulate it.
- Do not edit any `@traderton/*` product code to make the harness pass **as part of the harness commit**;
  surface the gap and let the coordinator gate the fix as a separate reviewed change.

## 6. Verification / done criteria
- `pnpm test` (no infra) stays green: 2315 passed / 17 skipped + the new harness as additional **skips**
  (0 failures) — confirm the gating.
- `pnpm test:integration` (compose up) runs the four scenarios green against real pg+redis — OR surfaces a
  gap (reported precisely; fixed via the loop before done).
- `pnpm build` green, `pnpm lint` clean (the harness + any shared fixture typecheck).
- Report: the files added (compose, script, harness, any shared fixture), whether all four scenarios pass
  against real infra, and **any consumability gap found** (with the exact failure). Do NOT commit — the
  coordinator commits on the branch.

## 7. Key file map
- `packages/worker/src/composition/create-trading-runtime.ts` — `createTradingRuntime` + `TradingRuntime`
  (the consumer contract; `createDriveTarget`, `submitDecision`, `enqueueLifecycle`).
- `packages/worker/src/composition/create-trading-runtime.test.ts` — the `paperConfig()` + `paperBotConfig()`
  fixtures to reuse.
- `packages/worker/src/composition/drive-target.ts` — `AGENT_MESSAGE_TYPES` usage, the `MANAGE_BOT` /
  `DECISION_SUBMIT` payload shapes, the `DriveTargetInjection` fields.
- `packages/db/src/test-helpers/integration-db.ts` — `openTestDb()` + `truncate()` (the infra helper +
  gating pattern to reuse; `describe.skipIf(!process.env.DATABASE_URL)`).
- `packages/db/drizzle/0000_init_trading_schema.sql` + `packages/db/drizzle.config.ts` — the migration the
  script applies (`drizzle-kit migrate`, reads `DATABASE_URL`).
- `packages/db/src/schema/{bots,venue-accounts}.ts` — the columns the harness seeds/asserts (`bots.ownerId`,
  `venueAccountId` restrict-FK → seed a `venue_accounts` row first).
- `packages/worker/src/runtime.ts` — `WorkerRuntime` (BullMQ Queue/Worker `{connection}`), `enqueueLifecycle`,
  `PersistedInstance`/`InstanceLoader`.
