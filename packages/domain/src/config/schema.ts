import { z } from 'zod';
import {
  getStrategyParameters,
  initStrategyRegistry,
  validateStrategyParams,
} from './strategy-parameters.js';

// Supported venues for live rollout
export const SUPPORTED_LIVE_VENUES = ['hyperliquid', 'bybit', 'jupiter', '1inch'] as const;
export type SupportedLiveVenue = typeof SUPPORTED_LIVE_VENUES[number];

export const SWAP_VENUES = ['jupiter', '1inch'] as const;
export const ORDERBOOK_VENUES = ['hyperliquid', 'bybit'] as const;
export type SwapVenue = typeof SWAP_VENUES[number];
export type OrderbookVenue = typeof ORDERBOOK_VENUES[number];

export const SUPPORTED_TOKEN_SAFETY_NETWORKS = [
  'solana',
  'ethereum',
  'optimism',
  'polygon',
  'base',
  'arbitrum',
  'avalanche',
] as const;
export type SupportedTokenSafetyNetwork = typeof SUPPORTED_TOKEN_SAFETY_NETWORKS[number];
export const TokenSafetyNetworkSchema = z.enum(SUPPORTED_TOKEN_SAFETY_NETWORKS);

const ONE_INCH_TOKEN_SAFETY_NETWORK_BY_CHAIN_ID: Record<number, SupportedTokenSafetyNetwork> = {
  1: 'ethereum',
  10: 'optimism',
  137: 'polygon',
  8453: 'base',
  42161: 'arbitrum',
};

export function inferOneInchTokenSafetyNetwork(chainId: number | undefined): SupportedTokenSafetyNetwork | undefined {
  if (chainId == null) {
    return undefined;
  }

  return ONE_INCH_TOKEN_SAFETY_NETWORK_BY_CHAIN_ID[chainId];
}

// --- Operator Config (loaded from YAML + env at startup) ---

export const VenueConfigSchema = z.object({
  baseUrl: z.string().url(),
  wsUrl: z.string().url().optional(),
  wsPublicUrl: z.string().url().optional(),
  wsTestnetPublicUrl: z.string().url().optional(),
  wsPrivateUrl: z.string().url().optional(),
  wsTestnetPrivateUrl: z.string().url().optional(),
  testnetBaseUrl: z.string().url().optional(),
  testnetWsUrl: z.string().url().optional(),
  /** When true, the adapter uses testnet/sandbox endpoints. Defaults to false (mainnet). */
  testnet: z.boolean().optional(),
  rpcUrl: z.string().url().optional(),
  chainId: z.number().int().positive().optional(),
  tokenSafetyNetwork: TokenSafetyNetworkSchema.optional(),
  rateLimitPerSec: z.number().min(1).default(10),
  timeoutMs: z.number().min(1000).default(30_000),
  confirmationTimeoutMs: z.number().min(1000).default(60_000),
  routerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Must be a valid EVM address (0x + 40 hex chars)').optional(),
  /** Operator-owned developer-platform key. Never stored in user credentials. */
  apiKey: z.string().min(1).optional(),
  /** Enables platform-managed direct wallet creation for this venue. */
  walletGeneration: z.object({
    enabled: z.boolean().default(false),
  }).default({}),
});

export const ReconciliationConfigSchema = z.object({
  intervalMs: z.number().min(5000).default(30_000),
  driftAlertOnly: z.boolean().default(true),
  /** Position size drift threshold (absolute). Diffs within this are 'acceptable'. Default: 0 (exact match required) */
  positionDriftThreshold: z.string().default('0'),
  /** Balance drift threshold (absolute). Diffs within this are 'acceptable'. Default: 0 */
  balanceDriftThreshold: z.string().default('0'),
  /** If true, attempt to auto-correct acceptable drift by syncing local state to venue. Default: false */
  autoCorrect: z.boolean().default(false),
  /** Swap venue: alert if balance differs from expected by more than this %. Default: 1.0 */
  swapDriftThresholdPct: z.number().min(0).default(1.0),
});

export const PublicStreamConfigSchema = z.object({
  reconnectBaseMs: z.number().min(100).default(1_000),
  reconnectMaxMs: z.number().min(1000).default(30_000),
  maxReconnectAttempts: z.number().min(1).default(20),
  depthLevels: z.number().min(1).max(50).default(5),
});

export const MarkingConfigSchema = z.object({
  stalenessThresholdMs: z.number().min(10_000).default(300_000),
  oracleBaseUrl: z.string().url().optional(),
  oracleTimeoutMs: z.number().min(1000).default(10_000),
  oracleVsCurrency: z.string().min(1).default('usd'),
});

export const BacktestingConfigSchema = z.object({
  warmupLookbackBars: z.number().int().min(1).default(200),
  maxDataGapMs: z.number().min(1).default(60_000),
  persistJournal: z.boolean().default(true),
  concurrency: z.number().int().min(1).default(2),
});
export const MarketDataRecordingConfigSchema = z.object({
  enabled: z.boolean().default(false),
  captureTrades: z.boolean().default(true),
  captureTopOfBook: z.boolean().default(true),
  captureCandles: z.boolean().default(true),
});

export const StreamConfigSchema = z.object({
  private: z.object({
    reconnectBaseMs: z.number().min(100).default(1_000),
    reconnectMaxMs: z.number().min(1000).default(30_000),
    maxReconnectAttempts: z.number().min(1).default(10),
  }).default({}),
  public: PublicStreamConfigSchema.default({}),
});
export const MarketDataBudgetSchema = z.object({
  requestsPerMinute: z.number().int().min(1),
  burstCapacity: z.number().int().min(1).optional(),
  maxWaitMs: z.number().int().min(0).default(5_000),
  cacheTtlMs: z.number().int().min(0).default(0),
});

// --- Token Safety Config ---

export const CanonicalTokenEntrySchema = z.object({
  address: z.string().min(1),
  name: z.string().min(1),
  aliases: z.array(z.string().min(1)).default([]),
});

