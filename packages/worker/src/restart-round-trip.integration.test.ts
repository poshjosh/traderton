// AUTHORED (Wave E E2 step 5) — the restart round-trip proof.
//
// DATABASE_URL + REDIS_URL gated (skip locally without them — the same gating
// the boundary verification integration suite uses). Appended to
// scripts/shell/tests/run-integration.sh, which provisions a throwaway
// Postgres:16 + Redis:7, migrates, then runs the gated suites. The default
// `pnpm test` run (no DB/REDIS env) skips this file entirely.
//
// It proves the resume ruling (overview 000): a graceful Traderton shutdown
// leaves a running bot's row `status='running'`, and the NEXT process reclaims
// it purely from that row via `createRunningBotLoader` — no explicit start call.
//
//   CASE A (resume): seed + start a PAPER bot on runtime #1 → the initial sweep
//     rehydrates + starts the actor → shutdown() runtime #1 (stops the actor,
//     releases its Redis lease, leaves the row running) → the bots row is STILL
//     `running` → a FRESH runtime #2 built with `createRunningBotLoader` reclaims
//     it: its initial sweep LOADS the running row, re-acquires the released lease,
//     and starts the actor again. No explicit start is issued to runtime #2 — the
//     actor comes back purely from the running row.
//
//   CASE B (halt not reclaimed): a bot whose row is `status='stopped'` (the state a
//     halt or explicit stop leaves) is NOT loaded by the running-bot loader, so a
//     fresh runtime starts no actor for it.
//
// A PAPER `dca` bot is used deliberately: `createStrategy` routes `dca` to the
// timer-driven `DcaStrategy` (no candle fetcher / market-data registry needed),
// and paper mode means `TradingActor.start()` opens no venue/stream connections
// and skips reconciliation — so the actor starts end-to-end against Postgres +
// Redis ALONE, no network, no credentials.
//
// Determinism: the sweep is driven EXPLICITLY via `runtime.start()` (which runs
// the initial `reclaimOrphans()` sweep synchronously). We never wait for the 15s
// periodic reclaim timer, and we never sleep hoping an actor appears. We call
// `trading.runtime.start()` directly rather than the composition `trading.start()`
// so the market-data provider warmup / instrument-cache / instrument-table
// population (all network, all only reachable through `trading.start()`) never
// run — keeping the test offline and fast while still driving the real loader →
// factory → actor path.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Redis } from 'ioredis';
import {
  BotRepository,
  createDatabase,
  closeDatabase,
  type Database,
} from '@traderton/db';
import type { AppConfig } from '@traderton/domain';
import {
  createTradingRuntime,
  createRunningBotLoader,
  loadConfig,
  type TradingRuntime,
} from './index.js';

const SKIP = !process.env['DATABASE_URL'] || !process.env['REDIS_URL'];

// ── Fixtures ────────────────────────────────────────────────────────────────

const OWNER_ID = 'owner-restart';
const VENUE_ACCOUNT_ID = 'va-restart';
const CREATOR_ID = 'agent-restart';
const MAX_BOTS = 10;

/** A valid PAPER `dca` bot config carrying the stamped venue/venueType the
 *  ActorFactory reads off the persisted config (`config_.venue!` / `venueType!`).
 *  `dca` avoids the mechanical candle-fetcher requirement; paper avoids any venue
 *  connection — so the actor starts against Postgres + Redis alone. */
function paperDcaConfig(): Record<string, unknown> {
  return {
    symbol: 'BTC-USDC',
    strategy: { type: 'dca' },
    execution: { mode: 'paper' },
    venue: 'hyperliquid',
    venueType: 'orderbook',
  };
}

