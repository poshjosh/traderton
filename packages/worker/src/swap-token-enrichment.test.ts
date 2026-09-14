import { describe, it, expect, vi } from 'vitest';
import { enrichTokenWithDiscovery } from './swap-token-enrichment.js';
import type { ProviderRegistry, TokenInfo } from '@traderton/market-data';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToken(overrides: Partial<TokenInfo> = {}): TokenInfo {
  return {
    address: '0xabc',
    symbol: 'FOO',
    name: 'Foo Token',
    network: 'base',
    priceUsd: 1,
    volume24hUsd: 1000,
    liquidityUsd: 5000,
    priceChange24hPct: 0,
    dexId: 'uniswap',
    ...overrides,
  };
}

/**
 * Builds a minimal ProviderRegistry stub exposing only the surface
 * `enrichTokenWithDiscovery` touches (`dexscreener.search`, `discovery.discover`).
 */
function makeRegistry(overrides: {
  searchData?: TokenInfo[];
  searchThrows?: boolean;
  discoverData?: TokenInfo[];
  discoverThrows?: boolean;
} = {}): ProviderRegistry {
  const search = vi.fn(async () => {
    if (overrides.searchThrows) throw new Error('search boom');
    return { data: overrides.searchData ?? [] };
  });
  const discover = vi.fn(async () => {
    if (overrides.discoverThrows) throw new Error('discover boom');
    return { data: overrides.discoverData ?? [] };
  });
  return {
    dexscreener: { search },
    discovery: { discover },
  } as unknown as ProviderRegistry;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('enrichTokenWithDiscovery', () => {
  it('short-circuits when the match already has poolCreatedAt', async () => {
    const registry = makeRegistry();
    const match = makeToken({ poolCreatedAt: '2024-01-01T00:00:00.000Z' });

    const result = await enrichTokenWithDiscovery(registry, 'base', match.address, match);

    expect(result).toEqual({ ...match, ageResolution: 'available', hasRealMarketData: true });
    expect(registry.dexscreener.search).not.toHaveBeenCalled();
    expect(registry.discovery.discover).not.toHaveBeenCalled();
  });

  it('resolves poolCreatedAt from a direct DexScreener address match', async () => {
    const match = makeToken();
    const registry = makeRegistry({
      searchData: [makeToken({ poolCreatedAt: '2024-02-02T00:00:00.000Z' })],
    });

    const result = await enrichTokenWithDiscovery(registry, 'base', match.address, match);

    expect(result.poolCreatedAt).toBe('2024-02-02T00:00:00.000Z');
    expect(result.ageResolution).toBe('available');
    expect(result.hasRealMarketData).toBe(true);
    expect(registry.discovery.discover).not.toHaveBeenCalled();
  });

  it('marks indeterminate when a direct match lacks poolCreatedAt', async () => {
    const match = makeToken();
    const registry = makeRegistry({ searchData: [makeToken()] });

    const result = await enrichTokenWithDiscovery(registry, 'base', match.address, match);

    expect(result.poolCreatedAt).toBeUndefined();
    expect(result.ageResolution).toBe('indeterminate');
    expect(result.hasRealMarketData).toBe(true);
    expect(registry.discovery.discover).not.toHaveBeenCalled();
  });

  it('falls back to discovery when no direct match, resolving poolCreatedAt', async () => {
    const match = makeToken();
    const registry = makeRegistry({
      searchData: [],
      discoverData: [makeToken({ poolCreatedAt: '2024-03-03T00:00:00.000Z' })],
    });

    const result = await enrichTokenWithDiscovery(registry, 'base', match.address, match);

    expect(result.poolCreatedAt).toBe('2024-03-03T00:00:00.000Z');
    expect(result.ageResolution).toBe('available');
    expect(result.hasRealMarketData).toBe(true);
    expect(registry.discovery.discover).toHaveBeenCalledWith({
      networks: ['base'],
      maxResults: 250,
      minLiquidityUsd: 0,
    });
  });

  it('marks missing when discovery match lacks poolCreatedAt', async () => {
    const match = makeToken();
    const registry = makeRegistry({
      searchData: [],
      discoverData: [makeToken()],
    });

    const result = await enrichTokenWithDiscovery(registry, 'base', match.address, match);

    expect(result.ageResolution).toBe('missing');
    expect(result.hasRealMarketData).toBe(true);
  });

  it('marks indeterminate when discovery finds no match', async () => {
    const match = makeToken();
    const registry = makeRegistry({ searchData: [], discoverData: [] });

    const result = await enrichTokenWithDiscovery(registry, 'base', match.address, match);

    expect(result.ageResolution).toBe('indeterminate');
    expect(result.hasRealMarketData).toBe(true);
  });

  it('falls through to discovery when the direct search throws', async () => {
    const match = makeToken();
    const registry = makeRegistry({
      searchThrows: true,
      discoverData: [makeToken({ poolCreatedAt: '2024-04-04T00:00:00.000Z' })],
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await enrichTokenWithDiscovery(registry, 'base', match.address, match);

    expect(result.poolCreatedAt).toBe('2024-04-04T00:00:00.000Z');
    expect(registry.discovery.discover).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('returns indeterminate when the discovery lookup throws', async () => {
    const match = makeToken();
    const registry = makeRegistry({ searchData: [], discoverThrows: true });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await enrichTokenWithDiscovery(registry, 'base', match.address, match);

    expect(result.ageResolution).toBe('indeterminate');
    expect(result.hasRealMarketData).toBe(true);
    warnSpy.mockRestore();
  });
});