export const TokenSafetyDefaultsSchema = z.object({
  minLiquidityUsd: z.number().min(0).default(10_000),
  minVolume24hUsd: z.number().min(0).default(25_000),
  minTokenAgeHours: z.number().min(0).default(24),
  deadPoolMinAgeHours: z.number().min(1).default(24 * 30),
  deadPoolMaxVolume24hUsd: z.number().min(0).default(1_000),
  preferCanonical: z.boolean().default(true),
  requireCanonicalForKnownSymbols: z.boolean().default(true),
  includeBlockedSearchResults: z.boolean().default(false),
});

export const TokenSafetyTradeGuardSchema = z.object({
  enabled: z.boolean().default(true),
  liquidityMultiplier: z.number().min(1).default(200),
  allowOverrides: z.boolean().default(true),
  overrideTtlMs: z.number().int().min(60_000).default(300_000),
});

export const TokenSafetyConfigSchema = z.object({
  enabled: z.boolean().default(true),
  defaults: TokenSafetyDefaultsSchema.default({}),
  tradeGuard: TokenSafetyTradeGuardSchema.default({}),
  canonicalTokens: z.record(
    z.string(),
    z.record(z.string(), CanonicalTokenEntrySchema),
  ).default({}),
});

export const MarketDataConfigSchema = z.object({
  dexscreener: z.object({
    baseUrl: z.string().url().default('https://api.dexscreener.com'),
    search: MarketDataBudgetSchema.default({
      requestsPerMinute: 30,
      burstCapacity: 30,
      maxWaitMs: 5_000,
      cacheTtlMs: 15_000,
    }),
    discovery: MarketDataBudgetSchema.default({
      requestsPerMinute: 30,
      burstCapacity: 15,
      maxWaitMs: 5_000,
      cacheTtlMs: 300_000,
    }),
  }).default({}),
  geckoterminal: z.object({
    baseUrl: z.string().url().default('https://api.geckoterminal.com'),
    proBaseUrl: z.string().url().default('https://pro-api.coingecko.com').optional(),
    apiKey: z.string().optional(),
    candles: MarketDataBudgetSchema.default({
      requestsPerMinute: 15,
      burstCapacity: 15,
      maxWaitMs: 5_000,
      cacheTtlMs: 60_000,
    }),
    discovery: MarketDataBudgetSchema.default({
      requestsPerMinute: 60,
      burstCapacity: 5,
      maxWaitMs: 5_000,
      cacheTtlMs: 300_000,
    }),
  }).default({}),
  hyperliquid: z.object({
    baseUrl: z.string().url().default('https://api.hyperliquid.xyz'),
    intelligencePath: z.string().default('/info'),
    intelligence: MarketDataBudgetSchema.default({
      requestsPerMinute: 120,
      burstCapacity: 20,
      maxWaitMs: 2_000,
      cacheTtlMs: 60_000,
    }),
  }).default({}),
  bybit: z.object({
    baseUrl: z.string().url().default('https://api.bybit.com'),
    longShortRatioPath: z.string().default('/v5/market/account-ratio'),
    intelligence: MarketDataBudgetSchema.default({
      requestsPerMinute: 120,
      burstCapacity: 20,
      maxWaitMs: 2_000,
      cacheTtlMs: 60_000,
    }),
    tickers: MarketDataBudgetSchema.default({
      requestsPerMinute: 30,
      burstCapacity: 10,
      maxWaitMs: 2_000,
      cacheTtlMs: 30_000,
    }),
  }).default({}),
  binance: z.object({
    baseUrl: z.string().url().default('https://api.binance.com'),
    requestsPerMinute: z.number().min(1).default(200),
    /** Max ms to wait for the shared rate-limit token bucket to refill before giving up.
     *  Separate from marketData.timeoutMs (HTTP timeout). Binance has a high RPM
     *  (200) but a correspondingly large burst; after the burst drains the bucket,
     *  subsequent requests need ~300 ms each. A 30 s window gives adequate headroom. */
    maxWaitMs: z.number().int().min(1_000).default(30_000),
    /** Scanner capacity controls — prevent scanner candle traffic from exhausting
     *  the shared Binance rate-limit budget. Operator-config owned per config-layer rules. */
    scanner: z.object({
      /** Per-worker max scanner candle requests per minute.
       *  Default 50 RPM — derived from operator capacity calc (200 RPM binance budget,
       *  150 reserved for regime checks). */
      maxRequestsPerMinute: z.number().int().min(1).default(50),
      /** Max concurrent scanner agents across all workers. Used as a per-worker
       *  in-memory gate until a cross-worker Redis semaphore is added. */
      maxConcurrentScans: z.number().int().min(1).default(4),
      /** Max entry candidates selected per scan. Bounds Hyperliquid discovery
       *  results before they become candle requests. Open-position exit evaluation
       *  symbols are always preserved above this cap. */
      maxCandidates: z.number().int().min(1).default(20),
    }).default({}),
  }).default({}),
  birdeye: z.object({
    enabled: z.boolean().default(false),
    baseUrl: z.string().url().default('https://public-api.birdeye.so'),
    requestsPerMinute: z.number().int().min(1).default(60),
    apiKey: z.string().default(''),
    cacheTtlMs: z.number().int().min(0).default(3_600_000),
  }).default({}),
  coinMarketCap: z.object({
    enabled: z.boolean().default(false),
    baseUrl: z.string().url().default('https://pro-api.coinmarketcap.com'),
    requestsPerMinute: z.number().int().min(1).default(30),
    apiKey: z.string().default(''),
    cacheTtlMs: z.number().int().min(0).default(3_600_000),
  }).default({}),
  scrapfly: z.object({
    baseUrl: z.string().url().default('https://api.scrapfly.io/scrape'),
    asp: z.boolean().default(true),
    requestTimeoutMs: z.number().int().min(1_000).default(60_000),
  }).default({}),
  discovery: z.object({
    maxResults: z.number().int().min(1).max(100).default(50),
    geckoTerminalExtraPages: z.number().int().min(0).max(10).default(0),
    antistalenessCooldownHours: z.number().min(0).default(4),
    antistalenessTokenTtlHours: z.number().min(1).default(24),
  }).superRefine((data, ctx) => {
    if (data.antistalenessTokenTtlHours < data.antistalenessCooldownHours) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'antistalenessTokenTtlHours must be >= antistalenessCooldownHours',
        path: ['antistalenessTokenTtlHours'],
      });
    }
  }).default({}),
  tokenSafety: TokenSafetyConfigSchema.default({}),
  economicCalendar: z.object({
    enabled: z.boolean().default(false),
    daysForward: z.number().int().min(1).max(14).default(2),
    minImpact: z.enum(['high', 'medium', 'low']).default('medium'),
    currencies: z.array(z.string()).default([]),
    cacheTtlMs: z.number().int().min(0).default(10_800_000),
    maxEventsInContext: z.number().int().min(1).max(50).default(20),
    refreshIntervalMs: z.number().int().min(60_000).default(21_600_000),
    forexFactory: z.object({
      baseUrl: z.string().url().default('https://www.forexfactory.com'),
      requestTimeoutMs: z.number().int().min(1_000).default(10_000),
      requestsPerMinute: z.number().int().min(1).default(2),
      userAgent: z.string().min(1).default('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'),
    }).default({}),
  }).default({}),
  timeoutMs: z.number().min(1000).default(5000),
}).superRefine((data, ctx) => {
  if (data.birdeye.enabled && !data.birdeye.apiKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'marketData.birdeye.apiKey is required when birdeye.enabled is true',
      path: ['birdeye', 'apiKey'],
    });
  }
  if (data.coinMarketCap.enabled && !data.coinMarketCap.apiKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'marketData.coinMarketCap.apiKey is required when coinMarketCap.enabled is true',
      path: ['coinMarketCap', 'apiKey'],
    });
  }
});

