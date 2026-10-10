/** Canonical watch types — WatchEntry and related identity/coverage shapes. */
import { z } from 'zod';
import { WatchPurposeEnum } from './watch-purpose.js';
import type { WatchPurpose } from './watch-purpose.js';

// ---------------------------------------------------------------------------
// Instrument identity
// ---------------------------------------------------------------------------

/** Canonical venue + instrument identity resolved from the trading system's instrument repository. */
export interface WatchInstrumentIdentity {
  venue: string;
  instrumentId: string;
  symbol: string;
  chain?: string;
  address?: string;
}

// ---------------------------------------------------------------------------
// Purpose and coverage metadata
// ---------------------------------------------------------------------------

/** Links a watch to a specific actor, position, or intent group for coverage tracking. */
export interface WatchCoverageLink {
  actorType?: 'agent' | 'bot' | 'user' | 'system';
  actorId?: string;
  positionKey?: string;
  intentGroup?: string;
}

// ---------------------------------------------------------------------------
// Canonical WatchEntry
// ---------------------------------------------------------------------------

export interface WatchEntry {
  watchId: string;
  symbol: string;
  chain: string;
  address?: string;
  resolvedSymbol?: string;
  resolvedChain?: string;
  resolvedAddress?: string;
  thresholdPrice: number;
  condition: 'above' | 'below';
  note?: string;
  createdAt: string;
  lastConditionMet: boolean | null;
  lastCheckedAt?: string;
  /** Schema version discriminator (inert metadata). 2: current structured watch model. */
  schemaVersion?: number;
  /** Canonical venue + instrument identity, resolved from the trading system's instrument repository. */
  instrument?: WatchInstrumentIdentity;
  /** Semantic purpose — tells the runtime what this watch is for. */
  purpose?: WatchPurpose;
  /** Links this watch to a specific actor, position, or intent group. */
  coverage?: WatchCoverageLink;
}

// ---------------------------------------------------------------------------
// Zod schema — validate at boundaries
// ---------------------------------------------------------------------------

export const WatchEntrySchema = z.object({
  watchId: z.string().uuid(),
  symbol: z.string().min(1),
  chain: z.string().min(1),
  address: z.string().optional(),
  resolvedSymbol: z.string().optional(),
  resolvedChain: z.string().optional(),
  resolvedAddress: z.string().optional(),
  thresholdPrice: z.number().positive(),
  condition: z.enum(['above', 'below']),
  note: z.string().optional(),
  createdAt: z.string().min(1),
  lastConditionMet: z.boolean().nullable(),
  lastCheckedAt: z.string().optional(),
  schemaVersion: z.number().int().min(2),
  instrument: z.object({
    venue: z.string().min(1),
    instrumentId: z.string().min(1),
    symbol: z.string().min(1),
    chain: z.string().optional(),
    address: z.string().optional(),
  }).optional(),
  purpose: WatchPurposeEnum,
  coverage: z.object({
    actorType: z.enum(['agent', 'bot', 'user', 'system']).optional(),
    actorId: z.string().optional(),
    positionKey: z.string().optional(),
    intentGroup: z.string().optional(),
  }).optional(),
});