import type { AppConfig } from '@traderton/domain';
import type { StreamPoolHandle } from '@traderton/engine';
import { BybitPublicStream, HyperliquidPublicStream } from '@traderton/venues';
import type { VenueStreamConnector } from '@traderton/venues';

export function publicStreamVenueKey(venue: string, testnet: boolean): string {
  return `${venue}:${testnet ? 'testnet' : 'mainnet'}`;
}

export function buildPublicStreamConnectors(venues: AppConfig['venues']): Map<string, () => VenueStreamConnector> {
  const streamConnectors = new Map<string, () => VenueStreamConnector>();
  const hyperliquidVenueConfig = venues['hyperliquid'];
  const bybitVenueConfig = venues['bybit'];

  if (hyperliquidVenueConfig?.wsUrl) {
    const wsUrl = hyperliquidVenueConfig.wsUrl;
    streamConnectors.set(publicStreamVenueKey('hyperliquid', false), () => new HyperliquidPublicStream({ wsUrl }));
  }
  if (hyperliquidVenueConfig?.testnetWsUrl) {
    const wsUrl = hyperliquidVenueConfig.testnetWsUrl;
    streamConnectors.set(publicStreamVenueKey('hyperliquid', true), () => new HyperliquidPublicStream({ wsUrl }));
  }
  if (bybitVenueConfig?.wsPublicUrl) {
    const wsUrl = bybitVenueConfig.wsPublicUrl;
    streamConnectors.set(publicStreamVenueKey('bybit', false), () => new BybitPublicStream({ wsUrl }));
  }
  if (bybitVenueConfig?.wsTestnetPublicUrl) {
    const wsUrl = bybitVenueConfig.wsTestnetPublicUrl;
    streamConnectors.set(publicStreamVenueKey('bybit', true), () => new BybitPublicStream({ wsUrl }));
  }

  return streamConnectors;
}

export function createScopedStreamPoolHandle(
  pool: StreamPoolHandle | undefined,
  venue: string,
  testnet: boolean,
): StreamPoolHandle | undefined {
  if (!pool) {
    return undefined;
  }

  const scopedVenueKey = publicStreamVenueKey(venue, testnet);
  return {
    subscribe(_venue: string, symbols: string[], handlers) {
      return pool.subscribe(scopedVenueKey, symbols, handlers);
    },
  };
}