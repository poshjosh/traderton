// AUTHORED (001 S5) — the multi-replica owner-routing + takeover proof.
//
// DATABASE_URL + REDIS_URL gated (skip locally without them — the same gating
// every boundary/worker integration suite uses). Appended to
// scripts/shell/tests/run-integration.sh, which provisions a throwaway
// Postgres:16 + Redis:7, migrates, then runs the gated suites. The default
// `pnpm test` run (no DB/REDIS env) skips this file entirely.
//
// It proves the 001 design end-to-end over REAL Redis + Postgres: two boundary
// trading runtimes (A and B) built in ONE test process, each its OWN
// `createTradingRuntime` (⇒ its own `workerId` + its own Redis connection) but
// SHARING a single Postgres + a single Redis server. This is the genuine
// cross-replica wiring that the S2/S4 lease unit tests could only model over an
// in-memory holder map (001 S4 note: "True cross-replica interleaving over real
// Redis is proven by S5").
//
//   CASE 1 (owner routing): activate the agent on A (A acquires the
//     `agent:{agentId}` lease → constructs + starts the PAPER agent actor
//     locally). On B, the SAME S2 ensure resolves `{owner:'remote', workerId: A}`
//     — B constructs nothing. A `DECISION_SUBMIT` driven through B's S3 sender
//     (`wrapPublishToInbound`) is RPUSH-ed to `agent-actor:cmd:{A.workerId}`,
//     A's S3 consumer pops it, the lease guard passes (A still holds it), A runs
//     the decision on its LOCAL actor, and the reply lands on
//     `agent:decision:reply:{decisionId}` where B's caller (a BLPOP, exactly as
//     the copied submit_decision tool does) reads it. The actor exists ONLY on A.
//     The decision itself may be rejected (a paper agent with no live mark has no
//     decision context) — the PROOF is that it EXECUTED on A (A's drive target
//     wrote the reply; the actor lives only on A), not that it was accepted.
//
//   CASE 2 (takeover after a non-graceful death): simulate A dying WITHOUT a
//     graceful release — stop A's lease renewal (`A.agentLease.shutdown()`) AND
//     delete the `lease:instance:agent:{agentId}` key directly to simulate the
//     30s TTL expiring (deterministic — no real wait). B's orphan sweep tick
//     (`runAgentOrphanSweep`) then re-ensures the still-`running` agent run row,
//     acquires the now-free lease, and starts the actor on B. A new
//     `DECISION_SUBMIT` through B now resolves `{owner:'local'}` and executes on
//     B directly. The actor now exists on B.
//
// Determinism: the orphan sweep is driven EXPLICITLY via `runAgentOrphanSweep`
// (never the periodic timer), and A's "death" is simulated by deleting the lease
// key rather than sleeping out the TTL. The PAPER agent actor starts offline —
// `AgentTradingActor.start()` in paper mode builds a `PaperExecutor`, opens no
// venue/stream connection, and skips reconciliation — so the whole proof runs
// against Postgres + Redis ALONE, no network, no credentials.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Redis } from 'ioredis';
import { AGENT_MESSAGE_TYPES } from '@traderton/domain';
import {
  AgentActorRunRepository,
  BotRepository,
  createDatabase,
  closeDatabase,
  type Database,
} from '@traderton/db';
import {
  loadConfig,
  createLogger,
  type TradingRuntime,
} from '@traderton/worker';
import { buildBoundaryTradingRuntime } from './build-boundary-runtime.js';
import {
  buildAgentDirectActorEnsure,
  type AgentDirectActorEnsure,
  type AgentDirectActorInjection,
  type StoredTradingProfile,
} from './agent-direct-actor-ensure.js';
import {
  wrapPublishToInbound,
  startAgentCommandConsumer,
  decisionReplyKey,
  agentCmdListKey,
  type AgentCommandConsumer,
  type AgentCommandConsumerRedis,
  type AgentCommandSenderRedis,
} from './agent-command-router.js';
import {
  buildAgentActorLifecycleOps,
  type AgentActorLifecycleOps,
  type CascadeBotRepo,
} from './agent-actor-lifecycle-ops.js';
import { runAgentOrphanSweep } from './agent-orphan-sweep.js';

const SKIP = !process.env['DATABASE_URL'] || !process.env['REDIS_URL'];

type AppConfig = ReturnType<typeof loadConfig>;

// ── Fixtures ────────────────────────────────────────────────────────────────

