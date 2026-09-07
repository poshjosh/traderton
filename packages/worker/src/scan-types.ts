// Scan value-types relocated verbatim from the worker's runtime-composition.ts
// (whose platform body is not part of the mechanical trading loop). These are the
// mechanical scan/watch/freshness value shapes consumed by the KEEP scan + tick-gate
// files. Type-relocation seam only — no logic authored here.
import type { HybridPricingIdentity } from '@traderton/domain';
import type { RegimeResult } from '@traderton/market-data';
import type { ScoredSignal } from '@traderton/strategy';
import type { PositionIndicatorUpdate, SymbolFetchOutcome } from './technical-phase.js';
import type { WatchInstrumentIdentity, WatchPurpose, WatchCoverageLink } from './watch-types.js';

type FreshnessState = 'fresh' | 'stale' | 'unavailable';

export interface RuntimeFreshness {
  state: FreshnessState;
  ageMs?: number;
  provider?: string;
  note?: string;
}

export interface RuntimePositionSnapshot {
  instrumentId: string;
  side: string;
  size: string;
  entryPrice: string | null;
  unrealizedPnlUsd: number | null;
  openedAt: string | null;
  holdDurationMinutes: number | null;
  venueType: 'perps' | 'dex' | 'unknown';
  freshness: RuntimeFreshness;
}

export interface RuntimeActiveWatch {
  watchId: string;
  symbol: string;
  chain: string;
  address?: string;
  resolvedSymbol?: string;
  resolvedChain?: string;
  resolvedAddress?: string;
  condition: 'above' | 'below';
  thresholdPrice: number;
  note?: string;
  lastConditionMet: boolean | null;
  lastCheckedAt?: string;
  /** Semantic purpose — tells the runtime what this watch is for. */
  purpose?: WatchPurpose;
  /** Schema version discriminator from the canonical WatchEntry. */
  schemaVersion?: number;
  /** Links this watch to a specific actor, position, or intent group. */
  coverage?: WatchCoverageLink;
  /** Canonical venue + instrument identity resolved from the trading system's instrument repository. */
  instrument?: WatchInstrumentIdentity;
}

export interface RuntimeActiveWatchSummary {
  totalCount: number;
  uniqueCount: number;
  lines: string[];
  overflowCount: number;
}

export type { HybridPricingIdentity } from '@traderton/domain';

// ─── Scanner health classification ─────────────────────────────────────────

/** Operator-facing scanner health status derived from scan outcomes. */
export type ScannerHealth = 'healthy_no_signal' | 'healthy_signals' | 'data_path_failure' | 'overlap_skipped' | 'no_candidates';

export interface ScannerHealthResult {
  status: ScannerHealth;
  reason: string;
}

export interface TechnicalScanState {
  timestamp: string;
  scanIntervalMs: number;
  regimeResult: RegimeResult | null;
  signals: ScoredSignal[];
  positionIndicators: PositionIndicatorUpdate[];
  summary: { scanned: number; rejected: number; passed: number };
  /** Structured per-symbol fetch outcomes for scanner health observability. */
  symbolOutcomes: SymbolFetchOutcome[];
  /** Count of discovered candidates (before bounding/selection). */
  discovered: number;
  /** Count of symbols selected for candle fetch (after bounding, includes open-position exits). */
  symbolsSelected: number;
  /** Count of symbols with eligible candle data (fetched + empty). */
  eligible: number;
  /** Count of symbols that returned non-empty candles. */
  fetched: number;
  /** Count of symbols classified as unsupported by the provider. */
  unsupported: number;
  /** Count of symbols that encountered transient fetch failures. */
  fetchFailures: number;
  /** Count of symbols skipped because the circuit breaker is open. */
  breakerSkips?: number;
  /** Count of signals generated. */
  signalsGenerated: number;
  /** Whether this scan was skipped due to an overlapping scan already in progress. */
  overlapSkipped?: boolean;
  /**
   * Pricing identity sidecar keyed by instrumentId.
   * Carries enough information for the hybrid USD-to-base conversion path to
   * safely reprice each signal — perps use chain='hyperliquid', DEX uses
   * chain + address identity.
   */
  pricingIdentities?: Record<string, HybridPricingIdentity>;
  /** Operator-facing scanner health classification derived from scan outcomes. */
  /** Scanner health classification — populated by {@link completeTechnicalScan}. */
  scannerHealth?: ScannerHealthResult;
}
