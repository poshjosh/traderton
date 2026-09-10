/**
 * AUTHORED smoke test (Phase 9b item B) — NOT a copied parity oracle.
 *
 * The composition root is authored WIRING, so there is no herobids test to copy.
 * This test asserts the wiring holds together deterministically: no real Redis,
 * DB, or network. It stubs the process-edge I/O (BullMQ worker/queue, the Redis
 * client, and the drizzle query builder) but does NOT stub the factory's own
 * wiring — createTradingRuntime constructs the real singletons + the real
 * per-bot ActorFactory, which rehydrates a real TradingActor.
 *
 * Coverage:
 *  1. createTradingRuntime returns a TradingRuntime (start/shutdown/runtime).
 *  2. start() then shutdown() run clean with an empty running-bot loader.
 *  3. a paper bot config rehydrates into a TradingActor via the ActorFactory.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { paperConfig, paperBotConfig } from './test-fixtures.js';

// ── Edge I/O stubs (no real network) ─────────────────────────────────────────
vi.mock('bullmq', () => {
  class Queue {
    async close(): Promise<void> {}
  }
  class Worker {
    on(): void {}
    async close(): Promise<void> {}
  }
  return { Queue, Worker };
});

// Stub createDatabase so no Postgres connection is opened. The real repo classes
// are kept (imported via importOriginal) — they only query on method calls, and
// this test never drives an actor tick. The query-builder chain resolves to [].
vi.mock('@traderton/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@traderton/db')>();
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => [] as unknown[],
    then: (resolve: (v: unknown[]) => void) => resolve([]),
  };
  const fakeDb = { select: () => chain } as unknown as ReturnType<typeof actual.createDatabase>;
  return { ...actual, createDatabase: () => fakeDb };
});

import { createTradingRuntime } from './create-trading-runtime.js';
import { TradingActor } from '../trading-actor.js';
import type { InstanceActor } from '../runtime.js';

/** Fake ioredis client — only the lease's set/quit are ever touched, and only
 *  when an instance is claimed (this test claims none via the runtime). */
function fakeRedis() {
  return {
    set: async () => 'OK',
    quit: async () => 'OK',
  } as never;
}

/** Reach the internal ActorFactory the WorkerRuntime holds, to prove a paper bot
 *  config rehydrates into a TradingActor without driving a live tick. */
function actorFactoryOf(runtime: unknown) {
  return (runtime as { actorFactory: (id: string, cfg: Record<string, unknown>) => Promise<InstanceActor> }).actorFactory;
}

describe('createTradingRuntime (AUTHORED smoke test — Phase 9b item B)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a TradingRuntime with start/shutdown/runtime', () => {
    const trading = createTradingRuntime({
      config: paperConfig(),
      redis: fakeRedis(),
      instanceLoader: async () => [],
    });

    expect(typeof trading.start).toBe('function');
    expect(typeof trading.shutdown).toBe('function');
    expect(trading.runtime).toBeDefined();
  });

  it('start() then shutdown() run clean with an empty running-bot loader', async () => {
    const trading = createTradingRuntime({
      config: paperConfig(),
      redis: fakeRedis(),
      instanceLoader: async () => [],
    });

    await expect(trading.start()).resolves.toBeUndefined();
    await expect(trading.shutdown()).resolves.toBeUndefined();
  });

  it('rehydrates a paper bot config into a TradingActor via the ActorFactory', async () => {
    const trading = createTradingRuntime({
      config: paperConfig(),
      redis: fakeRedis(),
      instanceLoader: async () => [{ id: 'bot-1', config: paperBotConfig() }],
    });

    const actor = await actorFactoryOf(trading.runtime)('bot-1', paperBotConfig());

    expect(actor).toBeInstanceOf(TradingActor);
    expect(actor.botId).toBe('bot-1');

    await trading.shutdown();
  });

  it('rejects a bot config with no injected venueAccountId', async () => {
    const trading = createTradingRuntime({
      config: paperConfig(),
      redis: fakeRedis(),
      instanceLoader: async () => [],
    });

    const { venueAccountId: _omit, ...noVenueAccount } = paperBotConfig();
    await expect(actorFactoryOf(trading.runtime)('bot-2', noVenueAccount)).rejects.toThrow(/venueAccountId/);

    await trading.shutdown();
  });
});
