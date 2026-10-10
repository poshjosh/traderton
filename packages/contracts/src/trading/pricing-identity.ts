/**
 * Identity needed to safely reprice a signal for hybrid USD-to-base-size conversion.
 * Perps use an execution mark (chain = 'hyperliquid' or 'bybit'); DEX assets require
 * chain + address to avoid ambiguous-ticker repricing.
 */
export interface HybridPricingIdentity {
  kind: 'perps' | 'dex';
  symbol: string;
  chain?: string;
  address?: string;
}