const OWNER_ID = 'owner-multireplica';
const AGENT_ID = 'agent-multireplica';
const VENUE_ACCOUNT_ID = 'va-multireplica';
const VENUE = 'hyperliquid';
const VENUE_TYPE = 'orderbook' as const;

/** The injection the S2 ensure + S3 sender consume — fixed paper coordinates. */
const INJECTION: AgentDirectActorInjection = {
  ownerId: OWNER_ID,
  actorId: AGENT_ID,
  ownerMode: 'paper',
  venue: VENUE,
  venueType: VENUE_TYPE,
  venueAccountId: VENUE_ACCOUNT_ID,
};

/** The `agent:{agentId}` lease id (bare) and its full Redis key (001 S1/S2). */
const AGENT_LEASE_ID = `agent:${AGENT_ID}`;
const AGENT_LEASE_KEY = `lease:instance:${AGENT_LEASE_ID}`;

/**
 * A stub paper-mode trading profile (mirrors the ensure unit tests). The real
 * `AgentTradingProfileRepository` is NOT needed: a paper agent needs no capital/
 * posture beyond the equity-peak anchor, and keeping the profile a stub keeps the
 * proof offline (no profile row to seed) while exercising the exact ensure path.
 */
const PAPER_PROFILE: StoredTradingProfile = {
  capital: '1000',
  riskPosture: null,
  riskOverrides: {},
  executionDefaults: { mode: 'paper' },
  scanMode: null,
  activeStrategy: null,
  revision: 1n,
};

/** A minimal, well-formed decision payload — enough to reach submitDecision. */
function decisionPayload(decisionId: string): Record<string, unknown> {
  return {
    decisionId,
    instrumentId: 'BTC-USDC',
    intent: 'go_long',
    targetSize: '0.001',
    confidence: 0.5,
    rationaleSummary: 's5-multi-replica-proof',
    _expectsReply: true,
  };
}

/** The composed per-runtime wiring (one "boundary container"). */
interface Replica {
  label: 'A' | 'B';
  trading: TradingRuntime;
  ensure: AgentDirectActorEnsure;
  ops: AgentActorLifecycleOps;
  /** The dedicated BLPOP connection the S3 consumer owns. */
  consumerConn: Redis;
  consumer: AgentCommandConsumer;
}

