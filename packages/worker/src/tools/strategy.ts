import { z } from 'zod';
import { createLogger } from '../logger.js';
import type { AgentTool, ToolResult, TradingToolContext } from '@traderton/domain';
import type { ScannerCandleTarget } from '@traderton/domain';
import { IndicatorConfigSchema } from '@traderton/domain';
import {
  scoreCandidate,
  type CandidateContext,
  type ScanConfig,
} from '@traderton/strategy';
import { convertZodToJsonSchema } from './registry.js';

const logger = createLogger('tools:strategy');

// --- score_candidate ---
//
// Boundary read tool wrapping `scoreCandidate` from @traderton/strategy. It runs
// a strategy's indicator/scoring config over candles and returns a trading signal
// (confidence + go_long/go_short) or null (no signal — a valid read result).
//
// Candle-fetching happens BEHIND the boundary (ctx.scannerCandleFetcher): the
// caller passes only identifiers (symbol + venueType + provider coordinates), not
// candle arrays. This is required by the legal-isolation objective — the consumer
// must not fetch trading candle data. Supports BOTH orderbook and swap targets
// (no downgrade vs the source preset-scorecard use).
//
// Swap targets accept EITHER a known `poolAddress` (Option A) OR a held token
// (`network + tokenAddress`) whose canonical pool is resolved behind the boundary
// via ctx.scannerPoolResolver (highest liquidity, tie-break volume then address),
// then scored on that pool's candles. Resolving the pool behind the boundary keeps
// the token→pool market-data lookup off the consumer (legal-isolation).

// IndicatorConfig is a large optional-nested config; accept it as a passthrough
// object validated structurally by scoreCandidate's own defaults. We validate the
// outer ScanConfig shape here.
const ScanConfigSchema = z.object({
  indicators: IndicatorConfigSchema.describe('Indicator suite: nested rsi/macd/volume/choch/vwap/priceAction/supportResistance/confidence settings. Omitted fields use engine defaults.'),
  signalBias: z.enum(['trend-following', 'mean-reverting']).describe('Signal bias for scoring.'),
  maxResults: z.coerce.number().int().positive().optional().describe('Optional cap on results (single-candidate scoring ignores this).'),
});

const ScoreCandidateParamsSchema = z.object({
  symbol: z.string().min(1).describe('Display symbol of the candidate (e.g. "BTC", or "ethereum:0x..." for swaps).'),
  instrumentId: z.string().min(1).optional().describe('Instrument id; defaults to `symbol` when omitted.'),
  venueType: z.enum(['orderbook', 'swap']).describe('orderbook (perp/spot via provider symbol) or swap (DEX pool via network + pool address).'),
  // orderbook target
  providerSymbol: z.string().min(1).optional().describe('For venueType=orderbook: the provider symbol to fetch candles for (e.g. "BTCUSDT").'),
  // swap target
  network: z.string().min(1).optional().describe('For venueType=swap: the chain/network of the pool (or token).'),
  poolAddress: z.string().min(1).optional().describe('For venueType=swap: the DEX pool address (Option A — pool already known). When omitted, pass tokenAddress and the pool is resolved behind the boundary.'),
  tokenAddress: z.string().min(1).optional().describe('For venueType=swap: the held token address. The highest-liquidity pool for network+tokenAddress is resolved behind the boundary, then scored.'),
  venue: z.string().optional().describe('Optional venue label carried onto the candidate/signal.'),
  interval: z.string().optional().describe('Candle interval (default "1h").'),
  candleLimit: z.coerce.number().int().positive().max(1000).optional().describe('Number of candles to fetch (default 200).'),
  config: ScanConfigSchema,
});

type ScoreCandidateParams = z.infer<typeof ScoreCandidateParamsSchema>;

/** A resolved swap pool candidate (structural subset of DiscoveredPool). */
interface ResolvedPool {
  poolAddress: string;
  network: string;
  liquidityUsd: number;
  volume24hUsd: number;
}

/**
 * Select the canonical pool for a resolved token per the ratified heuristic:
 * filter to the target network (case-insensitive), then highest `liquidityUsd`
 * desc, tie-break `volume24hUsd` desc, then `poolAddress` lexicographic. No
 * quote-asset constraint (recorded decision). Returns null when no pool matches.
 */
function selectCanonicalPool(pools: ResolvedPool[], network: string): ResolvedPool | null {
  const networkLc = network.toLowerCase();
  const matching = pools.filter((pool) => pool.network.toLowerCase() === networkLc);
  if (matching.length === 0) {
    return null;
  }
  return [...matching].sort((a, b) => {
    if (b.liquidityUsd !== a.liquidityUsd) return b.liquidityUsd - a.liquidityUsd;
    if (b.volume24hUsd !== a.volume24hUsd) return b.volume24hUsd - a.volume24hUsd;
    return a.poolAddress.localeCompare(b.poolAddress);
  })[0]!;
}

