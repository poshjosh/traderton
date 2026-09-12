import { resolveBinanceSymbol } from './binance-candles.js';
import type { PriceCandle, FreshnessMetadata } from './types.js';

export type CandleProviderKey = 'binance';
type CandleProviderRegistry = {
  binance: {
    // The concrete registry returns a full ProviderResult (data + meta.freshness);
    // the array-only `fetchCandles` narrows to `.data`, `fetchCandlesWithMeta` keeps meta.
    candles: (symbol: string, options?: { interval?: string; limit?: number }) => Promise<{ data: unknown[]; meta?: { freshness?: FreshnessMetadata } }>;
  };
};

/** Candles plus the fetch freshness the consumer's telemetry needs (provider + source). */
export interface CandlesWithMeta {
  candles: PriceCandle[];
  freshness: { provider: CandleProviderKey; source: FreshnessMetadata['source']; ageMs: number; isStale: boolean } | null;
}

export interface CandleProviderDescriptor {
  id: CandleProviderKey;
  resolveSymbol: (input: string) => string;
  symbolFormatHint: string;
  fetchCandles: (registry: CandleProviderRegistry, symbol: string, options?: { interval?: string; limit?: number }) => Promise<PriceCandle[]>;
  /** Like fetchCandles but preserves the provider freshness meta (for re-sourced telemetry). */
  fetchCandlesWithMeta: (registry: CandleProviderRegistry, symbol: string, options?: { interval?: string; limit?: number }) => Promise<CandlesWithMeta>;
}

const binanceCandleProvider: CandleProviderDescriptor = {
  id: 'binance',
  resolveSymbol: resolveBinanceSymbol,
  symbolFormatHint: "Base ticker (e.g. 'BTC', 'SOL')",
  fetchCandles: async (registry, symbol, options) => {
    const response = await registry.binance.candles(binanceCandleProvider.resolveSymbol(symbol), options);
    return response.data as PriceCandle[];
  },
  fetchCandlesWithMeta: async (registry, symbol, options) => {
    const response = await registry.binance.candles(binanceCandleProvider.resolveSymbol(symbol), options);
    const f = response.meta?.freshness;
    return {
      candles: response.data as PriceCandle[],
      freshness: f
        ? { provider: 'binance', source: f.source, ageMs: f.ageMs, isStale: f.isStale }
        : null,
    };
  },
};

export const CANDLE_PROVIDERS: Record<CandleProviderKey, CandleProviderDescriptor> = {
  binance: binanceCandleProvider,
};
