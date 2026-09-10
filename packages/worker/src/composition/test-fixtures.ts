/**
 * Shared paper `AppConfig` + paper bot config fixtures for the composition
 * tests (Phase 9b item B smoke test + the L1 integration harness).
 *
 * TEST/DEV SCAFFOLDING ONLY — authored, not copied. Relocated from
 * `create-trading-runtime.test.ts` (026 §3) so the smoke test and the L1 harness
 * share one copy; the shapes are byte-identical to the originals so the smoke
 * test's behaviour is unchanged. `marketData` is omitted so no provider registry
 * / network is constructed; execution mode is `paper` (no venue network).
 */
import type { AppConfig } from '@traderton/domain';

/** Minimal paper AppConfig — marketData omitted so no provider registry / network. */
export function paperConfig(): AppConfig {
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
export function paperBotConfig() {
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