export const LiveRolloutConfigSchema = z.object({
  /** Master switch — must be true for any instance to run in live mode */
  enabled: z.boolean().default(false),
  /** Venues permitted to execute live orders (others are rejected at startup) */
  allowedVenues: z.array(z.enum(SUPPORTED_LIVE_VENUES)).default(['hyperliquid']),
  /** Require DB-backed credentials (reject env-var fallback for live mode) */
  requireDbCredentials: z.boolean().default(true),
  /** Hard cap on single-order notional (USD) during rollout — instance maxOrderNotional is clamped to this */
  maxInitialOrderNotionalUsd: z.string().default('50').refine(
    (v) => { const n = Number(v); return v === v.trim() && Number.isFinite(n) && n > 0; },
    { message: 'maxInitialOrderNotionalUsd must be a finite positive numeric string (no surrounding whitespace)' },
  ),
  /** Consecutive venue errors before circuit-breaker halts the actor */
  maxConsecutiveVenueErrors: z.number().int().min(1).default(3),
  /** Slippage alert threshold (bps) — log warning when fill deviates beyond this */
  slippageAlertBps: z.number().min(0).default(50),
  /** Timeout for stale live limit orders before cancellation is attempted */
  limitOrderTimeoutMs: z.number().int().min(1000).default(120_000),
  /** Timeout for live market orders that never reach terminal completion */
  marketOrderTimeoutMs: z.number().int().min(1000).default(30_000),
  /** Interval for live timeout scans in actor loops */
  timeoutCheckIntervalMs: z.number().int().min(1000).default(10_000),
  /** Fatal live crash policy: emergency flatten confirmed exposure or halt for manual intervention */
  crashPolicy: z.enum(['auto_go_flat', 'alert_manual_intervention']).default('alert_manual_intervention'),
});
export type BacktestingConfig = z.infer<typeof BacktestingConfigSchema>;
export type MarketDataRecordingConfig = z.infer<typeof MarketDataRecordingConfigSchema>;
export type LiveRolloutConfig = z.infer<typeof LiveRolloutConfigSchema>;
export type MarketDataConfig = z.infer<typeof MarketDataConfigSchema>;
export type TokenSafetyConfig = z.infer<typeof TokenSafetyConfigSchema>;

// --- Trading Instance Config (stored in Postgres JSONB, per-instance) ---

/**
 * Token-safety guardrails for swap/DEX venues.
 * Venue/DEX-specific — kept separate from the shared risk core.
 *
 * **Precedence:** When both `tokenSafety.*` and the deprecated
 * `risk.minSwapToken*` / `risk.allowSwapTokenSafetyOverride` fields are
 * present, `tokenSafety.*` takes precedence.
 */
export const TokenSafetySchema = z.object({
  /** Minimum token liquidity in USD. Tokens below this threshold are filtered out. */
  minLiquidityUsd: z.number().min(0).optional(),
  /** Minimum 24h trading volume in USD. Tokens below this threshold are filtered out. */
  minVolume24hUsd: z.number().min(0).optional(),
  /** Minimum token age in hours. Tokens younger than this are filtered out. */
  minAgeHours: z.number().min(0).optional(),
  /** Whether the agent/bot is allowed to issue token-safety overrides. */
  allowOverrides: z.boolean().optional(),
});
export type TokenSafety = z.infer<typeof TokenSafetySchema>;

