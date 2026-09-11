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
  network: z.string().min(1).optional().describe('For venueType=swap: the chain/network of the pool.'),
  poolAddress: z.string().min(1).optional().describe('For venueType=swap: the DEX pool address.'),
  venue: z.string().optional().describe('Optional venue label carried onto the candidate/signal.'),
  interval: z.string().optional().describe('Candle interval (default "1h").'),
  candleLimit: z.coerce.number().int().positive().max(1000).optional().describe('Number of candles to fetch (default 200).'),
  config: ScanConfigSchema,
});

type ScoreCandidateParams = z.infer<typeof ScoreCandidateParamsSchema>;

/** Build the ScannerCandleTarget from the validated params (venueType discriminated). */
function buildTarget(p: ScoreCandidateParams): { ok: true; target: ScannerCandleTarget } | { ok: false; error: string } {
  if (p.venueType === 'orderbook') {
    if (!p.providerSymbol) {
      return { ok: false, error: 'providerSymbol is required for venueType=orderbook' };
    }
    return { ok: true, target: { venueType: 'orderbook', providerSymbol: p.providerSymbol } };
  }
  // swap
  if (!p.network || !p.poolAddress) {
    return { ok: false, error: 'network and poolAddress are required for venueType=swap' };
  }
  return { ok: true, target: { venueType: 'swap', network: p.network, poolAddress: p.poolAddress } };
}

const scoreCandidateTool: AgentTool<TradingToolContext> = {
  name: 'score_candidate',
  description: 'Score a single candidate symbol against a strategy indicator/scoring config and return a trading signal (confidence + go_long/go_short) or null if no signal. Candles are fetched behind the boundary; pass only identifiers. Supports orderbook and swap targets.',
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
      const candles = await ctx.scannerCandleFetcher(targetResult.target, interval, limit);

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

      // signal may be null — a valid "no signal" read result, not an error.
      return { success: true, data: { signal, candlesEvaluated: candles.length } };
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
