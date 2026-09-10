/**
 * L1 END-TO-END INTEGRATION HARNESS (docs/features/025 + 026) — VERIFICATION
 * SCAFFOLDING, not a copied parity oracle and not a trading feature.
 *
 * This is the first thing that imports `@traderton/worker` and drives a real
 * trade cycle against REAL Postgres + REAL Redis, with ZERO `@traderton/*`
 * internals stubbed. It is a real *consumer* of `createTradingRuntime`: it wires
 * a real ioredis client, the real BullMQ Queue/Worker, the real repos, the real
 * drive target, the real `submitDecision`, the real engine, the real
 * `BotLimitSeam` (advisory lock), and the real `TradingActor`/`AgentTradingActor`
 * (paper executor). The only things it supplies are the process edges a consumer
 * legitimately owns (paper mode → no venue network; `marketData` omitted → no
 * provider network) and the assertions.
 *
 * GATED: `describe.skipIf(!DATABASE_URL || !REDIS_URL)` — same pattern as
 * `packages/db/src/journal-pg.integration.test.ts`. With no infra (the default
 * `pnpm test`) this whole suite SKIPS (0 failures). It runs under
 * `pnpm test:integration` (scripts/it.sh brings up pg+redis, applies the
 * migration, exports the URLs).
 *
 * FINDINGS DISCIPLINE (026 §5): if a scenario can only pass by stubbing a
 * Traderton internal, that is a consumability gap to REPORT, not to stub around.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import IORedis from 'ioredis';
import postgres from 'postgres';
import { AGENT_MESSAGE_TYPES } from '@traderton/domain';
import type { AppConfig } from '@traderton/domain';
import { createTradingRuntime, type TradingRuntime } from './create-trading-runtime.js';
import { paperConfig, paperBotConfig } from './test-fixtures.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const REDIS_URL = process.env['REDIS_URL'];
const SKIP = !DATABASE_URL || !REDIS_URL;

/**
 * The paper AppConfig, but with `database.url`/`redis.url` pointed at the REAL
 * test infra (026 §3). The shared fixture hard-codes stub URLs (fine for the
 * mocked smoke test); the runtime opens its DB connection from
 * `config.database.url`, so a live harness MUST override it.
 */
function liveConfig(): AppConfig {
  const config = paperConfig();
  return {
    ...config,
    database: { ...config.database, url: DATABASE_URL! },
    redis: { ...config.redis, url: REDIS_URL! },
  } as AppConfig;
}

