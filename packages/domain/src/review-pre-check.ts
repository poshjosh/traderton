import type { MarketAssessmentIdentity } from './market-assessment.js';

// ---------------------------------------------------------------------------
// Deterministic review pre-check (S7) — Traderton-owned re-implementation of
// herobids `packages/domain/src/review-pre-check.ts`. The herobids copy is
// deleted by the herobids-side plan (H5); Traderton re-implements the
// deterministic predicate independently over its own `agent_scan_candidates` /
// `agent_scan_metrics` (E1-T T3) rather than importing herobids'.
//
// The predicate is cheap and deterministic: it reads persisted scan facts and
// produces stable, explainable reason codes — no LLM, no billing.
// ---------------------------------------------------------------------------

/**
 * The agent's active preset state resolved at pre-check time (read-only
 * projection from the profile's `active_strategy`).
 */
export interface ActivePresetState {
  presetKey: string;
  behaviorVersion: string;
  styleTier: 'economy' | 'standard' | 'premium';
  signalBias?: 'trend-following' | 'mean-reverting';
  enabledIndicators: string[];
  compatibilityThresholds?: Record<string, number>;
}

/** A persisted scanner candidate observation the pre-check reads. */
export interface PersistedScannerCandidate {
  id: string;
  agentId: string;
  scannedAt: string;
  scanVersion: string;
  activePresetKey: string;
  presetBehaviorVersion: string;
  identity: MarketAssessmentIdentity;
  candidateRank: number;
  scanScope?: string;
  signalFacts: Record<string, unknown>;
  confidence?: number;
  regimeBucket?: string;
  volatilityFact?: number;
  dataFreshnessTs?: string;
  disposition: 'discovered' | 'scored_no_signal' | 'entry_candidate' | 'exit_advisory' | 'rejected' | 'unresolved';
}

/** Resolved policy for the deterministic review pre-check. */
export interface ResolvedReviewPreCheckPolicy {
  signalRatioThreshold: number;
  scanMetricsLookbackMs: number;
  minSignalsForActive: number;
  identityCooldownMs: number;
  candidateMaxAgeMs: number;
  policyVersion: string;
  enablePeerComparison: boolean;
}

/** Input for the deterministic review eligibility evaluation. */
export interface AssessmentReviewEligibilityInput {
  candidate: PersistedScannerCandidate;
  activePreset: ActivePresetState;
  policy: ResolvedReviewPreCheckPolicy;
}

/** Output of the deterministic review eligibility evaluation. */
export interface AssessmentReviewEligibilityOutput {
  eligible: boolean;
  reasons: string[];
  policyVersion: string;
  evaluatedAt: string;
}

export const ReviewPreCheckReasonCodes = {
  REGIME_BIAS_MISMATCH: 'regime_bias_mismatch',
  VOLATILITY_OUTSIDE_PRESET_BAND: 'volatility_outside_preset_band',
  INSUFFICIENT_CANDIDATE_QUALITY: 'insufficient_candidate_quality',
  NO_PEER_OUTPERFORMANCE: 'no_peer_outperformance',
  PEER_OUTPERFORMANCE_DETECTED: 'peer_outperformance_detected',
  CANDIDATE_STALE: 'candidate_stale',
  IDENTITY_UNRESOLVED: 'identity_unresolved',
  FRESH_ARTIFACT_EXISTS: 'fresh_artifact_exists',
  COOLDOWN_ACTIVE: 'cooldown_active',
  AGENT_DISABLED: 'agent_disabled',
  NO_CANDIDATE: 'no_candidate',
} as const;

export const ReviewPreCheckReasonDescriptions: Record<ReviewPreCheckReasonCode, string> = {
  regime_bias_mismatch: 'Market regime does not match this preset\'s bias',
  volatility_outside_preset_band: 'Volatility is outside this preset\'s acceptable range',
  insufficient_candidate_quality: 'Signal confidence is below the minimum threshold',
  no_peer_outperformance: 'No other preset is outperforming the current one here',
  peer_outperformance_detected: 'A different preset is generating more signals on this instrument',
  candidate_stale: 'Scanner data for this instrument is too old to act on',
  identity_unresolved: 'Could not resolve a canonical identity for this instrument',
  fresh_artifact_exists: 'A recent assessment already exists for this instrument',
  cooldown_active: 'This instrument was reviewed too recently to review again',
  agent_disabled: 'This agent is disabled',
  no_candidate: 'No scanner candidates were available to review',
};

export type ReviewPreCheckReasonCode = (typeof ReviewPreCheckReasonCodes)[keyof typeof ReviewPreCheckReasonCodes];

/** Outcome of a single candidate's pre-check evaluation. */
export interface CandidatePreCheckOutcome {
  identity?: MarketAssessmentIdentity;
  outcome: 'advised' | 'not_advised' | 'blocked_by_cooldown' | 'fresh_artifact_exists' | 'no_candidate';
  candidateRank?: number;
  activePreset?: string;
  presetBehaviorVersion?: string;
  reasons?: string[];
}

/**
 * The deterministic eligibility predicate (copied from herobids
 * `assessment-review-runner.ts` `evaluateEligibility`). Cheap facts only:
 * regime-bias mismatch, volatility-outside-band, insufficient quality, and
 * peer-outperformance (entry/exit candidates count as outperformance).
 */
export function evaluateReviewEligibility(
  input: AssessmentReviewEligibilityInput,
): AssessmentReviewEligibilityOutput {
  const { candidate, activePreset, policy } = input;
  const reasons: string[] = [];

  if (candidate.regimeBucket && activePreset.signalBias) {
    const regime = candidate.regimeBucket.toLowerCase();
    if (regime === 'blocked') {
      reasons.push(ReviewPreCheckReasonCodes.REGIME_BIAS_MISMATCH);
      return { eligible: false, reasons, policyVersion: policy.policyVersion, evaluatedAt: new Date().toISOString() };
    }
  }

  const volFact = candidate.volatilityFact;
  const maxVol = activePreset.compatibilityThresholds?.['maxVolatilityPercentile'];
  if (volFact != null && maxVol != null && Number(volFact) > maxVol) {
    reasons.push(ReviewPreCheckReasonCodes.VOLATILITY_OUTSIDE_PRESET_BAND);
    return { eligible: false, reasons, policyVersion: policy.policyVersion, evaluatedAt: new Date().toISOString() };
  }

  const confidence = candidate.confidence;
  if (confidence != null && Number(confidence) < 0.3) {
    reasons.push(ReviewPreCheckReasonCodes.INSUFFICIENT_CANDIDATE_QUALITY);
    return { eligible: false, reasons, policyVersion: policy.policyVersion, evaluatedAt: new Date().toISOString() };
  }

  if (candidate.disposition === 'entry_candidate' || candidate.disposition === 'exit_advisory') {
    reasons.push(ReviewPreCheckReasonCodes.PEER_OUTPERFORMANCE_DETECTED);
  } else {
    reasons.push(ReviewPreCheckReasonCodes.NO_PEER_OUTPERFORMANCE);
    return { eligible: false, reasons, policyVersion: policy.policyVersion, evaluatedAt: new Date().toISOString() };
  }

  return { eligible: true, reasons, policyVersion: policy.policyVersion, evaluatedAt: new Date().toISOString() };
}