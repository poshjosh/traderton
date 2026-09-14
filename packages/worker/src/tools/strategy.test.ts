import { describe, expect, it, vi } from 'vitest';
import type { TradingToolContext } from '@traderton/domain';
import type { ScannerCandleTarget } from '@traderton/domain';
import type { PriceCandle } from '@traderton/market-data';
import { strategyTools } from './strategy.js';

const scoreCandidateTool = strategyTools.find((t) => t.name === 'score_candidate');

// A minimal set of candles sufficient for scoreCandidate to run its indicators.
function makeCandles(n: number): PriceCandle[] {
  const out: PriceCandle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    price += 1; // steady uptrend so trend-following indicators can compute
    out.push({
      timestamp: new Date(1_700_000_000_000 + i * 3_600_000).toISOString(),
      open: price - 1,
      high: price + 0.5,
      low: price - 1.5,
      close: price,
      volume: 1000 + i,
    } as unknown as PriceCandle);
  }
  return out;
}

type PoolResolver = (
  network: string,
  tokenAddress: string,
) => Promise<Array<{ poolAddress: string; network: string; liquidityUsd: number; volume24hUsd: number }>>;

function makeContext(
  fetcher?: (target: ScannerCandleTarget, interval: string, limit: number) => Promise<PriceCandle[]>,
  poolResolver?: PoolResolver,
): TradingToolContext {
  return {
    agentId: 'agent-strategy-test',
    sessionId: 'session-strategy-test',
    executionMode: 'paper',
    authorizationMode: 'direct',
    redis: {} as TradingToolContext['redis'],
    publishToInbound: async () => undefined,
    scannerCandleFetcher: fetcher,
    scannerPoolResolver: poolResolver,
  } as TradingToolContext;
}

const baseConfig = {
  indicators: {},
  signalBias: 'trend-following' as const,
};

