/** Scanner candle-target + swap-execution identity shapes (D2-b). */

/**
 * Identifies a candle source for scanner candle fetching.
 *
 * Orderbook targets route to Binance by provider symbol.
 * Swap targets route to GeckoTerminal by network + pool address.
 */
export type ScannerCandleTarget =
  | { venueType: 'orderbook'; providerSymbol: string }
  | { venueType: 'swap'; network: string; poolAddress: string };

/**
 * Exact on-chain identity for a DEX swap pair.
 *
 * Carried unchanged from discovery → candidate → signal → decision
 * so the execution layer receives address-qualified assets without
 * re-resolving a display symbol.
 */
export interface SwapExecutionIdentity {
  network: string;
  baseSymbol: string;
  baseAddress: string;
  quoteSymbol: string;
  quoteAddress: string;
}

/**
 * Derive a stable breaker key from a ScannerCandleTarget for use
 * with the cross-scan circuit breaker and other keyed maps.
 *
 * - orderbook: `orderbook:<providerSymbol>`
 * - swap:      `swap:<network>:<poolAddress>`
 */
export function scannerTargetKey(target: ScannerCandleTarget): string {
  if (target.venueType === 'orderbook') {
    return `orderbook:${target.providerSymbol}`;
  }
  return `swap:${target.network}:${target.poolAddress}`;
}