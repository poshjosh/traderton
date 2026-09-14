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
import type { AppConfig } from '@traderton/domain';

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

// Stub createProviderRegistry ONLY — the rest of @traderton/market-data (incl.
// resolveTokenSafetyPolicyConfig + lookupCanonical, which the composition module
// imports at top level) is kept via importOriginal. The real createProviderRegistry
// is async and validates provider keys / opens rate-limit buckets against the
// operator's marketData config; stubbing it lets start() build a non-network
// `sharedMarketDataRegistry` so the swapTokenSafety wiring seam can be exercised.
// The fake exposes only the surface the ActorFactory reads: .configs.binance /
// .configs.geckoterminal (fed to VenueCandleFetcher's constructor — stored, not
// called here) and .dexscreener.search / .discovery.discover (only reached if the
// safety adapter's resolveTokenData closure runs, which this test does not drive).
vi.mock('@traderton/market-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@traderton/market-data')>();
  const fakeRegistry = {
    configs: { binance: {}, geckoterminal: {} },
    dexscreener: { search: async () => null },
    discovery: { discover: async () => null },
  };
  return { ...actual, createProviderRegistry: async () => fakeRegistry };
});

// Spy on the swap token-safety adapter factory — this IS the seam under test.
// A real adapter isn't needed; the assertion is purely "was it constructed?",
// which distinguishes swap+marketData (built → swapTokenSafety defined) from
// orderbook/no-marketData (not built → swapTokenSafety undefined). The fake
// return value satisfies the SwapTokenSafetyPort surface TradingActorDeps expects.
vi.mock('../token-safety-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../token-safety-adapter.js')>();
  const fakeAdapter = { checkSwapTarget: async () => ({ ok: true }) };
  return { ...actual, createSwapTokenSafetyAdapter: vi.fn(() => fakeAdapter) };
});

import { createTradingRuntime } from './create-trading-runtime.js';
import { TradingActor } from '../trading-actor.js';
import { createSwapTokenSafetyAdapter } from '../token-safety-adapter.js';
import { VenueAdapterFactory } from '../venue-adapter-factory.js';
import type { InstanceActor } from '../runtime.js';

/** Fake ioredis client — only the lease's set/quit are ever touched, and only
 *  when an instance is claimed (this test claims none via the runtime). */
function fakeRedis() {
  return {
    set: async () => 'OK',
    quit: async () => 'OK',
  } as never;
}

/** Minimal paper AppConfig — marketData omitted so no provider registry / network. */
function paperConfig(): AppConfig {
  return {
    app: { port: 3000, logLevel: 'info' },
    database: { url: 'postgres://stub/stub', poolMin: 2, poolMax: 10 },
    redis: { url: 'redis://localhost:6379' },
    venues: {},
    execution: {
      defaultSlippageBps: 50,
      orderTimeoutMs: 30_000,
      maxRetries: 3,
      shadowPollIntervalMs: 2_000,
      shadowQuoteSlippageBps: 50,
    },
    simulation: { takerFeePct: 0.001, makerFeePct: 0.0005, paperSlippageBps: 5 },
    risk: { globalMaxDrawdownPct: 20, maxOpenPositions: 10, maxPositionSizePct: 25 },
    agentRiskDefaults: {
      maxOpenPositions: 5,
      maxPositionSizePct: 10,
      stopLossPct: 5,
      stopLossCooldownMs: 0,
      maxDrawdownPct: 20,
      dailyMaxLossPct: 10,
      maxOrderNotionalMultiplier: 1,
      botConfigInvalidHaltThreshold: 1,
      botExecutionErrorHaltThreshold: 5,
      botLlmProviderErrorHaltThreshold: 1,
      maxBots: 10,
    },
    reconciliation: {
      intervalMs: 30_000,
      driftAlertOnly: true,
      positionDriftThreshold: '0',
      balanceDriftThreshold: '0',
      autoCorrect: false,
      swapDriftThresholdPct: 1.0,
    },
    streams: {
      private: { reconnectBaseMs: 1_000, reconnectMaxMs: 30_000, maxReconnectAttempts: 10 },
      public: { reconnectBaseMs: 1_000, reconnectMaxMs: 30_000, maxReconnectAttempts: 20, depthLevels: 5 },
    },
    marking: {
      stalenessThresholdMs: 300_000,
      oracleTimeoutMs: 10_000,
      oracleVsCurrency: 'usd',
    },
    backtesting: { warmupLookbackBars: 200, maxDataGapMs: 60_000, persistJournal: true, concurrency: 2 },
    marketDataRecording: { enabled: false, captureTrades: true, captureTopOfBook: true, captureCandles: true },
    liveRollout: {
      enabled: false,
      allowedVenues: ['hyperliquid'],
      requireDbCredentials: true,
      maxInitialOrderNotionalUsd: '50',
      maxConsecutiveVenueErrors: 3,
      slippageAlertBps: 50,
      limitOrderTimeoutMs: 120_000,
      marketOrderTimeoutMs: 30_000,
      timeoutCheckIntervalMs: 10_000,
      crashPolicy: 'alert_manual_intervention',
    },
  } as AppConfig;
}

