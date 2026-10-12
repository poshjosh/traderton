import { z } from 'zod';
import {
  MarketAssessmentIdentitySchema,
  PresetScorecardEntrySchema,
  RegimeResultSchema,
  VolatilityEvidenceSchema,
  EvidenceValueSchema,
  type MarketAssessmentIdentity,
  type PresetScorecardEntry,
  type RegimeResult,
  type VolatilityEvidence,
  type EvidenceValue,
} from './market-assessment.js';

// ---------------------------------------------------------------------------
// Data-only preset assessment (004 "Preset assessment becomes data-only and
// free", 2026-10-04). Traderton owns `assess_strategy_preset` /
// `change_strategy_preset` / `list_strategy_presets`. The assessment returns
// COMPUTED DATA ONLY (no LLM ranking, no narrative, no billing). The agent
// reasons over the data, guided by the skill, and changes its own active
// strategy. The creator's policy is enforced by Traderton and can't be
// overridden by the agent.
//
// This module is Traderton-authored (NOT a mirror of herobids' billing-based
// `tool-schemas.ts` assessment shapes) — the herobids copies are deleted by the
// herobids-side plan (H1/H5). It imports the still-mirrored
// `market-assessment.ts` types (identity, scorecard, regime, volatility,
// evidence) rather than re-declaring them.
// ---------------------------------------------------------------------------

// ── Preset catalog entry (list_strategy_presets) ────────────────────────────

/** A catalog preset surfaced to the agent/consumer by `list_strategy_presets`. */
export const PresetCatalogEntrySchema = z.object({
  key: z.string().min(1),
  name: z.string(),
  description: z.string(),
  strategyType: z.string(),
  signalBias: z.string(),
  behaviorVersion: z.string(),
});
export type PresetCatalogEntry = z.infer<typeof PresetCatalogEntrySchema>;

// ── Per-preset flags (assess_strategy_preset) ───────────────────────────────

export const PresetAssessmentFlagsSchema = z.object({
  /** The creator's policy allows this preset (creatorAllowed). */
  creatorAllowed: z.boolean(),
  /** The scorecard scan was not stale (scanHealth !== 'stale'). */
  evidenceFresh: z.boolean(),
  /** Deterministic mapping from the preset's signalBias to the regime result. */
  regimeMatch: z.boolean(),
  /** signals ÷ current preset's signals, null-safe (null when current has none). */
  signalsVsCurrent: z.number().nullable(),
});
export type PresetAssessmentFlags = z.infer<typeof PresetAssessmentFlagsSchema>;

// ── Per-preset assessment entry ─────────────────────────────────────────────

export const PresetAssessmentEntrySchema = z.object({
  presetKey: z.string().min(1),
  name: z.string(),
  signalBias: z.string(),
  behaviorVersion: z.string(),
  scorecard: PresetScorecardEntrySchema,
  flags: PresetAssessmentFlagsSchema,
});
export type PresetAssessmentEntry = z.infer<typeof PresetAssessmentEntrySchema>;

// ── Evidence (per symbol) ───────────────────────────────────────────────────

export const AssessmentEvidenceSchema = z.object({
  regime: EvidenceValueSchema(RegimeResultSchema),
  volatility: EvidenceValueSchema(VolatilityEvidenceSchema),
  /** First/last candle timestamps of the scored series, or null when none. */
  candleWindow: z.object({ start: z.string(), end: z.string() }).nullable(),
  candlesEvaluated: z.number().int().nonnegative(),
});
export type AssessmentEvidence = z.infer<typeof AssessmentEvidenceSchema>;

// ── Current strategy (from active_strategy) ─────────────────────────────────

export const CurrentStrategyViewSchema = z.object({
  presetKey: z.string().nullable(),
  styleTier: z.string(),
  behaviorVersion: z.string(),
});
export type CurrentStrategyView = z.infer<typeof CurrentStrategyViewSchema>;

// ── assess_strategy_preset params + per-symbol result ───────────────────────

export const AssessStrategyPresetParamsSchema = z.object({
  symbols: z.array(z.string().min(1)).min(1).max(50)
    .describe('Trading symbols to assess (e.g. ["BTC", "ETH", "SOL"]). All symbols share the same venueFamily and instrumentKind.'),
  venueFamily: z.string().min(1)
    .describe('Venue family to scope the assessment (e.g. "hyperliquid", "bybit", "jupiter"). Required.'),
  instrumentKind: z.enum(['orderbook', 'perp', 'swap', 'dex']).optional()
    .describe('Instrument kind shared across all requested symbols. Defaults to "orderbook" when omitted.'),
  venueAccountId: z.string().min(1).optional()
    .describe('Consumer-injected venue account binding. Never an LLM input.'),
});
export type AssessStrategyPresetParams = z.infer<typeof AssessStrategyPresetParamsSchema>;