export const RiskConfigSchema = z.preprocess(
  (input) => {
    // Accept legacy stopLossMaxUnrealizedLossPct as input alias → normalize to stopLossPct
    if (typeof input === 'object' && input !== null) {
      const obj = input as Record<string, unknown>;
      if ('stopLossMaxUnrealizedLossPct' in obj && !('stopLossPct' in obj)) {
        console.debug('RiskConfigSchema: normalizing legacy stopLossMaxUnrealizedLossPct to stopLossPct');
        return { ...obj, stopLossPct: obj['stopLossMaxUnrealizedLossPct'] };
      }
    }
    return input;
  },
  z.object({
    maxPositionSizePct: z.number().min(0).max(100).optional(),
    maxPositionSize: z.string().optional(),
    maxOpenPositions: z.number().min(1).optional(),
    maxDrawdown: z.string().optional(),
    dailyMaxLossPct: z.number().min(0).max(100).optional(),
    stopLossCooldownMs: z.number().min(0).optional(),
    stopLossPct: z.number().min(0).max(100).optional(),
    /**
     * Per-order notional cap (absolute, as a string — e.g. "1000" for $1,000).
     * Note: This is `z.string()` here, while `RiskPostureSchema.maxOrderNotional`
     * is `z.number()`. Reconciliation of this type mismatch is deferred.
     */
    maxOrderNotional: z.string().optional(),
    /**
     * @deprecated Use tokenSafety.minLiquidityUsd instead.
     * When both are present, tokenSafety.minLiquidityUsd takes precedence.
     */
    minSwapTokenLiquidityUsd: z.number().min(0).optional(),
    /**
     * @deprecated Use tokenSafety.minVolume24hUsd instead.
     * When both are present, tokenSafety.minVolume24hUsd takes precedence.
     */
    minSwapTokenVolume24hUsd: z.number().min(0).optional(),
    /**
     * @deprecated Use tokenSafety.minAgeHours instead.
     * When both are present, tokenSafety.minAgeHours takes precedence.
     */
    minSwapTokenAgeHours: z.number().min(0).optional(),
    /**
     * @deprecated Use tokenSafety.allowOverrides instead.
     * When both are present, tokenSafety.allowOverrides takes precedence.
     */
    allowSwapTokenSafetyOverride: z.boolean().optional(),
    maxNewPositionsPerDay: z.number().int().min(0).optional(),
    avoidParabolicMovePct: z.number().min(0).optional(),
  }),
);

/**
 * Risk playbook values forwarded from RiskConfigSchema into the strategy snapshot.
 * These are risk/safety guards consumed by MechanicalStrategy (and eventually
 * HybridStrategy) during evaluate(). The TradingActor must populate this on every
 * snapshot; if absent, the checks silently pass — which is correct when the user
 * did not configure those guards, but is a bug if the actor forgot to populate.
 */
export const RiskPlaybookSchema = z.object({
  maxNewPositionsPerDay: z.number().int().min(0).optional(),
  avoidParabolicMovePct: z.number().min(0).optional(),
}).default({});

export type RiskPlaybook = z.infer<typeof RiskPlaybookSchema>;

// --- Indicator sub-schemas (Phase 0 — shared by TechnicalConfig and MechanicalParams) ---

/**
 * Regime filter params (mirrors RegimeParams from @traderton/market-data).
 * Defined here so domain has no dependency on market-data.
 */
export const RegimeParamsSchema = z.object({
  benchmarkSymbol: z.string().optional(),
  emaFast: z.number().int().positive().optional(),
  emaSlow: z.number().int().positive().optional(),
  emaTrend: z.number().int().positive().optional(),
  adxMin: z.number().min(0).optional(),
  emaAlignment: z.enum(['bullish', 'bearish', 'any']).optional(),
  marketStructure: z.enum(['higherHighs', 'lowerHighs', 'any']).optional(),
  priceAboveVwap: z.boolean().optional(),
  disableWhenChoppy: z.boolean().optional(),
});

export const RsiParamsSchema = z.object({
  enabled: z.boolean().default(true),
  period: z.number().int().min(2).default(14),
  healthyMin: z.number().default(40),
  healthyMax: z.number().default(70),
  overbought: z.number().default(80),
  weakBelow: z.number().default(30),
}).default({});

export const MacdParamsSchema = z.object({
  enabled: z.boolean().default(true),
  fast: z.number().int().default(12),
  slow: z.number().int().default(26),
  signal: z.number().int().default(9),
}).default({});

export const VolumeParamsSchema = z.object({
  enabled: z.boolean().default(true),
  strongRatio: z.number().default(1.5),
  weakRatio: z.number().default(0.5),
  recentBars: z.number().int().default(4),
  avgBars: z.number().int().default(20),
}).default({});

export const ChochParamsSchema = z.object({
  enabled: z.boolean().default(false),
  swingLookback: z.number().int().default(5),
  minSwingPct: z.number().default(0.01),
  minSwings: z.number().int().default(4),
  confirmBars: z.number().int().default(2),
  rejectOnBearish: z.boolean().default(false),
}).default({});

export const SupportResistanceParamsSchema = z.object({
  enabled: z.boolean().default(false),
  lookback: z.number().int().default(50),
  breakoutThreshold: z.number().default(0.005),
}).default({});

export const VwapParamsSchema = z.object({
  enabled: z.boolean().default(false),
  period: z.number().int().min(2).default(24),
}).default({});

export const PriceActionParamsSchema = z.object({
  enabled: z.boolean().default(true),
  minChange24hPct: z.number().default(3),
  maxChange24hPct: z.number().default(50),
}).default({});

export const ConfidenceWeightsSchema = z.object({
  rsiWeight: z.number().default(0.15),
  macdCrossoverWeight: z.number().default(0.20),
  macdIncreasingWeight: z.number().default(0.10),
  volumeWeight: z.number().default(0.15),
  breakoutWeight: z.number().default(0.15),
  chochBullishWeight: z.number().default(0.15),
  chochBearishPenalty: z.number().default(0.10),
  priceActionWeight: z.number().default(0.10),
  vwapWeight: z.number().default(0),
  minConfidence: z.number().default(0.45),
  minReasons: z.number().int().default(2),
}).default({});

export const IndicatorConfigSchema = z.object({
  rsi: RsiParamsSchema,
  macd: MacdParamsSchema,
  volume: VolumeParamsSchema,
  choch: ChochParamsSchema,
  supportResistance: SupportResistanceParamsSchema,
  vwap: VwapParamsSchema,
  priceAction: PriceActionParamsSchema,
  confidence: ConfidenceWeightsSchema,
});

export const SentimentConfigSchema = z.object({
  enabled: z.boolean().default(false),
  minDataPoints: z.number().int().min(1).default(5),
  positiveThreshold: z.number().min(0).max(1).default(0.2),
  negativeThreshold: z.number().min(-1).max(0).default(-0.2),
  maxBoost: z.number().min(0).max(0.5).default(0.1),
}).default({});