/** A paper orderbook bot config as the consumer's instanceLoader would supply it,
 *  with the INJECTED venueAccountId + soft ownerId (decisions 11–13). */
function paperBotConfig() {
  return {
    strategy: { type: 'dca' as const },
    symbol: 'BTC/USD:USD',
    venue: 'hyperliquid',
    venueType: 'orderbook' as const,
    execution: { mode: 'paper' as const },
    venueAccountId: 'va-test-1',
    ownerId: 'owner-test-1',
  };
}

/** Reach the internal ActorFactory the WorkerRuntime holds, to prove a paper bot
 *  config rehydrates into a TradingActor without driving a live tick. */
function actorFactoryOf(runtime: unknown) {
  return (runtime as { actorFactory: (id: string, cfg: Record<string, unknown>) => Promise<InstanceActor> }).actorFactory;
}

/** A paper config VARIANT that INCLUDES marketData, so start() builds the
 *  once-per-process `sharedMarketDataRegistry` (via the stubbed
 *  createProviderRegistry) — the precondition for the swapTokenSafety wiring. The
 *  minimal truthy marketData object is all the outer guard
 *  (`config.marketData && sharedMarketDataRegistry`) reads; the safety adapter
 *  factory is spied, so its config shape is never inspected. */
function configWithMarketData(): AppConfig {
  return { ...paperConfig(), marketData: {} } as AppConfig;
}

/** A SWAP bot config (jupiter, shadow mode — swap venues cannot run paper per the
 *  BotConfigSchema refine). swapAssets is required for swap venues. The swap
 *  adapter build is stubbed at the VenueAdapterFactory level so no DB/wallet
 *  resolution runs — this test isolates the swapTokenSafety seam, not adapters. */
function swapBotConfig() {
  return {
    strategy: { type: 'dca' as const },
    symbol: 'SOL/USDC',
    venue: 'jupiter',
    venueType: 'swap' as const,
    execution: { mode: 'shadow' as const },
    swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC', baseDecimals: 9, quoteDecimals: 6 },
    venueAccountId: 'va-swap-1',
    ownerId: 'owner-test-1',
  };
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

/**
 * Seam test for the per-bot `swapTokenSafety` wiring (CodeReviewer MEDIUM-1, C1).
 *
 * The ActorFactory builds
 *   swapTokenSafety = config.marketData && sharedMarketDataRegistry
 *     ? createSwapTokenSafetyAdapter({...}) : undefined
 * and threads it into TradingActorDeps. That dep is not inspectable off the
 * returned TradingActor, so we assert the seam at its construction point: spy on
 * `createSwapTokenSafetyAdapter` and assert it IS invoked for a swap bot when the
 * market-data registry exists, and is NOT invoked for an orderbook bot with no
 * marketData. This is a SAFETY control, so the test must genuinely distinguish
 * the two cases — not merely "doesn't throw".
 *
 * The swap adapter build is stubbed at the VenueAdapterFactory level (Approach A):
 * buildSwapAdapter would otherwise read venueAccounts from the DB to resolve a
 * wallet address (and throw when the stub returns []), which is unrelated to the
 * seam under test. createProviderRegistry is stubbed so start() can populate
 * sharedMarketDataRegistry without a real registry / network.
 */
describe('swapTokenSafety wiring seam (CodeReviewer MEDIUM-1, C1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Isolate the swap-adapter build: return a fake SwapAdapterResult so the
    // swap ActorFactory path reaches the swapTokenSafety construction without
    // touching the DB / wallet resolution.
    vi.spyOn(VenueAdapterFactory.prototype, 'buildSwapAdapter').mockResolvedValue({
      swapVenue: {} as never,
      walletAddress: 'FakeSolWallet1111111111111111111111111111111',
      signerPresent: false,
    });
  });

  it('BUILDS swapTokenSafety for a swap bot when marketData is configured', async () => {
    const trading = createTradingRuntime({
      config: configWithMarketData(),
      redis: fakeRedis(),
      instanceLoader: async () => [],
    });

    // start() builds sharedMarketDataRegistry (stubbed) — the seam precondition.
    await trading.start();

    const actor = await actorFactoryOf(trading.runtime)('swap-bot-1', swapBotConfig());

    // The adapter WAS constructed → TradingActorDeps.swapTokenSafety is defined.
    expect(actor).toBeInstanceOf(TradingActor);
    expect(createSwapTokenSafetyAdapter).toHaveBeenCalledTimes(1);

    await trading.shutdown();
  });

  it('does NOT build swapTokenSafety for an orderbook bot with no marketData', async () => {
    const trading = createTradingRuntime({
      config: paperConfig(), // no marketData → sharedMarketDataRegistry stays undefined
      redis: fakeRedis(),
      instanceLoader: async () => [],
    });

    await trading.start();

    const actor = await actorFactoryOf(trading.runtime)('bot-ob-1', paperBotConfig());

    // The outer guard (config.marketData && sharedMarketDataRegistry) is false →
    // the adapter is never constructed → swapTokenSafety is undefined.
    expect(actor).toBeInstanceOf(TradingActor);
    expect(createSwapTokenSafetyAdapter).not.toHaveBeenCalled();

    await trading.shutdown();
  });
});