describe.skipIf(SKIP)('agent actor multi-replica owner routing + takeover (integration)', () => {
  let db: Database;
  /** The underlying postgres-js client for raw truncate SQL (same idiom as the
   *  restart round-trip + boundary verification suites — avoids a `postgres`
   *  import the boundary package does not directly depend on). */
  let sql: { unsafe: (query: string, params?: unknown[]) => Promise<unknown[]> };
  let runRepo: AgentActorRunRepository;
  let botRepo: BotRepository;
  let config: AppConfig;
  /** Every replica built in a test — torn down in afterEach (idempotent). */
  let replicas: Replica[];
  /** Every extra Redis connection opened in a test (quit in afterEach). */
  let redises: Redis[];
  /** apiKey env vars we set so loadConfig()'s superRefine passes — restored in
   *  afterAll (this suite shares the vitest process under --no-file-parallelism;
   *  env mutation must not leak). */
  let savedEnv: Record<string, string | undefined>;

  beforeAll(() => {
    // The committed config/default.yaml keeps several providers apiKey-gated, so
    // AppConfigSchema.superRefine rejects loadConfig() unless those keys are
    // present. This suite never calls `trading.start()`'s provider warmup (it
    // drives the agent ensure + drive target directly), so the keys are never
    // USED — supply dummy non-empty values purely to satisfy the presence gates
    // (same discipline as restart-round-trip.integration.test.ts).
    const DUMMY_KEY_VARS = ['BIRDEYE_API_KEY', 'COINMARKETCAP_API_KEY', 'JUPITER_API_KEY', 'ONEINCH_API_KEY'] as const;
    savedEnv = {};
    for (const name of DUMMY_KEY_VARS) {
      savedEnv[name] = process.env[name];
      if (!process.env[name]) process.env[name] = 'integration-test-dummy';
    }

    config = loadConfig();
    db = createDatabase(config.database.url);
    sql = (db as unknown as { $client: typeof sql }).$client;
    runRepo = new AgentActorRunRepository(db);
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
    replicas = [];
    redises = [];
    // Shared tables both replicas read/write. Also clear the agent lease key +
    // any stale command list / reply keys from a prior run so each test starts
    // from a clean Redis (the suite is the sole writer of these keys).
    await sql.unsafe(`TRUNCATE agent_actor_runs, bots, venue_accounts, boundary_invocations CASCADE`);
    await sql.unsafe(
      `INSERT INTO venue_accounts (id, owner_id, venue, label) VALUES ($1, $2, $3, $4)`,
      [VENUE_ACCOUNT_ID, OWNER_ID, VENUE, 'label-multireplica'],
    );
    const scrub = new Redis(config.redis.url, { maxRetriesPerRequest: null });
    await scrub.del(AGENT_LEASE_KEY);
    await scrub.quit();
  });

  afterEach(async () => {
    // Stop each replica's consumer loop (quits its dedicated BLPOP conn), then
    // shut the runtime (stops actors; also stops the agent-lease renew timers),
    // then quit every extra connection — no lease, actor, or socket leaks.
    for (const replica of replicas) {
      replica.consumer.stop();
      await replica.trading.shutdown().catch(() => {});
      await replica.consumerConn.quit().catch(() => {});
    }
    for (const redis of redises) {
      await redis.quit().catch(() => {});
    }
    // Release the agent lease directly so a flaky test cannot leak ownership into
    // the next (the runtime's shutdown does not release agent-namespaced ids —
    // 001 S1 forbids a whole-handle teardown on the shared lease).
    const cleaner = new Redis(config.redis.url, { maxRetriesPerRequest: null });
    await cleaner.del(AGENT_LEASE_KEY).catch(() => {});
    await cleaner.quit().catch(() => {});
  });

  /** Open a tracked Redis connection on the shared server. */
  function openRedis(): Redis {
    const redis = new Redis(config.redis.url, { maxRetriesPerRequest: null });
    redises.push(redis);
    return redis;
  }

  /**
   * Build one "boundary container": a real `createTradingRuntime` (its own
   * `workerId` + its own Redis connection), the S2 ensure, the S4 lifecycle ops,
   * and the S3 command consumer — the exact pieces bin.ts wires per process.
   */
  function buildReplica(label: 'A' | 'B'): Replica {
    const trading = buildBoundaryTradingRuntime({ config, redis: openRedis(), db });
    const ensure = buildAgentDirectActorEnsure(trading, async () => PAPER_PROFILE);
    const ops = buildAgentActorLifecycleOps({
      runtime: trading,
      ensure,
      runRepo,
      botRepo: botRepo as unknown as CascadeBotRepo,
      stopInstanceDirect: (botId) => trading.runtime.stopInstanceDirect(botId),
      logger: createLogger(`s5-${label}-lifecycle`),
    });
    // The S3 consumer needs its OWN connection — BLPOP blocks it.
    const consumerConn = new Redis(config.redis.url, { maxRetriesPerRequest: null });
    const consumer = startAgentCommandConsumer({
      redis: consumerConn as unknown as AgentCommandConsumerRedis,
      workerId: trading.workerId,
      lease: trading.agentLease,
      createDriveTarget: (injection) => trading.createDriveTarget(injection),
      logger: createLogger(`s5-${label}-consumer`),
      // Short block so each pop/re-block is prompt in the test.
      blockSeconds: 1,
    });
    const replica: Replica = { label, trading, ensure, ops, consumerConn, consumer };
    replicas.push(replica);
    return replica;
  }

  /**
   * Drive a DECISION_SUBMIT through a replica's S3 sender using the ensure result
   * resolved on THAT replica, then BLPOP the reply exactly as the copied
   * submit_decision tool does. Returns the parsed reply (or null on timeout).
   */
  async function submitThroughReplica(
    replica: Replica,
    caller: Redis,
    decisionId: string,
  ): Promise<Record<string, unknown> | null> {
    const ensureResult = await replica.ensure(INJECTION);
    // The sender's RPUSH (forward) + any not-ready reply write must hit the
    // SHARED Redis. The runtime does not expose its own connection, so give the
    // sender a tracked connection on the same server — functionally identical
    // (one Redis). The LOCAL arm (owner==='local') runs the runtime's own drive
    // target, which writes the reply via the runtime's own connection.
    const senderRedis = openRedis();
    const sender = wrapPublishToInbound({
      local: replica.trading.createDriveTarget(INJECTION),
      ensureResult,
      injection: INJECTION,
      redis: senderRedis as unknown as AgentCommandSenderRedis,
      logger: createLogger(`s5-${replica.label}-sender`),
    });
    await sender(AGENT_MESSAGE_TYPES.DECISION_SUBMIT, decisionPayload(decisionId));
    // BLPOP the reply (10s — generous; a local/forwarded execute replies fast).
    const popped = await caller.blpop(decisionReplyKey(decisionId), 10);
    if (!popped) return null;
    return JSON.parse(popped[1]) as Record<string, unknown>;
  }

  it('CASE 1: a decision submitted on B for an A-owned agent executes on A and B\'s caller gets the reply', async () => {
    const a = buildReplica('A');
    const b = buildReplica('B');

    // Record the durable run row (what start_agent_actor persists) so the sweep
    // in CASE 2 can take over; harmless here.
    await a.ops.recordRunning({
      ownerId: OWNER_ID,
      actorId: AGENT_ID,
      venueAccountId: VENUE_ACCOUNT_ID,
      venue: VENUE,
      venueType: VENUE_TYPE,
    });

    // ── Activate the agent on A: A acquires the lease + starts the actor ──
    const ensuredOnA = await a.ensure(INJECTION);
    expect(ensuredOnA.owner).toBe('local');
    expect(a.trading.actorRegistry.get(AGENT_ID)?.isRunning).toBe(true);

    // A holds the agent lease; its workerId is the owner.
    expect(await a.trading.agentLease.holder(AGENT_LEASE_ID)).toBe(a.trading.workerId);

    // ── On B the SAME ensure resolves REMOTE → B constructs nothing ──
    const ensuredOnB = await b.ensure(INJECTION);
    expect(ensuredOnB.owner).toBe('remote');
    if (ensuredOnB.owner === 'remote') {
      expect(ensuredOnB.workerId).toBe(a.trading.workerId);
    }
    expect(b.trading.actorRegistry.has(AGENT_ID)).toBe(false);

    // ── Submit a decision through B → forwarded to A's command list → A runs it ──
    const caller = openRedis();
    const decisionId = 'd-case1';
    const reply = await submitThroughReplica(b, caller, decisionId);

    // The reply was written (by A's drive target) and reached B's caller. We do
    // not assert acceptance — a paper agent with no live mark may reject for lack
    // of decision context; the proof is that it EXECUTED on A (A wrote the reply).
    expect(reply).not.toBeNull();
    expect(typeof reply?.['status']).toBe('string');

    // Single actor: the agent lives ONLY on A throughout.
    expect(a.trading.actorRegistry.get(AGENT_ID)?.isRunning).toBe(true);
    expect(b.trading.actorRegistry.has(AGENT_ID)).toBe(false);
    // A's command list drained (the consumer popped the forwarded envelope).
    const cmdLen = await caller.llen(agentCmdListKey(a.trading.workerId));
    expect(cmdLen).toBe(0);
  }, 60_000);

  it('CASE 1b: the sender serializes the forwarded envelope onto the owner\'s command list', async () => {
    // Locks the S3 sender contract against future drift (CodeReviewer MEDIUM):
    // CASE 1 proves A executed by observing the reply, but the reply-writer
    // attribution rests on "the remote branch writes nothing locally". Here we
    // inspect the RAW envelope the sender RPUSH-es, so a future change to the
    // remote branch cannot silently stop forwarding the correct payload/injection.
    //
    // This is a PURE sender-contract test: it drives `wrapPublishToInbound` with a
    // synthetic `{owner:'remote', workerId}` pointing at a worker id NO consumer
    // listens on (there is no replica for it), so the envelope stays on the list
    // for inspection — no live BLPOP can race-drain it (the flaky failure mode of
    // the earlier "stop A's consumer then inspect" approach). It needs no runtime,
    // actor, or lease — just real Redis.
    const ownerWorkerId = `worker-noconsumer-${Date.now().toString(36)}`;
    const senderRedis = openRedis();
    const sender = wrapPublishToInbound({
      // The local drive target must never be invoked on the remote branch; a
      // throwing stub proves it is not called for a forwarded decision.
      local: async () => {
        throw new Error('local drive target must not run for a remotely-owned decision');
      },
      ensureResult: { owner: 'remote', workerId: ownerWorkerId },
      injection: INJECTION,
      redis: senderRedis as unknown as AgentCommandSenderRedis,
      logger: createLogger('s5-sender-contract'),
    });
    const decisionId = 'd-case1b';
    await sender(AGENT_MESSAGE_TYPES.DECISION_SUBMIT, decisionPayload(decisionId));

    // Exactly one envelope landed on the owner's command list, carrying the
    // unchanged decision payload + the resolved injection (so the owner can
    // rebuild its drive target).
    const inspector = openRedis();
    const listKey = agentCmdListKey(ownerWorkerId);
    expect(await inspector.llen(listKey)).toBe(1);
    const raw = await inspector.lindex(listKey, 0);
    expect(raw).not.toBeNull();
    const envelope = JSON.parse(raw!) as {
      type: string;
      payload: Record<string, unknown>;
      injection: AgentDirectActorInjection;
    };
    expect(envelope.type).toBe(AGENT_MESSAGE_TYPES.DECISION_SUBMIT);
    expect(envelope.payload['decisionId']).toBe(decisionId);
    expect(envelope.payload['_expectsReply']).toBe(true);
    expect(envelope.injection).toEqual(INJECTION);
    // The sender did NOT write a reply itself (the owner is the sole reply writer).
    expect(await inspector.exists(decisionReplyKey(decisionId))).toBe(0);
    // Clean up the key we parked on the shared Redis (beforeEach only truncates
    // the DB + the agent lease, not arbitrary command lists).
    await inspector.del(listKey);
  }, 60_000);

  it('CASE 2: after A dies without releasing, B\'s sweep takes over and a new decision executes on B', async () => {
    const a = buildReplica('A');
    const b = buildReplica('B');

    await a.ops.recordRunning({
      ownerId: OWNER_ID,
      actorId: AGENT_ID,
      venueAccountId: VENUE_ACCOUNT_ID,
      venue: VENUE,
      venueType: VENUE_TYPE,
    });

    // A owns + runs the agent.
    expect((await a.ensure(INJECTION)).owner).toBe('local');
    expect(a.trading.actorRegistry.get(AGENT_ID)?.isRunning).toBe(true);
    expect(await a.trading.agentLease.holder(AGENT_LEASE_ID)).toBe(a.trading.workerId);

    // ── Simulate A dying WITHOUT a graceful release ──
    // 1. Stop A's renewal timers so it cannot re-extend the lease (what a dead
    //    process would do implicitly). For the TEST this is acceptable because A
    //    is "dying"; production code never calls agentLease.shutdown() mid-life.
    a.trading.agentLease.shutdown();
    // 2. Delete the lease key to simulate the 30s TTL expiring — deterministic,
    //    no real wait. A's in-memory actor lingers (A "died" without teardown),
    //    but the lease is now free for a surviving replica to claim.
    const killer = openRedis();
    await killer.del(AGENT_LEASE_KEY);
    expect(await b.trading.agentLease.holder(AGENT_LEASE_ID)).toBeNull();

    // ── B's orphan sweep tick takes over: it sees the still-running run row, its
    //    local actor is dead, so it re-ensures → acquires the free lease → starts
    //    the actor on B. Driven directly for determinism (never the timer). ──
    await runAgentOrphanSweep(
      {
        listRunningAgentRuns: () => runRepo.listRunning(),
        listRunningBotsOfStoppedAgents: () => botRepo.listRunningBotsOfStoppedAgents(),
        isActorAlive: (actorId) => b.ops.isActorAlive(actorId),
        reEnsureAgent: (run) => b.ops.ensureFromRun(run),
        stopBot: async (botId) => {
          await botRepo.markBotStopped(botId);
          await b.trading.runtime.stopInstanceDirect(botId);
        },
      },
      createLogger('s5-B-sweep'),
    );

    // B now owns the lease and runs the actor.
    expect(await b.trading.agentLease.holder(AGENT_LEASE_ID)).toBe(b.trading.workerId);
    expect(b.trading.actorRegistry.get(AGENT_ID)?.isRunning).toBe(true);

    // ── A new decision through B now resolves LOCAL and executes on B ──
    const ensuredOnBAfter = await b.ensure(INJECTION);
    expect(ensuredOnBAfter.owner).toBe('local');

    const caller = openRedis();
    const decisionId = 'd-case2';
    const reply = await submitThroughReplica(b, caller, decisionId);
    expect(reply).not.toBeNull();
    expect(typeof reply?.['status']).toBe('string');

    // The actor is now on B (takeover complete).
    expect(b.trading.actorRegistry.get(AGENT_ID)?.isRunning).toBe(true);
  }, 60_000);
});