export const MechanicalParamsSchema = z.object({
  // Candle fetching
  candleInterval: z.enum(['5m', '15m', '1h', '4h', '1d']).default('15m'),
  candleLimit: z.number().int().min(20).max(500).default(48),
  minCandleCount: z.number().int().min(5).default(20),

  // Exit targets (strategy-level, not risk guards)
  stopLossPct: z.number().min(0).max(100),
  takeProfitPct: z.number().min(0),
  trailingStopPct: z.number().min(0).max(100).nullable().default(null),

  // Indicator suite
  indicators: IndicatorConfigSchema.default({}),

  // Signal interpretation
  signalBias: z.enum(['trend-following', 'mean-reverting']).default('trend-following'),

  // Sentiment
  sentiment: SentimentConfigSchema,

  // Position sizing
  positionSize: z.string().min(1),
  positionSizeMode: z.enum(['fixed', 'percent_equity']).default('fixed'),
});

// Ensure strategy param validation is active in production imports.
// The domain registry is mechanical-first: it only needs the mechanical + empty
// schemas to initialize.
//
// Traderton divergence (decisions 7–9, bots are mechanical-only): unlike herobids,
// Traderton does NOT call registerAgentDecisionModes({ llm, hybrid }). The llm/hybrid
// decision modes are the agent's reasoning modes and stay agent-side. As a result
// this registry is mechanical-only: momentum:llm / momentum:hybrid resolve as
// unsupported here (dca remains registered for all modes with empty params).
initStrategyRegistry({
  mechanical: MechanicalParamsSchema,
  empty: z.object({}).strict(),
});

/**
 * Strategy schema — splits trading style (type) from decision engine (decisionMode).
 * - type: what market logic (momentum, range, contrarian, swing, scalper, dca)
 * - decisionMode: how decisions are made (mechanical, llm, hybrid)
 * - params: tuning parameters for the trading style (indicator thresholds, LLM config, etc.)
 *
 * decisionMode is optional for DCA (timer-driven, no signal evaluation) and
 * required for all other types.
 */
/**
 * Derive the strategyPreset display label from a strategy.type value.
 * strategyPreset is a UI/display concept only — never stored in config JSONB.
 *
 * Mapped types return their display label (currently identity — momentum → 'momentum').
 * Unmapped types fall through to the raw type string as a pass-through display label.
 * The pass-through is intentional: new trading styles added to the type enum
 * do not require a PRESET_MAP update before they appear in UI lists.
 */
export function deriveStrategyPreset(strategyType: string | undefined): string | null {
  if (!strategyType) return null;
  const PRESET_MAP: Record<string, string> = {
    momentum: 'momentum',
    mechanical: 'mechanical',
  };
  return PRESET_MAP[strategyType] ?? strategyType;
}

/**
 * Safely extract the strategy sub-object from a bot config (JSONB rows, agent payloads, etc.).
 * Returns { type, decisionMode, params } when config has a valid strategy block, or null.
 *
 * Prefer this helper over inline `as Record<string, unknown>` casts which silently
 * suppress type errors that the StrategySchema is meant to catch.
 */
export function extractStrategyFromConfig(
  config: unknown,
): { type: string; decisionMode?: string; params?: Record<string, unknown> } | null {
  if (config == null || typeof config !== 'object') return null;
  const c = config as Record<string, unknown>;
  const strategy = c['strategy'];
  if (strategy == null || typeof strategy !== 'object') return null;
  const s = strategy as Record<string, unknown>;
  if (typeof s['type'] !== 'string') return null;
  return {
    type: s['type'] as string,
    decisionMode: typeof s['decisionMode'] === 'string' ? s['decisionMode'] as string : undefined,
    params: s['params'] != null && typeof s['params'] === 'object' ? s['params'] as Record<string, unknown> : undefined,
  };
}

export const StrategySchema = z.object({
  type: z.enum(['momentum', 'range', 'contrarian', 'swing', 'scalper', 'dca']),
  decisionMode: z.enum(['mechanical', 'llm', 'hybrid']).optional(),
  params: z.record(z.unknown()).optional(),
}).refine(
  (s) => s.type === 'dca' || s.decisionMode !== undefined,
  { message: 'decisionMode is required for non-DCA strategies', path: ['decisionMode'] },
);

// ---------------------------------------------------------------------------
// AUTHORED (Phase 9b, item A′ / S-1) — mechanical-only bot strategy boundary.
//
// Traderton bots are MECHANICAL-ONLY (decisions 7–9): intelligence is the agent's
// job; llm/hybrid decision modes relocate agent-side. herobids' `StrategySchema`
// (copied verbatim above) still accepts `mechanical | llm | hybrid` for its own
// agent paths, and the strategy registry already refuses to resolve `momentum:llm`
// / `momentum:hybrid` at the runtime layer. This narrowing makes the guarantee
// EXPLICIT at Traderton's owned bot-config boundary (a signed-off Intentional
// Divergence — S-1 option (a), narrow-and-diverge; see docs/004-decision-log.md
// + archive/features/013-9b-authoring-plan.md item A′), rather than leaving it as an
// emergent property of downstream registry rejection.
//
// This is the ONLY authored trading-shape divergence in item A. `StrategySchema`
// is left byte-verbatim (its copied acceptance test for `llm` stays true); the
// mechanical-only rule lives HERE, on the Traderton-owned wrapper, and is what
// `BotConfigSchema.strategy` validates against.
// ---------------------------------------------------------------------------
export const MechanicalStrategySchema = z.object({
  type: z.enum(['momentum', 'range', 'contrarian', 'swing', 'scalper', 'dca']),
  decisionMode: z.enum(['mechanical']).optional(),
  params: z.record(z.unknown()).optional(),
}).refine(
  (s) => s.type === 'dca' || s.decisionMode !== undefined,
  { message: 'decisionMode is required for non-DCA strategies', path: ['decisionMode'] },
);
export type MechanicalStrategy = z.infer<typeof MechanicalStrategySchema>;

/**
 * Execution defaults — canonicalized from the agent executionMode / maxSlippageBps.
 * Shared by both bots and agents. This is the canonical name;
 * {@link ExecutionConfigSchema} is a deprecated alias.
 */
