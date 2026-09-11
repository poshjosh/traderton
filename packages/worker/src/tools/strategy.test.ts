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

function makeContext(
  fetcher?: (target: ScannerCandleTarget, interval: string, limit: number) => Promise<PriceCandle[]>,
): TradingToolContext {
  return {
    agentId: 'agent-strategy-test',
    sessionId: 'session-strategy-test',
    executionMode: 'paper',
    authorizationMode: 'direct',
    redis: {} as TradingToolContext['redis'],
    publishToInbound: async () => undefined,
    scannerCandleFetcher: fetcher,
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

  it('rejects a swap request missing network/poolAddress', async () => {
    const fetcher = vi.fn(async () => makeCandles(120));
    const result = await scoreCandidateTool!.execute(
      { symbol: 'x', venueType: 'swap', config: baseConfig },
      makeContext(fetcher),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('network and poolAddress are required');
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
});