describe.skipIf(SKIP)('bot restart round-trip (integration)', () => {
  let db: Database;
  /** The underlying postgres-js client for raw truncate/seed SQL — reached via
   *  the drizzle client's `$client` (the handle `closeDatabase` closes), matching
   *  the boundary integration suite (avoids a `postgres` import the worker
   *  package does not directly depend on). */
  let sql: { unsafe: (query: string, params?: unknown[]) => Promise<unknown[]> };
  let botRepo: BotRepository;
  let config: AppConfig;
  /** Every runtime started in a test is tracked here so afterEach can tear down
   *  any that a failing assertion left running (no lease / connection leaks). */
  let runtimes: TradingRuntime[];
  /** Every Redis connection opened in a test — quit in afterEach. */
  let redises: Redis[];
  /** apiKey env vars we set so loadConfig()'s superRefine passes — saved so
   *  afterAll can restore them (this suite shares the vitest process with the
   *  boundary suites under --no-file-parallelism; env mutation must not leak). */
  let savedEnv: Record<string, string | undefined>;

  beforeAll(() => {
    // The committed config/default.yaml keeps several providers apiKey-gated
    // (birdeye/coinMarketCap enabled; jupiter/1inch walletGeneration enabled), so
    // AppConfigSchema.superRefine rejects loadConfig() unless those keys are
    // present. This test never calls trading.start() (no provider-registry / no
    // network — see the file header), so the keys are never USED; supply dummy
    // non-empty values purely to satisfy the presence gates. loadConfig reads
    // these exact override vars (see worker/src/config.ts ENV_OVERRIDES).
    const DUMMY_KEY_VARS = ['BIRDEYE_API_KEY', 'COINMARKETCAP_API_KEY', 'JUPITER_API_KEY', 'ONEINCH_API_KEY'] as const;
    savedEnv = {};
    for (const name of DUMMY_KEY_VARS) {
      savedEnv[name] = process.env[name];
      if (!process.env[name]) process.env[name] = 'integration-test-dummy';
    }

    config = loadConfig();
    db = createDatabase(config.database.url);
    sql = (db as unknown as { $client: typeof sql }).$client;
    botRepo = new BotRepository(db);
  }, 30_000);

  afterAll(async () => {
    for (const [name, prev] of Object.entries(savedEnv)) {
      if (prev === undefined) delete process.env[name];
      else process.env[name] = prev;
    }
    await closeDatabase(db);
  });

  beforeEach(async () => {
    runtimes = [];
    redises = [];
    await sql.unsafe(`TRUNCATE bots, venue_accounts, boundary_invocations CASCADE`);
    await sql.unsafe(
      `INSERT INTO venue_accounts (id, owner_id, venue, label) VALUES ($1, $2, $3, $4)`,
      [VENUE_ACCOUNT_ID, OWNER_ID, 'hyperliquid', 'label-restart'],
    );
  });

  afterEach(async () => {
    // Shut down any runtime still up (idempotent — shutdown stops actors + releases
    // leases), then quit every Redis connection, so no lease or socket leaks into
    // the next test.
    for (const trading of runtimes) {
      await trading.shutdown().catch(() => {});
    }
    for (const redis of redises) {
      await redis.quit().catch(() => {});
    }
  });

  /** Build a trading runtime wired to the REAL running-bot loader + a fresh Redis
   *  connection. Registered for teardown. Each runtime gets its OWN InstanceLease
   *  worker id (constructed inside createTradingRuntime), so runtime #2 reclaiming
   *  runtime #1's released lease is a genuine cross-process reclaim. */
  function buildRuntime(): TradingRuntime {
    const redis = new Redis(config.redis.url, { maxRetriesPerRequest: null });
    redises.push(redis);
    const trading = createTradingRuntime({
      config,
      redis,
      instanceLoader: createRunningBotLoader(db),
    });
    runtimes.push(trading);
    return trading;
  }

  /** Seed a bot row the way the drive target's create+start path leaves it: a
   *  create (`tryCreateBotWithLimit`, inserts status='stopped') followed by a
   *  running mark (`tryMarkBotRunningWithLimit`). Returns the generated bot id. */
  async function seedRunningPaperBot(): Promise<string> {
    const created = await botRepo.tryCreateBotWithLimit({
      ownerId: OWNER_ID,
      venueAccountId: VENUE_ACCOUNT_ID,
      config: paperDcaConfig(),
      creatorType: 'agent',
      creatorId: CREATOR_ID,
      maxBots: MAX_BOTS,
    });
    expect(created.created).toBe(true);
    const botId = created.botId!;
    const marked = await botRepo.tryMarkBotRunningWithLimit({
      botId,
      ownerId: OWNER_ID,
      creatorType: 'agent',
      creatorId: CREATOR_ID,
      maxBots: MAX_BOTS,
    });
    expect(marked).toBe(true);
    return botId;
  }

  async function statusOf(botId: string): Promise<string | null> {
    const row = await botRepo.getBotById(botId);
    return row?.status ?? null;
  }

  it('CASE A: a running bot survives a graceful shutdown and is reclaimed by a fresh runtime', async () => {
    const botId = await seedRunningPaperBot();

    // ── Runtime #1: the initial sweep rehydrates + starts the actor ──
    const first = buildRuntime();
    await first.runtime.start();
    // The loader loaded the running row, the lease was acquired, the factory ran,
    // and the actor started — observable on the runtime's active-instance set and
    // the shared execution-actor registry.
    expect(first.runtime.activeInstances).toContain(botId);
    expect(first.actorRegistry.has(botId)).toBe(true);

    // ── Graceful shutdown: stops the actor, releases the lease, leaves the row running ──
    await first.shutdown();
    expect(await statusOf(botId)).toBe('running');

    // ── Runtime #2 (a DIFFERENT lease worker id): reclaims PURELY from the row ──
    // No explicit start call — the actor comes back only because the loader loaded
    // the running row and the initial sweep started it.
    const second = buildRuntime();
    await second.runtime.start();
    expect(second.runtime.activeInstances).toContain(botId);
    expect(second.actorRegistry.has(botId)).toBe(true);

    // Row remains running throughout the round-trip.
    expect(await statusOf(botId)).toBe('running');
  }, 60_000);

  it('CASE B: a stopped bot is NOT reclaimed by a fresh runtime', async () => {
    // A halt / explicit stop leaves the row status='stopped'. Seed that terminal
    // state directly (create → mark running → mark stopped mirrors a halted bot).
    const botId = await seedRunningPaperBot();
    await botRepo.markBotStopped(botId);
    expect(await statusOf(botId)).toBe('stopped');

    const trading = buildRuntime();
    await trading.runtime.start();

    // The running-bot loader filters WHERE status='running', so the stopped row is
    // never loaded — no actor is started for it.
    expect(trading.runtime.activeInstances).not.toContain(botId);
    expect(trading.actorRegistry.has(botId)).toBe(false);
    expect(await statusOf(botId)).toBe('stopped');
  }, 60_000);
});
