import { VenueCandleFetcher } from '@traderton/venues';
import { TokenBucketRateLimiter, fetchGeckoTerminalPoolsForToken } from '@traderton/market-data';
import type { BinanceCandlesConfig, PriceCandle, GeckoTerminalConfig, MarketDataConfig, DiscoveredPool } from '@traderton/market-data';
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
  // NOTE: createScannerCandleFetcher acquires its scanner limiter AND the fetch
  // then acquires the config's own rate-limiter — two acquisitions per fetch.
  // That double-acquire is inherent to the (copied) createScannerCandleFetcher /
  // VenueCandleFetcher design and is NOT re-authored here. Effect: effective
  // candle throughput is ~half the configured budget. Tracked as a follow-up
  // (share one bucket per provider inside createScannerCandleFetcher) rather than
  // fixed here, to keep this a thin config→fetcher adapter (copy-never-author).
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

/**
 * Build a swap token→pools resolver directly from the resolved `marketData`
 * config. Companion to {@link createScannerCandleFetcherFromConfig}: it threads
 * the SAME GeckoTerminal config (network + token address → its DEX pools) so the
 * `score_candidate` swap arm can resolve a held token to a pool BEHIND the
 * boundary, then hand the pool to the candle fetcher. Composition roots (the
 * boundary) guard on `marketData` themselves.
 *
 * Kept a separate limiter from the candle fetcher's — the token-pools point
 * lookup and the candle fetch are distinct GeckoTerminal calls (same double-
 * acquire caveat noted on {@link createScannerCandleFetcherFromConfig}).
 */
export function createScannerPoolResolverFromConfig(
  marketData: MarketDataConfig,
): (network: string, tokenAddress: string) => Promise<DiscoveredPool[]> {
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
  return (network: string, tokenAddress: string) =>
    fetchGeckoTerminalPoolsForToken(network, tokenAddress, geckoTerminalConfig);
}