/** Poll `check` until it returns truthy or the timeout elapses. */
async function waitFor<T>(
  check: () => T | Promise<T>,
  { timeoutMs = 10_000, intervalMs = 100 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await check();
    if (result) return result;
    if (Date.now() >= deadline) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe.skipIf(SKIP)('L1 integration harness — createTradingRuntime against real Postgres + Redis', () => {
  // A raw postgres client for seeding venue_accounts + asserting persisted rows,
  // and a raw ioredis client for reading the decision-reply key. Both are
  // consumer-owned infra, not @traderton/* internals.
  let sql: ReturnType<typeof postgres>;
  let assertRedis: IORedis;

  beforeAll(() => {
    sql = postgres(DATABASE_URL!, { max: 1 });
    assertRedis = new IORedis(REDIS_URL!, { maxRetriesPerRequest: null });
  }, 30_000);

  afterAll(async () => {
    await sql.end();
    assertRedis.disconnect();
  });

  beforeEach(async () => {
    // Clean slate between scenarios (the @traderton/db truncate pattern + FLUSHDB).
    await sql.unsafe(
      `TRUNCATE bots, decisions, execution_plans, orders, fills, positions, venue_accounts, journal_events, reconciliation_events, balance_snapshots CASCADE`,
    );
    await assertRedis.flushdb();
  });

  /** A dedicated BullMQ-safe ioredis client (maxRetriesPerRequest:null) for the runtime under test. */
  function makeRuntimeRedis(): IORedis {
    return new IORedis(REDIS_URL!, { maxRetriesPerRequest: null });
  }

  async function seedVenueAccount(id: string, ownerId: string, venue = 'hyperliquid'): Promise<void> {
    await sql.unsafe(
      `INSERT INTO venue_accounts (id, owner_id, venue, label) VALUES ($1, $2, $3, $4)`,
      [id, ownerId, venue, `label-${id}`],
    );
  }

  // ── Scenario 1: construct + lifecycle on live infra (the never-run seam) ──
  it('scenario 1: constructs, starts, and shuts down cleanly against live Postgres + Redis', async () => {
    const redis = makeRuntimeRedis();
    const runtime: TradingRuntime = createTradingRuntime({
      config: liveConfig(),
      redis,
      instanceLoader: async () => [],
    });

    // The never-run path (025 §2c): the ioredis client is passed straight into
    // WorkerRuntimeConfig.redis → new Queue({connection}). This is the first real
    // exercise of that seam against a real broker.
    await expect(runtime.start()).resolves.toBeUndefined();
    await expect(runtime.shutdown()).resolves.toBeUndefined();

    redis.disconnect();
  }, 30_000);

  // ── Scenario 2: create + start a paper bot (drive → BullMQ → factory) ──
  it('scenario 2: create_and_start drives a paper bot to running + registers the actor', async () => {
    await seedVenueAccount('va-1', 'owner-1');

    const redis = makeRuntimeRedis();
    const runtime = createTradingRuntime({
      config: liveConfig(),
      redis,
      instanceLoader: async () => [],
    });
    await runtime.start();

    try {
      const publishToInbound = runtime.createDriveTarget({
        ownerId: 'owner-1',
        actorId: 'agent-1',
        ownerMode: 'paper',
        venue: 'hyperliquid',
        venueType: 'orderbook',
        venueAccountId: 'va-1',
      });

      await publishToInbound(AGENT_MESSAGE_TYPES.MANAGE_BOT, {
        action: 'create_and_start',
        config: paperBotConfig(),
      });

      // A bots row for owner-1 must persist and reach 'running' (create inserts
      // 'stopped', the create→mark claims 'running' before the start job enqueues).
      const runningRow = await waitFor(
        async () => {
          const rows = await sql.unsafe<Array<{ id: string; status: string }>>(
            `SELECT id, status FROM bots WHERE owner_id = $1`,
            ['owner-1'],
          );
          return rows.find((r) => r.status === 'running') ?? null;
        },
        { timeoutMs: 15_000 },
      );
      expect(runningRow, 'a bots row for owner-1 should reach status=running').not.toBeNull();

      // The lifecycle job must have been enqueued → processed → the TradingActor
      // registered on the ONE shared registry (keyed by bot id).
      const botId = runningRow!.id;
      const registered = await waitFor(() => runtime.actorRegistry.has(botId), { timeoutMs: 15_000 });
      expect(registered, 'the bot actor should be registered after the lifecycle job processes').toBe(true);
    } finally {
      await runtime.shutdown();
      redis.disconnect();
    }
  }, 45_000);

  // ── Scenario 3: submit a decision (drive round-trip → engine → reply) ──
  it('scenario 3: submit_decision drives the engine and writes the reply key', async () => {
    await seedVenueAccount('va-1', 'owner-1');

    const redis = makeRuntimeRedis();
    const runtime = createTradingRuntime({
      config: liveConfig(),
      redis,
      instanceLoader: async () => [],
    });
    await runtime.start();

    // Register + start a running paper actor under the drive target's actorId
    // (the decision routes to registry key = actorId). A paper agent actor needs
    // no venue adapter/credentials (start() short-circuits for paper mode).
    const actor = runtime.constructAndRegisterAgentActor({
      agentId: 'agent-1',
      executionMode: 'paper',
      venueAccountId: 'va-1',
      venue: 'hyperliquid',
      venueType: 'orderbook',
    });
    await actor.start();

    try {
      const publishToInbound = runtime.createDriveTarget({
        ownerId: 'owner-1',
        actorId: 'agent-1',
        ownerMode: 'paper',
        venue: 'hyperliquid',
        venueType: 'orderbook',
        venueAccountId: 'va-1',
      });

      const decisionId = `dec-${crypto.randomUUID()}`;
      await publishToInbound(AGENT_MESSAGE_TYPES.DECISION_SUBMIT, {
        decisionId,
        instrumentId: 'BTC/USD:USD',
        intent: 'go_long',
        targetSize: '1',
        rationaleSummary: 'it',
        _expectsReply: true,
      });

      // The reply key must be written in the shape tools/trading.ts's blpop reads:
      // lpush(agent:decision:reply:${id}, JSON.stringify(result)) + expire(60).
      const replyKey = `agent:decision:reply:${decisionId}`;
      const raw = await waitFor(
        async () => {
          const v = await assertRedis.lindex(replyKey, 0);
          return v ?? null;
        },
        { timeoutMs: 15_000 },
      );
      expect(raw, 'a decision reply should be written to the reply key').not.toBeNull();

      const reply = JSON.parse(raw!) as { status: string; planId?: string; code?: string };
      // Either the paper executor drove a real plan (accepted) OR the engine
      // returned a typed rejection (e.g. no_context when the mark could not be
      // fetched) — both are REAL engine-driven outcomes routed through the real
      // submitDecision. Assert the reply is one of the engine's typed statuses.
      expect(['accepted', 'rejected', 'error']).toContain(reply.status);

      if (reply.status === 'accepted') {
        // A real paper plan persisted — assert the side-effect reached Postgres.
        const plans = await sql.unsafe<Array<{ id: string }>>(`SELECT id FROM execution_plans`);
        expect(plans.length, 'an accepted decision should persist an execution plan').toBeGreaterThan(0);
      }
    } finally {
      await runtime.shutdown();
      redis.disconnect();
    }
  }, 45_000);

  // ── Scenario 4: maxBots enforced atomically at k+1 (real advisory lock) ──
  it('scenario 4: the (k+1)th create_and_start for one owner is rejected; a second owner succeeds', async () => {
    const k = 2;
    await seedVenueAccount('va-1', 'owner-1');
    await seedVenueAccount('va-2', 'owner-2');

    const redis = makeRuntimeRedis();
    const runtime = createTradingRuntime({
      config: liveConfig(),
      redis,
      instanceLoader: async () => [],
    });
    await runtime.start();

    try {
      const driveOwner1 = runtime.createDriveTarget({
        ownerId: 'owner-1',
        actorId: 'agent-1',
        ownerMode: 'paper',
        venue: 'hyperliquid',
        venueType: 'orderbook',
        venueAccountId: 'va-1',
        maxBotsOverride: k,
      });

      // k create_and_start for owner-1 succeed (the atomic per-owner limit seam
      // against live Postgres claims k running slots).
      for (let i = 0; i < k; i++) {
        await expect(
          driveOwner1(AGENT_MESSAGE_TYPES.MANAGE_BOT, { action: 'create_and_start', config: paperBotConfig() }),
        ).resolves.toBeUndefined();
      }

      await waitFor(
        async () => {
          const rows = await sql.unsafe<Array<{ n: string }>>(
            `SELECT count(*)::text AS n FROM bots WHERE owner_id = $1 AND status = 'running'`,
            ['owner-1'],
          );
          return Number(rows[0]!.n) >= k;
        },
        { timeoutMs: 15_000 },
      );

      // The (k+1)th is rejected with the herobids-parity limit message (the
      // handler throws → publishToInbound rejects).
      await expect(
        driveOwner1(AGENT_MESSAGE_TYPES.MANAGE_BOT, { action: 'create_and_start', config: paperBotConfig() }),
      ).rejects.toThrow(/max concurrent bots limit/i);

      // owner-1 still has exactly k running bots (the k+1th did not persist a slot).
      const owner1Running = await sql.unsafe<Array<{ n: string }>>(
        `SELECT count(*)::text AS n FROM bots WHERE owner_id = $1 AND status = 'running'`,
        ['owner-1'],
      );
      expect(Number(owner1Running[0]!.n)).toBe(k);

      // A second owner is unaffected (per-owner keying) — its create_and_start succeeds.
      const driveOwner2 = runtime.createDriveTarget({
        ownerId: 'owner-2',
        actorId: 'agent-2',
        ownerMode: 'paper',
        venue: 'hyperliquid',
        venueType: 'orderbook',
        venueAccountId: 'va-2',
        maxBotsOverride: k,
      });
      await expect(
        driveOwner2(AGENT_MESSAGE_TYPES.MANAGE_BOT, { action: 'create_and_start', config: paperBotConfig() }),
      ).resolves.toBeUndefined();

      const owner2Running = await waitFor(
        async () => {
          const rows = await sql.unsafe<Array<{ n: string }>>(
            `SELECT count(*)::text AS n FROM bots WHERE owner_id = $1 AND status = 'running'`,
            ['owner-2'],
          );
          return Number(rows[0]!.n) >= 1 ? rows[0]!.n : null;
        },
        { timeoutMs: 15_000 },
      );
      expect(Number(owner2Running)).toBe(1);
    } finally {
      await runtime.shutdown();
      redis.disconnect();
    }
  }, 60_000);
});
