import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '@traderton/domain';
import { priceTools, validateSymbolForChain, isOnChainAddress } from './price.js';

const getPriceTool = priceTools.find((tool) => tool.name === 'get_price');
const resolvePriceTargetTool = priceTools.find((tool) => tool.name === 'resolve_price_target');

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'agent-price-test',
    sessionId: 'session-price-test',
    redis: {
      hset: vi.fn(async () => 1),
      hget: vi.fn(async () => null),
      hgetall: vi.fn(async () => null),
      hdel: vi.fn(async () => 0),
      publish: vi.fn(async () => 1),
    },
    publishToInbound: vi.fn(async () => undefined),
    ...overrides,
  } as ToolContext;
}

describe('validateSymbolForChain', () => {
  it('rejects address-like identifiers for hyperliquid lookups', () => {
    expect(validateSymbolForChain('0x1234567890123456789012345678901234567890', 'hyperliquid')).toContain('hyperliquid');
  });

  it('rejects Solana mint-like identifiers for EVM lookups', () => {
    expect(validateSymbolForChain('So11111111111111111111111111111111111111112', 'ethereum')).toContain('ethereum');
  });

  it('accepts tickers for hyperliquid and Solana', () => {
    expect(validateSymbolForChain('BTC-PERP', 'hyperliquid')).toBeNull();
    expect(validateSymbolForChain('BONK', 'solana')).toBeNull();
  });

  it('rejects address-shaped symbols when chain is any', () => {
    expect(validateSymbolForChain('0x6982508145454Ce325dDbE47a25d4ec3d2311933', 'any')).toContain('explicit chain');
    expect(validateSymbolForChain('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'any')).toContain('explicit chain');
  });

  it('accepts plain tickers when chain is any', () => {
    expect(validateSymbolForChain('BTC', 'any')).toBeNull();
    expect(validateSymbolForChain('SOL', 'any')).toBeNull();
  });
});

describe('get_price tool', () => {
  it('rejects invalid symbol formats before calling the price service', async () => {
    const getPrice = vi.fn();
    const result = await getPriceTool!.execute(
      { symbol: 'So11111111111111111111111111111111111111112', chain: 'ethereum' },
      makeContext({ priceService: { getPrice } }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('ethereum');
    expect(getPrice).not.toHaveBeenCalled();
  });

  it('returns the shared price-service payload for valid lookups', async () => {
    const result = await getPriceTool!.execute(
      { symbol: 'SOL', chain: 'solana' },
      makeContext({
        priceService: {
          getPrice: vi.fn().mockResolvedValue({
            ok: true,
            data: {
              priceUsd: 155,
              source: 'oracle',
              fetchedAt: '2026-06-09T00:00:00.000Z',
              stale: false,
            },
          }),
        },
      }),
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      ok: true,
      symbol: 'SOL',
      chain: 'solana',
      priceUsd: 155,
      source: 'oracle',
      stale: false,
    });
  });

  it('passes address-shaped symbol as address argument for identity-aware lookup', async () => {
    const evmAddress = '0x6982508145454Ce325dDbE47a25d4ec3d2311933';
    const getPrice = vi.fn().mockResolvedValue({
      ok: true,
      data: { priceUsd: 0.00001, source: 'oracle', fetchedAt: '2026-06-09T00:00:00.000Z', stale: false },
    });

    const result = await getPriceTool!.execute(
      { symbol: evmAddress, chain: 'ethereum' },
      makeContext({ priceService: { getPrice } }),
    );

    expect(result.success).toBe(true);
    // Must pass the address as 3rd argument so the price service uses strict identity
    expect(getPrice).toHaveBeenCalledWith(evmAddress, 'ethereum', evmAddress);
  });

  it('passes Solana mint as address argument for identity-aware lookup', async () => {
    const mint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    const getPrice = vi.fn().mockResolvedValue({
      ok: true,
      data: { priceUsd: 0.00002, source: 'oracle', fetchedAt: '2026-06-09T00:00:00.000Z', stale: false },
    });

    const result = await getPriceTool!.execute(
      { symbol: mint, chain: 'solana' },
      makeContext({ priceService: { getPrice } }),
    );

    expect(result.success).toBe(true);
    expect(getPrice).toHaveBeenCalledWith(mint, 'solana', mint);
  });

  it('does not pass address for plain ticker symbols', async () => {
    const getPrice = vi.fn().mockResolvedValue({
      ok: true,
      data: { priceUsd: 67000, source: 'execution', fetchedAt: '2026-06-09T00:00:00.000Z', stale: false },
    });

    await getPriceTool!.execute(
      { symbol: 'BTC', chain: 'hyperliquid' },
      makeContext({ priceService: { getPrice } }),
    );

    expect(getPrice).toHaveBeenCalledWith('BTC', 'hyperliquid', undefined);
  });
});

describe('resolve_price_target tool', () => {
  it('rejects invalid symbol formats before calling the price service', async () => {
    const resolvePriceTarget = vi.fn();
    const result = await resolvePriceTargetTool!.execute(
      { symbol: 'So11111111111111111111111111111111111111112', chain: 'ethereum' },
      makeContext({ priceService: { resolvePriceTarget } }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('ethereum');
    expect(resolvePriceTarget).not.toHaveBeenCalled();
  });

  it('fails when the price service is not configured', async () => {
    const result = await resolvePriceTargetTool!.execute(
      { symbol: 'SOL', chain: 'solana' },
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('price_service_not_configured');
  });

  it('calls resolvePriceTarget and surfaces the RESOLVED identity, not the input echo', async () => {
    const resolvePriceTarget = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        symbol: 'PEPE',
        chain: 'ethereum',
        address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933',
        name: 'Pepe',
        priceUsd: 0.00001,
        source: 'oracle',
        fetchedAt: '2026-06-09T00:00:00.000Z',
        stale: false,
      },
    });

    const result = await resolvePriceTargetTool!.execute(
      { symbol: 'PEPE', chain: 'any' },
      makeContext({ priceService: { resolvePriceTarget } }),
    );

    expect(resolvePriceTarget).toHaveBeenCalledWith('PEPE', 'any', undefined);
    expect(result.success).toBe(true);
    // Resolved fields come from result.data, not the requested symbol/chain.
    expect(result.data).toMatchObject({
      ok: true,
      symbol: 'PEPE',
      chain: 'ethereum',
      address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933',
      name: 'Pepe',
      priceUsd: 0.00001,
      source: 'oracle',
      stale: false,
    });
  });

  it('passes address-shaped symbol as address argument for identity-aware lookup', async () => {
    const evmAddress = '0x6982508145454Ce325dDbE47a25d4ec3d2311933';
    const resolvePriceTarget = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        symbol: 'PEPE',
        chain: 'ethereum',
        address: evmAddress,
        priceUsd: 0.00001,
        source: 'oracle',
        fetchedAt: '2026-06-09T00:00:00.000Z',
        stale: false,
      },
    });

    const result = await resolvePriceTargetTool!.execute(
      { symbol: evmAddress, chain: 'ethereum' },
      makeContext({ priceService: { resolvePriceTarget } }),
    );

    expect(result.success).toBe(true);
    expect(resolvePriceTarget).toHaveBeenCalledWith(evmAddress, 'ethereum', evmAddress);
  });

  it('passes Solana mint as address argument for identity-aware lookup', async () => {
    const mint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    const resolvePriceTarget = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        symbol: 'BONK',
        chain: 'solana',
        address: mint,
        priceUsd: 0.00002,
        source: 'oracle',
        fetchedAt: '2026-06-09T00:00:00.000Z',
        stale: false,
      },
    });

    const result = await resolvePriceTargetTool!.execute(
      { symbol: mint, chain: 'solana' },
      makeContext({ priceService: { resolvePriceTarget } }),
    );

    expect(result.success).toBe(true);
    expect(resolvePriceTarget).toHaveBeenCalledWith(mint, 'solana', mint);
  });

  it('does not pass address for plain ticker symbols', async () => {
    const resolvePriceTarget = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        symbol: 'BTC',
        chain: 'hyperliquid',
        priceUsd: 67000,
        source: 'execution',
        fetchedAt: '2026-06-09T00:00:00.000Z',
        stale: false,
      },
    });

    await resolvePriceTargetTool!.execute(
      { symbol: 'BTC', chain: 'hyperliquid' },
      makeContext({ priceService: { resolvePriceTarget } }),
    );

    expect(resolvePriceTarget).toHaveBeenCalledWith('BTC', 'hyperliquid', undefined);
  });

  it('forwards an EXPLICIT pinned address alongside the ticker symbol (exact-identity pin)', async () => {
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const resolvePriceTarget = vi.fn().mockResolvedValue({
      ok: true,
      data: { symbol: 'USDC', chain: 'solana', address: mint, name: 'USD Coin', priceUsd: 1, source: 'oracle', fetchedAt: '2026-09-12T00:00:00Z', stale: false },
    });

    // Caller pins the exact asset: ticker 'USDC' + explicit address. Both must
    // reach the resolver (search by ticker, prefer the address match) — NOT
    // collapsed to address-as-symbol.
    await resolvePriceTargetTool!.execute(
      { symbol: 'USDC', chain: 'solana', address: mint },
      makeContext({ priceService: { resolvePriceTarget } }),
    );

    expect(resolvePriceTarget).toHaveBeenCalledWith('USDC', 'solana', mint);
  });

  it('maps a source failure to a retryable error without faulting', async () => {
    const resolvePriceTarget = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'price.source_failed', message: 'oracle unavailable' },
    });

    const result = await resolvePriceTargetTool!.execute(
      { symbol: 'SOL', chain: 'solana' },
      makeContext({ priceService: { resolvePriceTarget } }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('oracle unavailable');
    expect(result.retryable).toBe(true);
    expect(result.fault).toBe(false);
  });

  it('maps a non-retryable lookup failure', async () => {
    const resolvePriceTarget = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'price.not_found', message: 'not found' },
    });

    const result = await resolvePriceTargetTool!.execute(
      { symbol: 'SOL', chain: 'solana' },
      makeContext({ priceService: { resolvePriceTarget } }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('not found');
    expect(result.retryable).toBe(false);
    expect(result.fault).toBe(false);
  });

  it('handles malformed price-service responses', async () => {
    const resolvePriceTarget = vi.fn().mockResolvedValue(null);

    const result = await resolvePriceTargetTool!.execute(
      { symbol: 'SOL', chain: 'solana' },
      makeContext({ priceService: { resolvePriceTarget } }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('price lookup failed');
    expect(result.fault).toBe(false);
  });
});

describe('isOnChainAddress', () => {
  it('detects EVM addresses on EVM chains', () => {
    expect(isOnChainAddress('0x6982508145454Ce325dDbE47a25d4ec3d2311933', 'ethereum')).toBe(true);
    expect(isOnChainAddress('0x6982508145454Ce325dDbE47a25d4ec3d2311933', 'bsc')).toBe(true);
  });

  it('detects Solana mints on solana chain', () => {
    expect(isOnChainAddress('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'solana')).toBe(true);
  });

  it('does not flag tickers as addresses', () => {
    expect(isOnChainAddress('BTC', 'hyperliquid')).toBe(false);
    expect(isOnChainAddress('SOL', 'solana')).toBe(false);
    expect(isOnChainAddress('PEPE', 'ethereum')).toBe(false);
  });

  it('does not flag Solana mints on non-solana chains', () => {
    expect(isOnChainAddress('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'ethereum')).toBe(false);
  });
});