export const ExecutionDefaultsSchema = z.object({
  mode: z.enum(['paper', 'shadow', 'live']).default('paper'),
  slippageBps: z.number().min(0).nullable().optional(),
});
export type ExecutionDefaults = z.infer<typeof ExecutionDefaultsSchema>;

/** @deprecated Use {@link ExecutionDefaultsSchema} (canonical name) instead. Alias retained for backward compat. */
export const ExecutionConfigSchema = ExecutionDefaultsSchema;

// ── Shared domain value objects (agent + bot vocabulary) ──────────────────────

/**
 * Strategy identity — canonicalized from {@link StrategySchema}.
 * Required for bots; optional/absent for non-trading agents.
 *
 * Validates params through the {@link StrategyParameterRegistry} when a registry
 * entry exists for the (type, decisionMode) combination. Falls back to the base
 * schema's permissive `z.record(z.unknown())` when no registry entry is found
 * (e.g. for strategy types not yet registered).
 */
export const StrategyIdentitySchema = StrategySchema.superRefine((data, ctx) => {
  const entry = getStrategyParameters(data.type, data.decisionMode);
  if (!entry) return; // No registry entry — let the base schema handle it

  try {
    validateStrategyParams(data.type, data.decisionMode, data.params);
  } catch (e) {
    if (e instanceof z.ZodError) {
      for (const issue of e.issues) {
        ctx.addIssue({ ...issue, path: ['params', ...issue.path] });
      }
    } else if (e instanceof Error && e.message.startsWith('Unsupported strategy')) {
      // Unsupported type/decisionMode — let the base schema handle it
    } else {
      throw e;
    }
  }
});
export type StrategyIdentity = z.infer<typeof StrategyIdentitySchema>;

/**
 * Risk posture — the canonical nullable value shape shared by agents and bots.
 * Every field is optional/nullable: null or absent means "use operator default".
 * Token-safety guards (liquidity, volume, age, override) belong in TokenSafety,
 * not here.
 */
export const RiskPostureSchema = z.object({
  /** Max position size as % of equity (0–100). Agent-mutable when not creator-configured. */
  maxPositionSizePct: z.number().min(0).max(100).optional().nullable(),
  /** Max number of open (non-flat) positions. Agent-mutable when not creator-configured. */
  maxOpenPositions: z.number().min(1).optional().nullable(),
  /** Stop-loss unrealized-loss guard as % of equity (0–100). 0 = disabled. Agent-mutable when not creator-configured. */
  stopLossPct: z.number().min(0).max(100).optional().nullable(),
  /** Cooldown in ms before re-entering an instrument after a stop-loss exit. 0 = disabled. Agent-mutable when not creator-configured. */
  stopLossCooldownMs: z.number().min(0).optional().nullable(),
  /** Daily realized-loss cap as % of equity (0–100). Creator-only — not agent-mutable. */
  dailyMaxLossPct: z.number().min(0).max(100).optional().nullable(),
  /** Peak-to-current equity drawdown cap as % of peak equity (0–100). Agent-mutable when not creator-configured. */
  maxDrawdownPct: z.number().min(0).max(100).optional().nullable(),
  /** Max new positions allowed per calendar day (0 = unlimited). Shared — promoted from bot-only. */
  maxNewPositionsPerDay: z.number().int().min(0).optional().nullable(),
  /** Parabolic-move guard: skip entry when 24h change exceeds this % (0 = disabled). */
  avoidParabolicMovePct: z.number().min(0).optional().nullable(),
  /** Per-order notional cap in USD (absolute, unavoidable). Creator-only — not agent-mutable. */
  maxOrderNotional: z.number().min(0).optional().nullable(),
});
export type RiskPosture = z.infer<typeof RiskPostureSchema>;

/**
 * Bot risk configuration — composed from canonical {@link RiskPostureSchema} fields.
 * All fields are optional numbers: present means enforce, absent means disabled.
 * Uses `.strict()` to reject unknown/legacy keys.
 * Does NOT include: legacy stopLossMaxUnrealizedLossPct alias, deprecated minSwapToken*
 * fields, allowSwapTokenSafetyOverride, absolute maxPositionSize/maxDrawdown strings.
 */
export const BotRiskSchema = z.object({
  maxPositionSizePct: z.number().min(0).max(100).optional(),
  maxOpenPositions: z.number().int().min(1).optional(),
  stopLossPct: z.number().min(0).max(100).optional(),
  stopLossCooldownMs: z.number().int().min(0).optional(),
  dailyMaxLossPct: z.number().min(0).max(100).optional(),
  maxDrawdownPct: z.number().min(0).max(100).optional(),
  maxNewPositionsPerDay: z.number().int().min(0).optional(),
  avoidParabolicMovePct: z.number().min(0).optional(),
  maxOrderNotional: z.number().min(0).optional(),
}).strict();
export type BotRisk = z.infer<typeof BotRiskSchema>;

export const BotConfigSchema = z.object({
  // Mechanical-only bot boundary (S-1, item A′): narrowed decisionMode. herobids
  // used the broad StrategySchema here; Traderton bots are mechanical-only.
  strategy: MechanicalStrategySchema,
  risk: BotRiskSchema.default({}),
  execution: ExecutionDefaultsSchema.default({}),
  /** Token-safety guardrails for swap/DEX venues. Prefer this over the deprecated risk.* fields. */
  tokenSafety: TokenSafetySchema.optional(),
  venue: z.string().optional(),
  symbol: z.string(),
  venueType: z.enum(['orderbook', 'swap']).optional(),
  shadowPollIntervalMs: z.number().min(100).default(2000),
  /** Explicit swap asset identifiers — required for swap venues to avoid fragile symbol parsing */
  swapAssets: z.object({
    baseAsset: z.string(),
    quoteAsset: z.string(),
    /** Decimal places for the base asset (e.g. 9 for SOL). Required for raw-unit conversion. */
    baseDecimals: z.number().int().min(0).max(18),
    /** Decimal places for the quote asset (e.g. 6 for USDC). Required for raw-unit conversion. */
    quoteDecimals: z.number().int().min(0).max(18),
  }).optional(),
}).refine(
  (data) => data.venueType !== 'swap' || data.swapAssets !== undefined,
  { message: 'swapAssets is required when venueType is "swap"', path: ['swapAssets'] },
).refine(
  (data) => data.venueType !== 'swap' || data.execution.mode !== 'paper',
  { message: 'Swap venues cannot run in paper mode (no price source). Use shadow mode.', path: ['execution', 'mode'] },
).refine(
  (data) => {
    if (!data.venue || !data.venueType) return true; // venue/venueType are stamped by the broker
    // Enforce venue string matches venueType to prevent config/adapter mismatch
    if (data.venueType === 'swap') return (SWAP_VENUES as readonly string[]).includes(data.venue);
    return (ORDERBOOK_VENUES as readonly string[]).includes(data.venue);
  },
  { message: 'venue must match venueType: swap venues are [jupiter, 1inch], orderbook venues are [hyperliquid, bybit]', path: ['venue'] },
);