describe('score_candidate tool', () => {
  it('is registered read-only (read-market-data category)', () => {
    expect(scoreCandidateTool).toBeDefined();
    expect(scoreCandidateTool!.category).toBe('read-market-data');
  });

  it('fetches candles behind the boundary for an ORDERBOOK target and returns a signal shape', async () => {
    const fetcher = vi.fn(async () => makeCandles(120));
    const result = await scoreCandidateTool!.execute(
      {
        symbol: 'BTC',
        venueType: 'orderbook',
        providerSymbol: 'BTCUSDT',
        interval: '1h',
        candleLimit: 120,
        config: baseConfig,
      },
      makeContext(fetcher),
    );

    // Candle fetch happened behind the boundary with the orderbook target.
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toEqual({ venueType: 'orderbook', providerSymbol: 'BTCUSDT' });
    expect(fetcher.mock.calls[0]![1]).toBe('1h');
    expect(fetcher.mock.calls[0]![2]).toBe(120);

    expect(result.success).toBe(true);
    // signal is present or null — both are valid read outcomes; data carries it.
    expect(result.data).toHaveProperty('signal');
    expect(result.data).toHaveProperty('candlesEvaluated', 120);
    // Derived candle-window: first/last timestamps of the fetched series (metadata only).
    const candles = makeCandles(120);
    expect(result.data).toHaveProperty('candleWindow', {
      start: candles[0]!.timestamp,
      end: candles[candles.length - 1]!.timestamp,
    });
  });

  it('fetches candles behind the boundary for a SWAP target (network + poolAddress)', async () => {
    const fetcher = vi.fn(async () => makeCandles(80));
    const result = await scoreCandidateTool!.execute(
      {
        symbol: 'ethereum:0xpool',
        venueType: 'swap',
        network: 'ethereum',
        poolAddress: '0xpool',
        config: baseConfig,
      },
      makeContext(fetcher),
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toEqual({ venueType: 'swap', network: 'ethereum', poolAddress: '0xpool' });
    expect(result.success).toBe(true);
  });

  it('passes a null signal through as a valid read result (not an error)', async () => {
    // Too few candles → scoreCandidate returns null (no signal).
    const fetcher = vi.fn(async () => makeCandles(3));
    const result = await scoreCandidateTool!.execute(
      { symbol: 'BTC', venueType: 'orderbook', providerSymbol: 'BTCUSDT', config: baseConfig },
      makeContext(fetcher),
    );
    expect(result.success).toBe(true);
    expect((result.data as { signal: unknown }).signal).toBeNull();
  });

  it('derives a null candleWindow when zero candles are fetched', async () => {
    const fetcher = vi.fn(async () => [] as PriceCandle[]);
    const result = await scoreCandidateTool!.execute(
      { symbol: 'BTC', venueType: 'orderbook', providerSymbol: 'BTCUSDT', config: baseConfig },
      makeContext(fetcher),
    );
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty('candlesEvaluated', 0);
    expect((result.data as { candleWindow: unknown }).candleWindow).toBeNull();
  });

  it('degrades to market_data_not_configured when no candle fetcher is wired', async () => {
    const result = await scoreCandidateTool!.execute(
      { symbol: 'BTC', venueType: 'orderbook', providerSymbol: 'BTCUSDT', config: baseConfig },
      makeContext(undefined),
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('market_data_not_configured');
  });

  it('rejects an orderbook request missing providerSymbol', async () => {
    const fetcher = vi.fn(async () => makeCandles(120));
    const result = await scoreCandidateTool!.execute(
      { symbol: 'BTC', venueType: 'orderbook', config: baseConfig },
      makeContext(fetcher),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('providerSymbol is required');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects a swap request missing network', async () => {
    const fetcher = vi.fn(async () => makeCandles(120));
    const result = await scoreCandidateTool!.execute(
      { symbol: 'x', venueType: 'swap', config: baseConfig },
      makeContext(fetcher),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('network is required');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects a swap request with network but neither poolAddress nor tokenAddress', async () => {
    const fetcher = vi.fn(async () => makeCandles(120));
    const result = await scoreCandidateTool!.execute(
      { symbol: 'x', venueType: 'swap', network: 'solana', config: baseConfig },
      makeContext(fetcher),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('poolAddress or tokenAddress is required');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('maps rate-limit errors to a retryable failure', async () => {
    const fetcher = vi.fn(async () => { throw new Error('Rate limit exceeded'); });
    const result = await scoreCandidateTool!.execute(
      { symbol: 'BTC', venueType: 'orderbook', providerSymbol: 'BTCUSDT', config: baseConfig },
      makeContext(fetcher),
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('rate_limit');
    expect(result.retryable).toBe(true);
  });

  // ── swap-token resolution (network + tokenAddress, no pool) ──────────────────

  it('resolves a swap token to its top-liquidity pool, then fetches candles for that pool and scores', async () => {
    const fetcher = vi.fn(async () => makeCandles(120));
    const poolResolver = vi.fn(async () => [
      { poolAddress: 'pool-low', network: 'solana', liquidityUsd: 5_000, volume24hUsd: 90_000 },
      { poolAddress: 'pool-high', network: 'solana', liquidityUsd: 50_000, volume24hUsd: 1_000 },
    ]);

    const result = await scoreCandidateTool!.execute(
      {
        symbol: 'solana:0xToken',
        venueType: 'swap',
        network: 'solana',
        tokenAddress: '0xToken',
        config: baseConfig,
      },
      makeContext(fetcher, poolResolver),
    );

    // Pool resolution happened behind the boundary with the token identity.
    expect(poolResolver).toHaveBeenCalledTimes(1);
    expect(poolResolver.mock.calls[0]![0]).toBe('solana');
    expect(poolResolver.mock.calls[0]![1]).toBe('0xToken');

    // The highest-liquidity pool was selected and its candles fetched via the swap target.
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toEqual({ venueType: 'swap', network: 'solana', poolAddress: 'pool-high' });

    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty('signal');
    expect(result.data).toHaveProperty('candlesEvaluated', 120);
    const resolvedCandles = makeCandles(120);
    expect(result.data).toHaveProperty('candleWindow', {
      start: resolvedCandles[0]!.timestamp,
      end: resolvedCandles[resolvedCandles.length - 1]!.timestamp,
    });
  });

  it('tie-breaks equal liquidity by volume24h desc, then poolAddress lexicographic', async () => {
    const fetcher = vi.fn(async () => makeCandles(80));
    // Two pools tie on liquidity; higher volume wins. A third with same liquidity+volume
    // would tie-break lexicographically — covered by ordering pool-b before pool-a.
    const poolResolver = vi.fn(async () => [
      { poolAddress: 'pool-b', network: 'solana', liquidityUsd: 10_000, volume24hUsd: 500 },
      { poolAddress: 'pool-a', network: 'solana', liquidityUsd: 10_000, volume24hUsd: 500 },
      { poolAddress: 'pool-vol', network: 'solana', liquidityUsd: 10_000, volume24hUsd: 999 },
    ]);

    await scoreCandidateTool!.execute(
      { symbol: 'solana:0xT', venueType: 'swap', network: 'solana', tokenAddress: '0xT', config: baseConfig },
      makeContext(fetcher, poolResolver),
    );

    // Highest volume among the liquidity-tie wins.
    expect(fetcher.mock.calls[0]![0]).toEqual({ venueType: 'swap', network: 'solana', poolAddress: 'pool-vol' });
  });

  it('filters resolved pools to the target network case-insensitively before selecting', async () => {
    const fetcher = vi.fn(async () => makeCandles(80));
    const poolResolver = vi.fn(async () => [
      // Higher liquidity but wrong network — must be excluded.
      { poolAddress: 'pool-eth', network: 'ethereum', liquidityUsd: 999_999, volume24hUsd: 1 },
      { poolAddress: 'pool-sol', network: 'SOLANA', liquidityUsd: 10_000, volume24hUsd: 1 },
    ]);

    await scoreCandidateTool!.execute(
      { symbol: 'solana:0xT', venueType: 'swap', network: 'solana', tokenAddress: '0xT', config: baseConfig },
      makeContext(fetcher, poolResolver),
    );

    expect(fetcher.mock.calls[0]![0]).toEqual({ venueType: 'swap', network: 'solana', poolAddress: 'pool-sol' });
  });

  it('returns swap_pool_unresolved (clean, non-retryable, non-fault) when no pool resolves', async () => {
    const fetcher = vi.fn(async () => makeCandles(80));
    const poolResolver = vi.fn(async () => []);

    const result = await scoreCandidateTool!.execute(
      { symbol: 'solana:0xT', venueType: 'swap', network: 'solana', tokenAddress: '0xT', config: baseConfig },
      makeContext(fetcher, poolResolver),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('swap_pool_unresolved');
    expect(result.retryable).toBe(false);
    expect(result.fault).toBe(false);
    // No candle fetch when the pool cannot be resolved.
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('degrades to market_data_not_configured for a swap token when the pool resolver is not wired', async () => {
    const fetcher = vi.fn(async () => makeCandles(80));
    const result = await scoreCandidateTool!.execute(
      { symbol: 'solana:0xT', venueType: 'swap', network: 'solana', tokenAddress: '0xT', config: baseConfig },
      makeContext(fetcher, undefined),
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('market_data_not_configured');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('still supports the Option-A swap poolAddress path (no resolver needed)', async () => {
    const fetcher = vi.fn(async () => makeCandles(80));
    const poolResolver = vi.fn(async () => []);
    const result = await scoreCandidateTool!.execute(
      { symbol: 'ethereum:0xpool', venueType: 'swap', network: 'ethereum', poolAddress: '0xpool', config: baseConfig },
      makeContext(fetcher, poolResolver),
    );
    expect(result.success).toBe(true);
    // Direct pool path does not consult the resolver.
    expect(poolResolver).not.toHaveBeenCalled();
    expect(fetcher.mock.calls[0]![0]).toEqual({ venueType: 'swap', network: 'ethereum', poolAddress: '0xpool' });
  });
});
