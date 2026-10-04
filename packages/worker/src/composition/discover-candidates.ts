// buildDiscoverCandidates — venue-aware scanner candidate discovery combiner
// (Wave E / E1-T T4). AUTHORED WIRING ONLY: it COMBINES the already-copied
// orderbook discovery (`discoverScannerCandidates`), swap discovery
// (`discoverSwapScannerCandidates`), and the normalize helper
// (`normalizeScannerCandidates`) into the single `discoverCandidates` closure
// the agent actor's copied scan loop expects. It re-implements none of their
// bodies — it only routes by venue family and applies the swap gating.
//
// Traced verbatim (structure + gating) to the herobids pre-extraction source:
//   git -C ../herobids show 45271d28^:apps/worker/src/index.ts
//   `buildDiscoverCandidates` (~L354–440).
// Divergences from the source, all driven by the Traderton config split:
//   - the shared market-data registry is read through a `getRegistry` accessor
//     (it is assigned in `createTradingRuntime().start()`, after this closure is
//     built), not captured as a module const;
//   - swap gating reads `config.agentScanner.swap.*` (T2 flattened herobids'
//     `agentRuntime.scanner.swap` to `agentScanner.swap`);
//   - `maxCandidates` comes from `config.marketData.<venue>.scanner` (capacity
//     source, unchanged).

import type { ProviderRegistry } from '@traderton/market-data';
import type { DiscoveredInstrument, FilterConfig } from '../technical-phase.js';
import { discoverScannerCandidates } from '../scanner-candidate-discovery.js';
import { discoverSwapScannerCandidates } from '../swap-candidate-discovery.js';
import { normalizeScannerCandidates } from '../scanner-pre-filter.js';
import type { createLogger } from '../logger.js';

type Logger = ReturnType<typeof createLogger>;

export interface BuildDiscoverCandidatesParams {
  /**
   * Accessor for the once-per-process market-data registry. It is undefined
   * until `createTradingRuntime().start()` constructs it (async), so the closure
   * reads it lazily on each scan rather than capturing a value that may still be
   * undefined at build time. No registry ⇒ no candidates (empty).
   */
  getRegistry: () => ProviderRegistry | undefined;
  bindingVenue: string;
  bindingVenueType: 'orderbook' | 'swap';
  /** Resolved token-safety network for swap venues (e.g. 'solana', 'base'). */
  swapNetwork?: string;
  /** Effective quote asset symbol for pool filtering (default 'USDC'). */
  swapQuoteAssetSymbol?: string;
  /** Effective quote asset address from canonical tokens for swap execution identity. */
  swapQuoteAssetAddress?: string;
  /** Whether swap scanning is enabled (master kill-switch + per-venue flag). */
  swapEnabled: boolean;
  /** Capacity source — `config.marketData.<venue>.scanner.maxCandidates`. */
  maxCandidates: number;
  logger: Logger;
}

/**
 * Build a venue-aware `discoverCandidates` closure for one agent actor.
 *
 * Orderbook venues (Hyperliquid, Bybit) use `discoverScannerCandidates` +
 * `normalizeScannerCandidates`. Swap venues (Jupiter, 1inch) use
 * `discoverSwapScannerCandidates` through the registry's discovery port, gated by
 * the operator swap flags; when disabled they return no candidates (identical to
 * pre-swap behaviour). Unrecognized venues are rejected with an explicit warning
 * — the scanner does not silently fall back to a different venue.
 */
export function buildDiscoverCandidates(
  params: BuildDiscoverCandidatesParams,
): (filters: FilterConfig) => Promise<DiscoveredInstrument[]> {
  const {
    getRegistry,
    bindingVenue,
    bindingVenueType,
    swapNetwork,
    swapQuoteAssetSymbol,
    swapQuoteAssetAddress,
    swapEnabled,
    maxCandidates,
    logger,
  } = params;

  // ── Orderbook path ──────────────────────────────────────────────────────
  if (bindingVenueType === 'orderbook') {
    if (bindingVenue !== 'hyperliquid' && bindingVenue !== 'bybit') {
      logger.warn(
        { venue: bindingVenue },
        'Scanner discovery: unsupported orderbook venue — returning empty candidates',
      );
      return async (_filters: FilterConfig) => [];
    }
    const venue: 'hyperliquid' | 'bybit' = bindingVenue;
    return async (filters: FilterConfig) => {
      const registry = getRegistry();
      if (!registry) return [];
      if (!filters) return [];
      const discovered = await discoverScannerCandidates({
        registry,
        filters,
        bindingVenue: venue,
        bindingVenueType: 'orderbook',
        maxCandidates,
      });
      const { supported, unsupportedCount } = normalizeScannerCandidates(discovered);
      if (unsupportedCount > 0) {
        logger.info(
          { venue, discovered: discovered.length, supported: supported.length, unsupported: unsupportedCount },
          'Scanner normalize dropped unresolvable orderbook candidates',
        );
      }
      return supported;
    };
  }

  // ── Swap path ───────────────────────────────────────────────────────────
  // Gate: when swap scanning is disabled, return no candidates.
  if (!swapEnabled || !swapNetwork || (bindingVenue !== 'jupiter' && bindingVenue !== '1inch')) {
    logger.info(
      { bindingVenue, swapEnabled, swapNetwork },
      'Swap scanner discovery disabled — returning empty candidates',
    );
    return async (_filters: FilterConfig) => [];
  }

  const venue: 'jupiter' | '1inch' = bindingVenue;
  const quoteAssetSymbol = swapQuoteAssetSymbol ?? 'USDC';
  // Startup validation guarantees swapQuoteAssetAddress is resolved when we reach
  // this path, but warn if it is missing anyway (defensive — matches source).
  if (!swapQuoteAssetAddress) {
    logger.warn(
      { venue },
      'Swap scanner: swapQuoteAssetAddress is undefined — quote address cross-validation is disabled',
    );
  }
  return async (filters: FilterConfig) => {
    const registry = getRegistry();
    if (!registry) return [];
    if (!filters) return [];
    return discoverSwapScannerCandidates({
      discovery: registry.discovery,
      venue,
      swapNetwork,
      quoteAssetSymbol,
      quoteAssetAddress: swapQuoteAssetAddress,
      filters,
      maxCandidates,
      logger,
    });
  };
}