export type BotConfig = z.infer<typeof BotConfigSchema>;
/**
 * RiskConfig — the TypeScript type inferred from {@link RiskConfigSchema}.
 * Note: This type no longer includes the legacy `stopLossMaxUnrealizedLossPct`
 * field. Input data with that field is normalized to `stopLossPct` by the
 * schema's preprocess step.
 */
export type RiskConfig = z.infer<typeof RiskConfigSchema>;
export type StrategyConfig = z.infer<typeof StrategySchema>;
export type MechanicalParams = z.infer<typeof MechanicalParamsSchema>;

// --- Agent Technical Config (automation-agents Phase 3) ---

export const TechnicalConfigSchema = z.object({
  filters: z.object({
    venue: z.string(),
    venueType: z.enum(['orderbook', 'swap']),
    minVolume24hUsd: z.number().min(0).optional(),
    minLiquidityUsd: z.number().min(0).optional(),
    networks: z.array(z.string()).optional(),
    symbols: z.array(z.string()).optional(),
    excludeSymbols: z.array(z.string()).optional(),
    /** Canonical quote asset symbol for swap scanning (e.g. USDC, USDT).
     *  Defaults to 'USDC'. Must be a key in the operator-owned
     *  marketData.tokenSafety.canonicalTokens[network] map.
     *  Agent instance config (runtime, DB) — not operator config. */
    quoteAssetSymbol: z.string().optional().default('USDC'),
  }),
  regime: RegimeParamsSchema.optional(),
  indicators: IndicatorConfigSchema.default({}),
  candles: z.object({
    interval: z.enum(['5m', '15m', '1h', '4h', '1d']).default('15m'),
    limit: z.number().int().min(20).max(500).default(100),
  }).default({}),
  signalBias: z.enum(['trend-following', 'mean-reverting']).default('trend-following'),
  scanIntervalMs: z.number().int().min(10_000).default(60_000),
  scanBatchSize: z.number().int().min(1).max(50).default(5),
  autonomousExit: z.boolean().default(false),
});

/**
 * Strict variant of TechnicalConfigSchema used for worker startup validation
 * of persisted scanner-gated agent configuration. Removes ALL .default() calls
 * so that missing required fields are rejected rather than silently repaired.
 *
 * Inner defaults (candles.interval, candles.limit, indicator sub-fields) are
 * retained — the strict check only requires the parent objects to be present.
 *
 * Phase 1 (scanner-gated hardening): applied at worker startup for
 * scanner_gated hybrid agents before the scan loop is created.
 */
export const StrictTechnicalConfigSchema = z.object({
  filters: z.object({
    venue: z.string(),
    venueType: z.enum(['orderbook', 'swap']),
    minVolume24hUsd: z.number().min(0).optional(),
    minLiquidityUsd: z.number().min(0).optional(),
    networks: z.array(z.string()).optional(),
    symbols: z.array(z.string()).optional(),
    excludeSymbols: z.array(z.string()).optional(),
    quoteAssetSymbol: z.string().optional().default('USDC'),
  }),
  regime: RegimeParamsSchema.optional(),
  indicators: IndicatorConfigSchema,
  candles: z.object({
    interval: z.enum(['5m', '15m', '1h', '4h', '1d']).default('15m'),
    limit: z.number().int().min(20).max(500).default(100),
  }),
  signalBias: z.enum(['trend-following', 'mean-reverting']),
  scanIntervalMs: z.number().int().min(10_000),
  scanBatchSize: z.number().int().min(1).max(50),
  autonomousExit: z.boolean(),
});

export type RegimeParams = z.infer<typeof RegimeParamsSchema>;
export type RsiParams = z.infer<typeof RsiParamsSchema>;
export type MacdParams = z.infer<typeof MacdParamsSchema>;
export type VolumeParams = z.infer<typeof VolumeParamsSchema>;
export type ChochParams = z.infer<typeof ChochParamsSchema>;
export type SupportResistanceParams = z.infer<typeof SupportResistanceParamsSchema>;
export type ConfidenceWeights = z.infer<typeof ConfidenceWeightsSchema>;
export type IndicatorConfig = z.infer<typeof IndicatorConfigSchema>;
export type VwapParams = z.infer<typeof VwapParamsSchema>;
export type PriceActionParams = z.infer<typeof PriceActionParamsSchema>;
export type SentimentConfig = z.infer<typeof SentimentConfigSchema>;
export type TechnicalConfig = z.infer<typeof TechnicalConfigSchema>;

