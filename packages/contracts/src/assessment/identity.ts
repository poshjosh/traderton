/** Canonical per-symbol assessment identity (transitive dep of the scanner wake, C1.4). */
import { z } from 'zod';

export type MarketAssessmentIdentity =
  | {
      instrumentKind: 'orderbook' | 'perp';
      venueFamily: string;
      styleTier: 'economy' | 'standard' | 'premium';
      symbol: string; // normalized, venue-canonical
    }
  | {
      instrumentKind: 'swap' | 'dex';
      venueFamily: string;
      styleTier: 'economy' | 'standard' | 'premium';
      network: string; // canonical chain id
      address: string; // canonical token address
    };

export const MarketAssessmentIdentitySchema = z.discriminatedUnion('instrumentKind', [
  z.object({
    instrumentKind: z.enum(['orderbook', 'perp']),
    venueFamily: z.string().min(1),
    styleTier: z.enum(['economy', 'standard', 'premium']),
    symbol: z.string().min(1),
  }),
  z.object({
    instrumentKind: z.enum(['swap', 'dex']),
    venueFamily: z.string().min(1),
    styleTier: z.enum(['economy', 'standard', 'premium']),
    network: z.string().min(1),
    address: z.string().min(1),
  }),
]);