/**
 * Build the ScannerCandleTarget from the validated params (venueType discriminated).
 *
 * Orderbook requires `providerSymbol`. Swap accepts EITHER `network + poolAddress`
 * (Option A — pool already known) OR `network + tokenAddress` (a held token whose
 * pool must be resolved behind the boundary — signalled by `resolveToken`).
 */
function buildTarget(
  p: ScoreCandidateParams,
): { ok: true; target: ScannerCandleTarget } | { ok: true; resolveToken: { network: string; tokenAddress: string } } | { ok: false; error: string } {
  if (p.venueType === 'orderbook') {
    if (!p.providerSymbol) {
      return { ok: false, error: 'providerSymbol is required for venueType=orderbook' };
    }
    return { ok: true, target: { venueType: 'orderbook', providerSymbol: p.providerSymbol } };
  }
  // swap — network is always required; then EITHER a known pool OR a token to resolve.
  if (!p.network) {
    return { ok: false, error: 'network is required for venueType=swap' };
  }
  if (p.poolAddress) {
    return { ok: true, target: { venueType: 'swap', network: p.network, poolAddress: p.poolAddress } };
  }
  if (p.tokenAddress) {
    return { ok: true, resolveToken: { network: p.network, tokenAddress: p.tokenAddress } };
  }
  return { ok: false, error: 'poolAddress or tokenAddress is required for venueType=swap' };
}

const scoreCandidateTool: AgentTool<TradingToolContext> = {
  name: 'score_candidate',
  description: 'Score a single candidate symbol against a strategy indicator/scoring config and return a trading signal (confidence + go_long/go_short) or null if no signal. Candles are fetched behind the boundary; pass only identifiers. Supports orderbook targets and swap targets (either a known poolAddress, or a network+tokenAddress whose pool is resolved behind the boundary).',
  parametersSchema: ScoreCandidateParamsSchema,
  parameters: convertZodToJsonSchema(ScoreCandidateParamsSchema),
  category: 'read-market-data',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    if (!ctx.scannerCandleFetcher) {
      return {
        success: false,
        error: 'market_data_not_configured',
        retryable: false,
      };
    }

    const p = params as ScoreCandidateParams;
    const targetResult = buildTarget(p);
    if (!targetResult.ok) {
      return { success: false, error: targetResult.error, retryable: false, fault: false };
    }

    const interval = p.interval ?? '1h';
    const limit = p.candleLimit ?? 200;

    try {
      // Swap-token arm: resolve the held token → its pools behind the boundary,
      // pick the canonical (highest-liquidity) pool, then score its candles via
      // the SAME swap candle path Option A uses.
      let target: ScannerCandleTarget;
      if ('resolveToken' in targetResult) {
        if (!ctx.scannerPoolResolver) {
          return { success: false, error: 'market_data_not_configured', retryable: false };
        }
        const { network, tokenAddress } = targetResult.resolveToken;
        const pools = await ctx.scannerPoolResolver(network, tokenAddress);
        const pool = selectCanonicalPool(pools, network);
        if (!pool) {
          return { success: false, error: 'swap_pool_unresolved', retryable: false, fault: false };
        }
        target = { venueType: 'swap', network, poolAddress: pool.poolAddress };
      } else {
        target = targetResult.target;
      }

      const candles = await ctx.scannerCandleFetcher(target, interval, limit);

      const candidate: CandidateContext = {
        symbol: p.symbol,
        instrumentId: p.instrumentId ?? p.symbol,
        candles,
        venue: p.venue,
        venueType: p.venueType,
      };

      const config: ScanConfig = {
        indicators: p.config.indicators as ScanConfig['indicators'],
        signalBias: p.config.signalBias,
        maxResults: p.config.maxResults,
      };

      const signal = scoreCandidate(candidate, config);

      // Derived candle-window (metadata only, NOT the raw candles): the first/last
      // candle timestamps of the series that was scored. PriceCandle.timestamp is an
      // ISO 8601 string, so pass the value through as-is (faithful to the underlying).
      const candleWindow =
        candles.length > 0
          ? { start: candles[0]!.timestamp, end: candles[candles.length - 1]!.timestamp }
          : null;

      // signal may be null — a valid "no signal" read result, not an error.
      return { success: true, data: { signal, candlesEvaluated: candles.length, candleWindow } };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      if (message.includes('Rate limit exceeded')) {
        return { success: false, error: 'rate_limit', retryable: true };
      }
      logger.warn({ err, tool: 'score_candidate' }, 'score_candidate failed');
      return { success: false, error: message, retryable: false, fault: false };
    }
  },
};

export const strategyTools: AgentTool<TradingToolContext>[] = [
  scoreCandidateTool,
];
