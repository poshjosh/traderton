import { VenueCandleFetcher } from '@traderton/venues';
import { TokenBucketRateLimiter } from '@traderton/market-data';
import type { BinanceCandlesConfig, PriceCandle, GeckoTerminalConfig, MarketDataConfig } from '@traderton/market-data';
import type { ScannerCandleTarget } from '@traderton/domain';

/**
 * Create a scanner candle fetcher that wraps VenueCandleFetcher with
 * per-worker scanner rate limiters. The returned function accepts an explicit
 * {@link ScannerCandleTarget} — no venue-global assumptions about the provider
 * symbol are baked in.
 *
 * Orderbook targets route to Binance via a pre-constructed VenueCandleFetcher.
 * Swap targets construct a per-call VenueCandleFetcher with the target's
 * network and the shared GeckoTerminal config, then fetch by poolAddress.
 */
export function createScannerCandleFetcher(params: {
  binanceConfig: BinanceCandlesConfig;
  geckoTerminalConfig: GeckoTerminalConfig;
  scannerRateLimiter: TokenBucketRateLimiter;
  geckoTerminalRateLimiter: TokenBucketRateLimiter;
}): (target: ScannerCandleTarget, interval: string, limit: number) => Promise<PriceCandle[]> {
  const { binanceConfig, geckoTerminalConfig, scannerRateLimiter, geckoTerminalRateLimiter } = params;

  // Orderbook fetcher — re-used for all orderbook targets (Binance provider-symbol routing).
  const orderbookFetcher = new VenueCandleFetcher(
    binanceConfig,
    null,
    'orderbook',
  );

  return async (target: ScannerCandleTarget, interval: string, limit: number) => {
    if (target.venueType === 'swap') {
      await geckoTerminalRateLimiter.acquire();
      // Per-call fetcher because network varies per swap candidate.
      const swapFetcher = new VenueCandleFetcher(
        binanceConfig,
        { config: geckoTerminalConfig, network: target.network },
        'swap',
      );
      return swapFetcher.fetchCandles(target.poolAddress, interval, limit);
    }

    // Orderbook target
    await scannerRateLimiter.acquire();
    return orderbookFetcher.fetchCandles(target.providerSymbol, interval, limit);
  };
}

/**
 * Build a scanner candle fetcher directly from the resolved `marketData` config.
 * Convenience wrapper over {@link createScannerCandleFetcher} that constructs the
 * Binance + GeckoTerminal candle configs and their rate limiters from config, so
 * composition roots (e.g. the boundary) don't need to depend on the market-data
 * package's rate-limiter internals. Returns undefined-safe values only for a
 * present config; callers guard on `marketData` themselves.
 */
export function createScannerCandleFetcherFromConfig(
  marketData: MarketDataConfig,
): (target: ScannerCandleTarget, interval: string, limit: number) => Promise<PriceCandle[]> {
  const binanceConfig: BinanceCandlesConfig = {
    baseUrl: marketData.binance.baseUrl,
    rateLimiter: new TokenBucketRateLimiter({
      requestsPerMinute: marketData.binance.requestsPerMinute,
      maxWaitMs: marketData.binance.maxWaitMs,
    }),
    timeoutMs: marketData.binance.maxWaitMs,
  };
  const geckoTerminalConfig: GeckoTerminalConfig = {
    baseUrl: marketData.geckoterminal.baseUrl,
    proBaseUrl: marketData.geckoterminal.proBaseUrl,
    apiKey: marketData.geckoterminal.apiKey,
    rateLimiter: new TokenBucketRateLimiter({
      requestsPerMinute: marketData.geckoterminal.candles.requestsPerMinute,
      maxWaitMs: marketData.geckoterminal.candles.maxWaitMs,
    }),
    timeoutMs: marketData.geckoterminal.candles.maxWaitMs ?? 10_000,
  };
  return createScannerCandleFetcher({
    binanceConfig,
    geckoTerminalConfig,
    scannerRateLimiter: new TokenBucketRateLimiter({
      requestsPerMinute: marketData.binance.requestsPerMinute,
      maxWaitMs: marketData.binance.maxWaitMs,
    }),
    geckoTerminalRateLimiter: new TokenBucketRateLimiter({
      requestsPerMinute: marketData.geckoterminal.candles.requestsPerMinute,
      maxWaitMs: marketData.geckoterminal.candles.maxWaitMs,
    }),
  });
}
