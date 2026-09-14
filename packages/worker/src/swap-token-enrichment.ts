import type { ProviderRegistry, TokenInfo } from '@traderton/market-data';
import type { ResolvedSwapTokenData } from './token-safety-adapter.js';

export async function enrichTokenWithDiscovery(
  registry: ProviderRegistry,
  network: string,
  resolvedAddress: string,
  match: TokenInfo,
): Promise<ResolvedSwapTokenData> {
  if ((match as TokenInfo & { poolCreatedAt?: string }).poolCreatedAt) {
    return { ...match, ageResolution: 'available', hasRealMarketData: true };
  }

  // Try a targeted DexScreener search by address first — this is a direct
  // lookup that returns poolCreatedAt when the upstream API provides it.
  try {
    const directResult = await registry.dexscreener.search(resolvedAddress);
    const directMatch = directResult.data.find((token) => (
      token.network.toLowerCase() === network.toLowerCase()
      && token.address.toLowerCase() === resolvedAddress.toLowerCase()
    ));
    if (directMatch) {
      const poolCreatedAt = (directMatch as TokenInfo & { poolCreatedAt?: string }).poolCreatedAt;
      return {
        ...match,
        poolCreatedAt: poolCreatedAt ?? (match as TokenInfo & { poolCreatedAt?: string }).poolCreatedAt,
        ageResolution: poolCreatedAt ? 'available' : 'indeterminate',
        hasRealMarketData: true,
      };
    }
  } catch (err) {
    // Fall through to discovery if the direct search fails.
    console.warn('[enrichTokenWithDiscovery] direct DexScreener search failed, falling back to discovery', { network, resolvedAddress, err });
  }

  try {
    // Discovery is a targeted lookup for a specific token address to find
    // poolCreatedAt.  minLiquidityUsd: 0 maximises the chance of finding the
    // token in any pool — safety thresholds are enforced downstream by
    // evaluateTokenSafety, not here.
    const discoveryResult = await registry.discovery.discover({
      networks: [network],
      maxResults: 250,
      minLiquidityUsd: 0,
    });
    const discoveryMatch = discoveryResult.data.find((token) => (
      token.network.toLowerCase() === network.toLowerCase()
      && token.address.toLowerCase() === resolvedAddress.toLowerCase()
    ));

    if (!discoveryMatch) {
      return { ...match, ageResolution: 'indeterminate', hasRealMarketData: true };
    }

    return {
      ...match,
      poolCreatedAt: discoveryMatch.poolCreatedAt ?? (match as TokenInfo & { poolCreatedAt?: string }).poolCreatedAt,
      ageResolution: discoveryMatch.poolCreatedAt ? 'available' : 'missing',
      hasRealMarketData: true,
    };
  } catch {
    console.warn('[enrichTokenWithDiscovery] discovery lookup failed for', { network, resolvedAddress });
    return { ...match, ageResolution: 'indeterminate', hasRealMarketData: true };
  }
}
