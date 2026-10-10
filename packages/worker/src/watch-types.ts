/**
 * Canonical watch types — single source of truth for WatchEntry and related parsing.
 *
 * Used by:
 *   - tools/watch.ts (watch CRUD tools)
 *   - market-intelligence/monitor.ts (threshold evaluation)
 *   - runtime-composition.ts (prompt context via RuntimeActiveWatch)
 */

import { createLogger } from './logger.js';
import {
  WatchEntrySchema,
  WatchPurposeEnum,
  type WatchCoverageLink,
  type WatchEntry,
  type WatchInstrumentIdentity,
  type WatchPurpose,
} from '@poshjosh/contracts';
import type { RuntimeActiveWatch } from './scan-types.js';

const logger = createLogger('watch-types');

// Re-export the contract shapes so existing relative importers keep working.
export type { WatchCoverageLink, WatchEntry, WatchInstrumentIdentity, WatchPurpose };
export { WatchEntrySchema, WatchPurposeEnum };

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a raw JSON string into a WatchEntry.
 *
 * Only structured watches (schemaVersion >= 2) are supported.
 * Records that fail Zod validation are discarded.
 * Returns null for any malformed or missing data.
 */
export function parseWatch(raw: string): WatchEntry | null {
  try {
    const parsed = WatchEntrySchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      // Try to extract watchId for better diagnostics
      let watchId: string | undefined;
      try {
        const rawObj = JSON.parse(raw) as Record<string, unknown>;
        watchId = typeof rawObj.watchId === 'string' ? rawObj.watchId : undefined;
      } catch { /* swallow */ }
      logger.warn({ watchId, raw: raw.length > 200 ? raw.slice(0, 200) + '...' : raw, errors: parsed.error.issues }, 'Malformed watch record — discarding');
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Conversion to runtime prompt representation
// ---------------------------------------------------------------------------

/**
 * Convert a WatchEntry into the RuntimeActiveWatch shape used in prompt composition.
 */
export function toRuntimeActiveWatch(watch: WatchEntry): RuntimeActiveWatch {
  return {
    watchId: watch.watchId,
    symbol: watch.symbol,
    chain: watch.chain,
    ...(watch.address ? { address: watch.address } : {}),
    ...(watch.resolvedSymbol ? { resolvedSymbol: watch.resolvedSymbol } : {}),
    ...(watch.resolvedChain ? { resolvedChain: watch.resolvedChain } : {}),
    ...(watch.resolvedAddress ? { resolvedAddress: watch.resolvedAddress } : {}),
    condition: watch.condition,
    thresholdPrice: watch.thresholdPrice,
    note: watch.note,
    lastConditionMet: watch.lastConditionMet,
    lastCheckedAt: watch.lastCheckedAt,
    ...(watch.schemaVersion !== undefined ? { schemaVersion: watch.schemaVersion } : {}),
    ...(watch.instrument ? { instrument: watch.instrument } : {}),
    ...(watch.purpose ? { purpose: watch.purpose } : {}),
    ...(watch.coverage ? { coverage: watch.coverage } : {}),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Note: isWatchEntryV2 was removed — all watches are now the structured model
// (schemaVersion >= 2). There is no longer a legacy vs. v2 distinction at runtime.
