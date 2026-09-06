import { describe, expect, it } from 'vitest';
import {
  BotConfigSchema,
  PublicStreamConfigSchema,
  MarkingConfigSchema,
  StrategySchema,
  TechnicalConfigSchema,
  StrictTechnicalConfigSchema,
  RiskConfigSchema,
  BotRiskSchema,
  ExecutionDefaultsSchema,
} from './schema.js';

describe('BotConfigSchema', () => {
  const validBase = {
    strategy: { type: 'momentum', decisionMode: 'mechanical' },
    venue: 'hyperliquid',
    symbol: 'SOL/USDC',
  };

  it('accepts valid config with swapAssets', () => {
    const result = BotConfigSchema.safeParse({
      ...validBase,
      venue: 'jupiter',
      venueType: 'swap',
      execution: { mode: 'shadow' },
      swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC', baseDecimals: 9, quoteDecimals: 6 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.swapAssets).toEqual({ baseAsset: 'SOL', quoteAsset: 'USDC', baseDecimals: 9, quoteDecimals: 6 });
    }
  });

  it('swapAssets is optional — defaults to undefined', () => {
    const result = BotConfigSchema.safeParse(validBase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.swapAssets).toBeUndefined();
    }
  });

  it('rejects swapAssets with missing baseAsset', () => {
    const result = BotConfigSchema.safeParse({
      ...validBase,
      swapAssets: { quoteAsset: 'USDC' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects swapAssets with missing quoteAsset', () => {
    const result = BotConfigSchema.safeParse({
      ...validBase,
      swapAssets: { baseAsset: 'SOL' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts config without venue and venueType (stamped by broker)', () => {
    const result = BotConfigSchema.safeParse({
      strategy: { type: 'momentum', decisionMode: 'mechanical' },
      symbol: 'SOL/USDC',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.venue).toBeUndefined();
      expect(result.data.venueType).toBeUndefined();
    }
  });

  it('defaults shadowPollIntervalMs to 2000', () => {
    const result = BotConfigSchema.safeParse(validBase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.shadowPollIntervalMs).toBe(2000);
    }
  });

  it('rejects shadowPollIntervalMs below 100', () => {
    const result = BotConfigSchema.safeParse({
      ...validBase,
      shadowPollIntervalMs: 50,
    });
    expect(result.success).toBe(false);
  });

  it('rejects venueType swap without swapAssets', () => {
    const result = BotConfigSchema.safeParse({
      ...validBase,
      venue: 'jupiter',
      venueType: 'swap',
      execution: { mode: 'shadow' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toContain('swapAssets');
    }
  });

  it('rejects venueType swap with paper mode', () => {
    const result = BotConfigSchema.safeParse({
      ...validBase,
      venue: 'jupiter',
      venueType: 'swap',
      execution: { mode: 'paper' },
      swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC', baseDecimals: 9, quoteDecimals: 6 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path);
      expect(paths).toContainEqual(['execution', 'mode']);
    }
  });
});

describe('PublicStreamConfigSchema', () => {
  it('applies defaults for all fields', () => {
    const result = PublicStreamConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reconnectBaseMs).toBe(1_000);
      expect(result.data.reconnectMaxMs).toBe(30_000);
      expect(result.data.maxReconnectAttempts).toBe(20);
      expect(result.data.depthLevels).toBe(5);
    }
  });

  it('rejects reconnectBaseMs below 100', () => {
    const result = PublicStreamConfigSchema.safeParse({ reconnectBaseMs: 50 });
    expect(result.success).toBe(false);
  });

  it('rejects depthLevels above 50', () => {
    const result = PublicStreamConfigSchema.safeParse({ depthLevels: 51 });
    expect(result.success).toBe(false);
  });
});

describe('MarkingConfigSchema', () => {
  it('applies defaults — stalenessThresholdMs = 300000', () => {
    const result = MarkingConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stalenessThresholdMs).toBe(300_000);
      expect(result.data.oracleBaseUrl).toBeUndefined();
    }
  });

  it('rejects stalenessThresholdMs below 10000', () => {
    const result = MarkingConfigSchema.safeParse({ stalenessThresholdMs: 5000 });
    expect(result.success).toBe(false);
  });

  it('rejects invalid oracleBaseUrl', () => {
    const result = MarkingConfigSchema.safeParse({ oracleBaseUrl: 'not-a-url' });
    expect(result.success).toBe(false);
  });

  it('accepts valid oracleBaseUrl', () => {
    const result = MarkingConfigSchema.safeParse({
      oracleBaseUrl: 'https://api.coingecko.com/v3',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.oracleBaseUrl).toBe('https://api.coingecko.com/v3');
    }
  });
});

describe('StrategySchema', () => {
  it('accepts momentum strategy with mechanical decisionMode', () => {
    const result = StrategySchema.safeParse({ type: 'momentum', decisionMode: 'mechanical' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('momentum');
      expect(result.data.decisionMode).toBe('mechanical');
    }
  });

  it('accepts momentum strategy with llm decisionMode', () => {
    const result = StrategySchema.safeParse({ type: 'momentum', decisionMode: 'llm' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('momentum');
      expect(result.data.decisionMode).toBe('llm');
    }
  });

  it('accepts dca strategy without decisionMode (timer-driven)', () => {
    const result = StrategySchema.safeParse({ type: 'dca' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('dca');
      expect(result.data.decisionMode).toBeUndefined();
    }
  });

  it('accepts all trading styles with decisionMode', () => {
    const styles = ['range', 'contrarian', 'swing', 'scalper'] as const;
    for (const style of styles) {
      const result = StrategySchema.safeParse({ type: style, decisionMode: 'mechanical' });
      expect(result.success).toBe(true);
    }
  });

  it('rejects non-DCA strategy without decisionMode', () => {
    const result = StrategySchema.safeParse({ type: 'momentum' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('decisionMode');
    }
  });

  it('rejects invalid trading style', () => {
    const result = StrategySchema.safeParse({ type: 'unknown', decisionMode: 'mechanical' });
    expect(result.success).toBe(false);
  });

  it('rejects missing type field', () => {
    const result = StrategySchema.safeParse({ decisionMode: 'mechanical' });
    expect(result.success).toBe(false);
  });

  it('accepts strategy with params', () => {
    const result = StrategySchema.safeParse({
      type: 'momentum',
      decisionMode: 'mechanical',
      params: { lookbackPeriod: 10, threshold: 0.05 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.params?.lookbackPeriod).toBe(10);
    }
  });

  it('accepts strategy stringified as the old "type" was a string — new schema requires object', () => {
    // This tests the error message when agent sends strategy as a string
    const result = StrategySchema.safeParse('momentum');
    expect(result.success).toBe(false);
  });
});

// NOTE: `LlmParamsSchema` describe blocks were removed here — LlmParamsSchema is
// agent-side and deleted from Traderton (mechanical-only, decisions 7–9). Removing
// tests for a deliberately-deleted platform schema, not a parity regression.

describe('StrategySchema (BotConfigSchema.strategy)', () => {
  it('accepts momentum with mechanical decisionMode and accepts type-specific params in params', () => {
    const result = StrategySchema.safeParse({ type: 'momentum', decisionMode: 'mechanical', params: { lookbackPeriod: 10 } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('momentum');
      expect(result.data.decisionMode).toBe('mechanical');
    }
  });

  it('allows params to carry any trading-style tuning data', () => {
    const result = StrategySchema.safeParse({
      type: 'momentum',
      decisionMode: 'mechanical',
      params: { lookbackPeriod: 10, threshold: 0.05, positionSize: '2.5' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.params).toEqual({
        lookbackPeriod: 10,
        threshold: 0.05,
        positionSize: '2.5',
      });
    }
  });

  it('rejects invalid type string', () => {
    const result = StrategySchema.safeParse({ type: 'llm', decisionMode: 'mechanical' });
    expect(result.success).toBe(false);
  });

  it('rejects momentum without decisionMode (non-DCA)', () => {
    const result = StrategySchema.safeParse({ type: 'momentum' });
    expect(result.success).toBe(false);
  });

  it('accepts dca without decisionMode', () => {
    const result = StrategySchema.safeParse({ type: 'dca' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('dca');
      expect(result.data.decisionMode).toBeUndefined();
    }
  });

  it('passes params through as-is — params are intentionally unvalidated (flexible tuning)', () => {
    // params is z.record(z.unknown()) by design — each trading style has its
    // own tuning surface and no single param schema fits all. Validation of
    // type-specific params is done at the strategy execution layer, not at config parse time.
    const result = StrategySchema.safeParse({
      type: 'momentum',
      decisionMode: 'mechanical',
      params: { lookbackPeriod: -1, threshold: 'invalid', extraField: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.params).toEqual({
        lookbackPeriod: -1,
        threshold: 'invalid',
        extraField: true,
      });
    }
  });
});

describe('TechnicalConfigSchema', () => {
  it('defaults autonomousExit to false', () => {
    const result = TechnicalConfigSchema.safeParse({
      filters: { venue: 'hyperliquid', venueType: 'orderbook' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.autonomousExit).toBe(false);
    }
  });

  it('accepts explicit autonomousExit true', () => {
    const result = TechnicalConfigSchema.safeParse({
      filters: { venue: 'hyperliquid', venueType: 'orderbook' },
      autonomousExit: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.autonomousExit).toBe(true);
    }
  });
});

describe('TechnicalConfigSchema — defaults', () => {
  const minimal = { filters: { venue: 'hyperliquid', venueType: 'orderbook' } };

  it('defaults scanBatchSize to 5', () => {
    const result = TechnicalConfigSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scanBatchSize).toBe(5);
    }
  });

  it('defaults scanIntervalMs to 60_000', () => {
    const result = TechnicalConfigSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scanIntervalMs).toBe(60_000);
    }
  });

  it('defaults candles to { interval: "15m", limit: 100 }', () => {
    const result = TechnicalConfigSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.candles).toEqual({ interval: '15m', limit: 100 });
    }
  });

  it('defaults signalBias to "trend-following"', () => {
    const result = TechnicalConfigSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.signalBias).toBe('trend-following');
    }
  });

  it('defaults indicators to {}', () => {
    const result = TechnicalConfigSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.indicators).toBeDefined();
      expect(typeof result.data.indicators).toBe('object');
      expect(result.data.indicators).not.toBeNull();
    }
  });
});

describe('StrictTechnicalConfigSchema', () => {
  const minimalValid = {
    filters: { venue: 'hyperliquid', venueType: 'orderbook' as const },
    indicators: {},
    candles: {},
    signalBias: 'trend-following' as const,
    scanIntervalMs: 60_000,
    scanBatchSize: 5,
    autonomousExit: false,
  };

  it('accepts a fully-specified scanner-gated config', () => {
    const result = StrictTechnicalConfigSchema.safeParse(minimalValid);
    expect(result.success).toBe(true);
  });

  it('rejects config missing scanBatchSize', () => {
    const missing = { ...minimalValid };
    delete (missing as Record<string, unknown>).scanBatchSize;
    const result = StrictTechnicalConfigSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it('rejects config missing scanIntervalMs', () => {
    const missing = { ...minimalValid };
    delete (missing as Record<string, unknown>).scanIntervalMs;
    const result = StrictTechnicalConfigSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it('rejects config missing signalBias', () => {
    const missing = { ...minimalValid };
    delete (missing as Record<string, unknown>).signalBias;
    const result = StrictTechnicalConfigSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it('rejects config missing autonomousExit', () => {
    const missing = { ...minimalValid };
    delete (missing as Record<string, unknown>).autonomousExit;
    const result = StrictTechnicalConfigSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it('rejects config missing indicators object', () => {
    const missing = { ...minimalValid };
    delete (missing as Record<string, unknown>).indicators;
    const result = StrictTechnicalConfigSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it('rejects config missing candles object', () => {
    const missing = { ...minimalValid };
    delete (missing as Record<string, unknown>).candles;
    const result = StrictTechnicalConfigSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it('allows inner candles fields (interval, limit) to be absent — they default within the object', () => {
    const result = StrictTechnicalConfigSchema.safeParse({
      ...minimalValid,
      candles: {}, // no interval, no limit provided
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.candles.interval).toBe('15m');
      expect(result.data.candles.limit).toBe(100);
    }
  });

  it('accepts a realistic scanner-gated config with all fields populated', () => {
    const result = StrictTechnicalConfigSchema.safeParse({
      filters: {
        venue: 'hyperliquid',
        venueType: 'orderbook',
        minVolume24hUsd: 1_000_000,
        symbols: ['BTC', 'ETH'],
        excludeSymbols: ['DOGE'],
      },
      indicators: {
        rsi: { period: 14, overbought: 70, oversold: 30, enabled: true },
        macd: { fast: 12, slow: 26, signal: 9, enabled: true },
        volume: { enabled: true, threshold: 1.5 },
        choch: { enabled: true, lookback: 20 },
        supportResistance: { enabled: true, lookback: 50 },
        vwap: { enabled: false },
        priceAction: { enabled: true },
        confidence: {},
      },
      candles: { interval: '1h', limit: 100 },
      signalBias: 'trend-following',
      scanIntervalMs: 120_000,
      scanBatchSize: 10,
      autonomousExit: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects scanBatchSize of 0 (below min of 1)', () => {
    const result = StrictTechnicalConfigSchema.safeParse({
      ...minimalValid,
      scanBatchSize: 0,
    });
    expect(result.success).toBe(false);
  });

  it('rejects scanIntervalMs below 10_000', () => {
    const result = StrictTechnicalConfigSchema.safeParse({
      ...minimalValid,
      scanIntervalMs: 5_000,
    });
    expect(result.success).toBe(false);
  });
});

describe('RiskConfigSchema legacy field normalization', () => {
  it('normalizes stopLossMaxUnrealizedLossPct → stopLossPct when only legacy field is present', () => {
    const result = RiskConfigSchema.safeParse({ stopLossMaxUnrealizedLossPct: 10 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stopLossPct).toBe(10);
      expect((result.data as Record<string, unknown>)['stopLossMaxUnrealizedLossPct']).toBeUndefined();
    }
  });

  it('passes stopLossPct through unchanged (preprocess is a no-op)', () => {
    const result = RiskConfigSchema.safeParse({ stopLossPct: 5 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stopLossPct).toBe(5);
    }
  });

  it('stopLossPct wins when both fields are present', () => {
    const result = RiskConfigSchema.safeParse({ stopLossPct: 5, stopLossMaxUnrealizedLossPct: 10 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stopLossPct).toBe(5);
    }
  });
});

// ── BotRiskSchema ────────────────────────────────────────────────────────────

describe('BotRiskSchema', () => {
  it('accepts valid canonical risk fields', () => {
    const result = BotRiskSchema.parse({
      maxPositionSizePct: 50,
      maxOpenPositions: 3,
      stopLossPct: 5,
      dailyMaxLossPct: 10,
      maxDrawdownPct: 15,
      maxOrderNotional: 1000,
    });
    expect(result.maxOrderNotional).toBe(1000); // number, not string
    expect(result.maxPositionSizePct).toBe(50);
  });

  it('rejects unknown legacy keys', () => {
    expect(() => BotRiskSchema.parse({
      stopLossMaxUnrealizedLossPct: 5,
    })).toThrow(); // strict mode
  });

  it('rejects deprecated token safety fields', () => {
    expect(() => BotRiskSchema.parse({
      minSwapTokenLiquidityUsd: 10000,
    })).toThrow();
    expect(() => BotRiskSchema.parse({
      allowSwapTokenSafetyOverride: true,
    })).toThrow();
  });

  it('rejects maxOrderNotional as string', () => {
    expect(() => BotRiskSchema.parse({
      maxOrderNotional: '1000',
    })).toThrow();
  });

  it('rejects absolute maxPositionSize and maxDrawdown', () => {
    expect(() => BotRiskSchema.parse({
      maxPositionSize: '100',
    })).toThrow();
    expect(() => BotRiskSchema.parse({
      maxDrawdown: '1000',
    })).toThrow();
  });

  it('allows all fields to be omitted (optional)', () => {
    const result = BotRiskSchema.parse({});
    expect(result).toEqual({});
  });

  it('accepts all 9 risk posture fields', () => {
    const result = BotRiskSchema.parse({
      maxPositionSizePct: 50,
      maxOpenPositions: 3,
      stopLossPct: 5,
      stopLossCooldownMs: 60000,
      dailyMaxLossPct: 10,
      maxDrawdownPct: 15,
      maxNewPositionsPerDay: 5,
      avoidParabolicMovePct: 30,
      maxOrderNotional: 1000,
    });
    expect(result.maxNewPositionsPerDay).toBe(5);
    expect(result.avoidParabolicMovePct).toBe(30);
  });
});

// ── Regression: sliageBps must accept null ──────────────────────────────

describe('ExecutionDefaultsSchema — sliageBps null tolerance', () => {
  it('accepts sliageBps: null (defense-in-depth)', () => {
    const result = ExecutionDefaultsSchema.parse({
      mode: 'paper',
      slippageBps: null,
    });
    expect(result.slippageBps).toBeNull();
  });

  it('accepts sliageBps: undefined (omitted key)', () => {
    const result = ExecutionDefaultsSchema.parse({ mode: 'shadow' });
    expect(result.slippageBps).toBeUndefined();
  });

  it('accepts a numeric slippageBps', () => {
    const result = ExecutionDefaultsSchema.parse({ mode: 'shadow', slippageBps: 50 });
    expect(result.slippageBps).toBe(50);
  });

  it('rejects a negative slippageBps', () => {
    expect(() => ExecutionDefaultsSchema.parse({ mode: 'paper', slippageBps: -1 })).toThrow();
  });
});
