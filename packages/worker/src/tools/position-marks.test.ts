import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  markOpenPositions,
  toPriceTarget,
  POSITION_MARK_BUDGET_MS,
  type MarkablePositionRow,
  type MarkPriceService,
} from './position-marks.js';

function row(overrides: Partial<MarkablePositionRow> = {}): MarkablePositionRow {
  return {
    venue: 'hyperliquid',
    symbol: 'BTC',
    side: 'long',
    size: '1',
    entryPrice: '100',
    closedAt: null,
    ...overrides,
  };
}

function priceServiceReturning(priceUsd: number, fetchedAt = '2024-01-01T00:00:00.000Z'): MarkPriceService {
  return {
    getPrice: vi.fn(async () => ({ ok: true, data: { priceUsd, source: 'oracle', fetchedAt, stale: false } })),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('toPriceTarget — venue→chain mapping', () => {
  it('maps hyperliquid to the hyperliquid chain', () => {
    expect(toPriceTarget(row({ venue: 'hyperliquid', symbol: 'BTC' }))).toEqual({ symbol: 'BTC', chain: 'hyperliquid' });
  });

  it('maps bybit to the bybit chain', () => {
    expect(toPriceTarget(row({ venue: 'bybit', symbol: 'ETH' }))).toEqual({ symbol: 'ETH', chain: 'bybit' });
  });

  it('maps jupiter to the solana chain', () => {
    expect(toPriceTarget(row({ venue: 'jupiter', symbol: 'SOL/USDC' }))).toEqual({ symbol: 'SOL', chain: 'solana' });
  });

  it('maps 1inch via operator chainId 8453 to base', () => {
    const target = toPriceTarget(row({ venue: '1inch', symbol: 'WETH/USDC' }), { chainId: 8453 });
    expect(target).toEqual({ symbol: 'WETH', chain: 'base' });
  });

  it('returns null for a 1inch position whose operator chainId does not map', () => {
    expect(toPriceTarget(row({ venue: '1inch', symbol: 'WETH/USDC' }), { chainId: 999999 })).toBeNull();
  });

  it('returns null for a 1inch position with no operator chain config', () => {
    expect(toPriceTarget(row({ venue: '1inch', symbol: 'WETH/USDC' }))).toBeNull();
  });

  it('returns null for an unknown venue', () => {
    expect(toPriceTarget(row({ venue: 'kraken', symbol: 'BTC' }))).toBeNull();
  });
});

describe('toPriceTarget — ticker/address derivation and quote guard', () => {
  it('derives the base ticker from a dashed perp symbol', () => {
    expect(toPriceTarget(row({ venue: 'hyperliquid', symbol: 'BTC-PERP' }))).toEqual({ symbol: 'BTC', chain: 'hyperliquid' });
  });

  it('accepts a USDC-quoted spot symbol and strips the quote', () => {
    expect(toPriceTarget(row({ venue: 'jupiter', symbol: 'SOL/USDC' }))).toEqual({ symbol: 'SOL', chain: 'solana' });
  });

  it('returns null when the quote is non-USD (SOL-quoted pair)', () => {
    expect(toPriceTarget(row({ venue: 'jupiter', symbol: 'BONK/SOL' }))).toBeNull();
  });

  it('allows a quote-less symbol on a USD-implicit perp venue', () => {
    expect(toPriceTarget(row({ venue: 'bybit', symbol: 'BTC' }))).toEqual({ symbol: 'BTC', chain: 'bybit' });
  });

  it('passes an on-chain address through as the address lookup', () => {
    const addr = '0x' + 'a'.repeat(40);
    const target = toPriceTarget(row({ venue: '1inch', symbol: addr }), { chainId: 8453 });
    expect(target).toEqual({ symbol: addr, chain: 'base', address: addr });
  });
});

describe('markOpenPositions — unrealized P&L maths', () => {
  it('marks a long position: (mark - entry) * size', async () => {
    const marked = await markOpenPositions([row({ side: 'long', size: '2', entryPrice: '100' })], {
      priceService: priceServiceReturning(150),
      budgetMs: POSITION_MARK_BUDGET_MS,
      now: new Date('2024-02-01T00:00:00.000Z'),
    });
    expect(marked[0]).toMatchObject({ markPrice: '150', unrealizedPnl: '100', markedAt: '2024-01-01T00:00:00.000Z' });
  });

  it('marks a short position: (entry - mark) * size', async () => {
    const marked = await markOpenPositions([row({ side: 'short', size: '3', entryPrice: '100' })], {
      priceService: priceServiceReturning(80),
      budgetMs: POSITION_MARK_BUDGET_MS,
      now: new Date('2024-02-01T00:00:00.000Z'),
    });
    // (100 - 80) * 3 = 60.
    expect(marked[0]).toMatchObject({ markPrice: '80', unrealizedPnl: '60' });
  });

  it('leaves closed and flat rows with null marks', async () => {
    const rows = [
      row({ side: 'long', closedAt: new Date('2024-01-05T00:00:00.000Z') }),
      row({ side: 'flat', size: '0' }),
    ];
    const marked = await markOpenPositions(rows, {
      priceService: priceServiceReturning(150),
      budgetMs: POSITION_MARK_BUDGET_MS,
      now: new Date(),
    });
    expect(marked[0]).toMatchObject({ markPrice: null, unrealizedPnl: null, markedAt: null });
    expect(marked[1]).toMatchObject({ markPrice: null, unrealizedPnl: null, markedAt: null });
  });

  it('yields null marks for every row when no priceService is provided', async () => {
    const marked = await markOpenPositions([row()], { budgetMs: POSITION_MARK_BUDGET_MS, now: new Date() });
    expect(marked[0]).toMatchObject({ markPrice: null, unrealizedPnl: null, markedAt: null });
  });
});

describe('markOpenPositions — dedupe', () => {
  it('performs one lookup for two rows on the same chain:symbol', async () => {
    const priceService = priceServiceReturning(120);
    const rows = [
      row({ venue: 'hyperliquid', symbol: 'BTC', size: '1' }),
      row({ venue: 'hyperliquid', symbol: 'BTC', size: '2' }),
    ];
    const marked = await markOpenPositions(rows, {
      priceService,
      budgetMs: POSITION_MARK_BUDGET_MS,
      now: new Date(),
    });
    expect(priceService.getPrice).toHaveBeenCalledTimes(1);
    // Same price, different sizes → different P&L. (120-100)*1 and (120-100)*2.
    expect(marked[0]).toMatchObject({ markPrice: '120', unrealizedPnl: '20' });
    expect(marked[1]).toMatchObject({ markPrice: '120', unrealizedPnl: '40' });
  });
});

describe('markOpenPositions — shared deadline', () => {
  it('nulls a slow lookup past the budget while still marking a fast one', async () => {
    vi.useFakeTimers();
    const priceService: MarkPriceService = {
      getPrice: vi.fn((symbol: string) => {
        if (symbol === 'SLOW') {
          return new Promise((resolve) => {
            setTimeout(() => resolve({ ok: true, data: { priceUsd: 999, source: 'oracle', fetchedAt: '2024-01-01T00:00:00.000Z', stale: false } }), 10_000);
          });
        }
        return Promise.resolve({ ok: true, data: { priceUsd: 150, source: 'oracle', fetchedAt: '2024-01-01T00:00:00.000Z', stale: false } });
      }),
    };

    const rows = [
      row({ venue: 'hyperliquid', symbol: 'FAST', side: 'long', size: '1', entryPrice: '100' }),
      row({ venue: 'hyperliquid', symbol: 'SLOW', side: 'long', size: '1', entryPrice: '100' }),
    ];

    const pending = markOpenPositions(rows, {
      priceService,
      budgetMs: 3_000,
      now: new Date('2024-02-01T00:00:00.000Z'),
    });

    // Advance past the shared deadline; the slow lookup never settles in time.
    await vi.advanceTimersByTimeAsync(3_001);
    const marked = await pending;

    expect(marked[0]).toMatchObject({ markPrice: '150', unrealizedPnl: '50' });
    expect(marked[1]).toMatchObject({ markPrice: null, unrealizedPnl: null, markedAt: null });
  });
});