// ---------------------------------------------------------------------------
// Agent risk defaults (operator layer) — re-synced verbatim from herobids
// packages/domain/src/config/schema.ts during Phase 9b (item A). All fields are
// trading risk/halt defaults consumed by the mechanical loop (agent-risk-limits.ts,
// the risk contract resolver). Copy-and-delete: this schema is entirely trading —
// no platform fields to trim. Re-opens the Phase-1 over-deletion that removed it
// with the platform config block. See archive/features/013-9b-authoring-plan.md item A.
// ---------------------------------------------------------------------------
export const AgentRiskDefaultsSchema = z.object({
  /** @deprecated Use dailyMaxLossPct (percent of equity) instead. Ratio-based loss limit. */
  dailyLossLimitDefaultRatio: z.number().min(0).max(1).default(0.05),
  maxOpenPositions: z.number().min(1).default(10),
  maxPositionSizePct: z.number().min(0).max(100).default(100),
  maxPositionSize: z.number().min(0).default(1_000_000),
  stopLossPct: z.number().min(0).max(100).default(10),
  dailyMaxLossPct: z.number().min(0).max(100).default(20),
  stopLossCooldownMs: z.number().min(0).default(300_000),
  maxOrderNotionalMultiplier: z.number().min(0).default(1),
  botConfigInvalidHaltThreshold: z.number().int().min(1).default(1),
  botExecutionErrorHaltThreshold: z.number().int().min(1).default(5),
  botLlmProviderErrorHaltThreshold: z.number().int().min(1).default(1),
  /** Consecutive no_context failures before hardening retryable → false.
   *  Only applies after the actor has proven it CAN fetch context (first successful fetch). */
  agentDecisionNoContextThreshold: z.number().int().min(1).default(10),
  /** Consecutive swap.instrument_format failures before hardening retryable → false. */
  agentDecisionSwapInstrumentFormatThreshold: z.number().int().min(1).default(5),
  maxDrawdown: z.number().min(0).default(1_000_000_000),
  /** Operator default and ceiling for peak-to-current equity drawdown (percent).
   *  Used when the creator did not set maxDrawdownPct. Agent may adjust downward at runtime. */
  maxDrawdownPct: z.number().min(0).max(100).default(20),
  /** Interval in ms for the periodic per-trade stop-loss / take-profit monitor loop. */
  perTradeLevelMonitorIntervalMs: z.number().min(1000).default(5000),
  /** Operator default for agent max concurrent bots. Used when the agent row has no maxBots override. */
  maxBots: z.number().int().min(1).default(5),
}).default({});
export type AgentRiskDefaultsConfig = z.infer<typeof AgentRiskDefaultsSchema>;

// ---------------------------------------------------------------------------
// Traderton-owned AppConfig — re-synced from herobids AppConfigSchema (item A,
// Phase 9b) by COPY-AND-DELETE (fused-file trim, the Phase-1 technique):
//   - kept: trading keys (database, redis, venues, execution, simulation, risk,
//     agentRiskDefaults, reconciliation, streams, marking, backtesting,
//     marketDataRecording, marketData, liveRollout) + app.{port,logLevel} (base
//     process config, always operator-owned per decision 1);
//   - deleted platform keys: api, sharedServices, runtimeBackend, nomad,
//     agentApprovals (consumer-owned approvals), agentCostEstimates, evaluation,
//     marketIntelligence, platformAssessor, worker, agentRuntime, llm,
//     llmValidation, integrations(gmail), alerts, auth, plans, billing,
//     usageBilling, externalSkills, browserPool, services;
//   - superRefine trimmed to the TWO trading checks (1inch tokenSafetyNetwork;
//     jupiter/1inch walletGeneration→apiKey); the platform plans/billing/nomad
//     validation blocks deleted.
// This re-opens the Phase-1 over-deletion (AppConfigSchema was removed wholesale
// as platform). Traderton owns its config (decision 2). The copied config loader
// test is the parity oracle. See archive/features/013-9b-authoring-plan.md item A.
// ---------------------------------------------------------------------------
export const AppConfigSchema = z.object({
  app: z.object({
    port: z.number().default(3000),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  }),
  database: z.object({
    url: z.string(),
    poolMin: z.number().default(2),
    poolMax: z.number().default(10),
  }),
  redis: z.object({
    url: z.string().default('redis://localhost:6379'),
  }),
  venues: z.record(VenueConfigSchema).default({}),
  execution: z.object({
    defaultSlippageBps: z.number().min(0).default(50),
    orderTimeoutMs: z.number().min(1000).default(30_000),
    maxRetries: z.number().min(0).default(3),
    shadowPollIntervalMs: z.number().int().min(100).default(2_000),
    shadowQuoteSlippageBps: z.number().min(0).default(50),
  }),
  simulation: z.object({
    takerFeePct: z.number().min(0).default(0.001),
    makerFeePct: z.number().min(0).default(0.0005),
    paperSlippageBps: z.number().min(0).default(5),
  }).default({}),
  risk: z.object({
    globalMaxDrawdownPct: z.number().min(0).max(100).default(20),
    maxOpenPositions: z.number().min(1).default(10),
    maxPositionSizePct: z.number().min(0).max(100).default(25),
  }),
  agentRiskDefaults: AgentRiskDefaultsSchema,
  reconciliation: ReconciliationConfigSchema.default({}),
  streams: StreamConfigSchema.default({}),
  marking: MarkingConfigSchema.default({}),
  backtesting: BacktestingConfigSchema.default({}),
  marketDataRecording: MarketDataRecordingConfigSchema.default({}),
  marketData: MarketDataConfigSchema.optional(),
  liveRollout: LiveRolloutConfigSchema.default({}),
}).superRefine((data, ctx) => {
  const oneInchConfig = data.venues['1inch'];
  if (
    data.marketData?.tokenSafety?.enabled
    && oneInchConfig
    && !oneInchConfig.tokenSafetyNetwork
    && oneInchConfig.chainId != null
    && !inferOneInchTokenSafetyNetwork(oneInchConfig.chainId)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `venues.1inch.chainId ${String(oneInchConfig.chainId)} requires venues.1inch.tokenSafetyNetwork when marketData.tokenSafety.enabled is true`,
      path: ['venues', '1inch', 'tokenSafetyNetwork'],
    });
  }
  for (const provider of ['jupiter', '1inch'] as const) {
    const venue = data.venues[provider];
    if (venue?.walletGeneration.enabled && !venue.apiKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `venues.${provider}.apiKey is required when venues.${provider}.walletGeneration.enabled is true`,
        path: ['venues', provider, 'apiKey'],
      });
    }
  }
});
export type AppConfig = z.infer<typeof AppConfigSchema>;