export const AssessStrategyPresetResultSchema = z.object({
  success: z.boolean(),
  symbol: z.string(),
  canonicalIdentity: MarketAssessmentIdentitySchema.optional(),
  evidence: AssessmentEvidenceSchema.optional(),
  currentStrategy: CurrentStrategyViewSchema.nullable().optional(),
  presets: z.array(PresetAssessmentEntrySchema).optional(),
  artifactId: z.string().optional(),
  assessedAt: z.string().optional(),
  expiresAt: z.string().optional(),
  freshnessNote: z.string().optional(),
  /** When a recompute is next eligible (cooldown-blocked results). */
  nextEligibleAt: z.string().optional(),
  error: z.string().optional(),
  errorCode: z.string().optional(),
});
export type AssessStrategyPresetResult = z.infer<typeof AssessStrategyPresetResultSchema>;

export const AssessStrategyPresetResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    requestedInstrumentCount: z.number().int().min(0),
    assessedInstrumentCount: z.number().int().min(0),
    maxInstrumentsPerRequest: z.number().int().min(1),
    message: z.string().optional(),
    results: z.array(AssessStrategyPresetResultSchema),
  }).optional(),
  error: z.string().optional(),
  errorCode: z.string().optional(),
});
export type AssessStrategyPresetResponse = z.infer<typeof AssessStrategyPresetResponseSchema>;

// ── change_strategy_preset params ───────────────────────────────────────────

export const ChangeStrategyPresetParamsSchema = z.object({
  assessmentArtifactId: z.string().min(1).describe('Exact assessment artifact ID from assess_strategy_preset. Required for audit trail.'),
  targetPreset: z.string().min(1),
  mode: z.enum(['entries_only']).describe('Only entries_only is supported; other modes are rejected.'),
  reason: z.string().min(1).describe('Why the agent is changing its preset — shown on the review screen. Required.'),
});
export type ChangeStrategyPresetParams = z.infer<typeof ChangeStrategyPresetParamsSchema>;

// ── Strategy-change audit row (list_agent_strategy_changes) ─────────────────

export const AgentStrategyChangeSchema = z.object({
  id: z.string().min(1),
  ownerId: z.string().min(1),
  actorId: z.string().min(1),
  fromStrategy: z.record(z.unknown()).nullable(),
  toStrategy: z.record(z.unknown()),
  artifactId: z.string().min(1),
  reason: z.string().min(1),
  state: z.enum(['prepared', 'applying', 'applied', 'failed']),
  createdAt: z.string(),
  appliedAt: z.string().nullable(),
});
export type AgentStrategyChange = z.infer<typeof AgentStrategyChangeSchema>;

// ── Deterministic regime-match mapping (S3) ─────────────────────────────────
//
// The catalog's `signalBias` values are exactly `trend-following` and
// `mean-reverting` (enumerated 2026-10-10 across economy/standard/premium).
// A trend-following preset matches a trending regime (not choppy); a
// mean-reverting preset matches a choppy/range regime.

export const SIGNAL_BIAS_VALUES = ['trend-following', 'mean-reverting'] as const;
export type SignalBias = (typeof SIGNAL_BIAS_VALUES)[number];

/**
 * Deterministic regime-match: does a preset's signalBias fit the regime result?
 * - trend-following → matches when the regime is NOT choppy (a trend exists).
 * - mean-reverting → matches when the regime IS choppy (range-bound).
 * An unknown signalBias fails closed (false).
 */
export function computeRegimeMatch(signalBias: string, regime: RegimeResult): boolean {
  const choppy = regime.details.choppy;
  if (signalBias === 'trend-following') return !choppy;
  if (signalBias === 'mean-reverting') return choppy;
  return false;
}

// ── Freshness note (copied from herobids computeFreshnessNote) ──────────────

/**
 * Compute a human-readable freshness note from an ISO expiry timestamp.
 * Copied from herobids `apps/worker/src/tools/assess-strategy-preset.ts`
 * `computeFreshnessNote` (deterministic, no LLM).
 */
export function computeFreshnessNote(expiresAt: string, now: number = Date.now()): string {
  const expiresAtDate = new Date(expiresAt);
  const minutesRemaining = Math.round((expiresAtDate.getTime() - now) / 60_000);
  if (minutesRemaining <= 0) {
    return 'This assessment has already expired. Request a fresh assessment via assess_strategy_preset before applying any transition.';
  }
  if (minutesRemaining < 2) {
    return 'This assessment expires in less than 2 minutes. Act immediately or request a fresh assessment.';
  }
  if (minutesRemaining < 60) {
    return `Valid for approximately ${minutesRemaining} minutes. After expiry, you must call assess_strategy_preset again before applying any transition.`;
  }
  const hours = Math.round(minutesRemaining / 60);
  return `Valid for approximately ${hours} hour${hours !== 1 ? 's' : ''}. After expiry, you must call assess_strategy_preset again before applying any transition.`;
}

// ── Re-export the identity type for convenience ─────────────────────────────

export type { MarketAssessmentIdentity, PresetScorecardEntry, RegimeResult, VolatilityEvidence, EvidenceValue };