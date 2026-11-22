import { describe, it, expect } from 'vitest';
import {
  computeRegimeMatch,
  computeFreshnessNote,
  AssessStrategyPresetParamsSchema,
  ChangeStrategyPresetParamsSchema,
  SIGNAL_BIAS_VALUES,
  type RegimeResult,
} from './preset-assessment.js';
import { getToolSchema } from './tool-schemas.js';
import {
  evaluateReviewEligibility,
  ReviewPreCheckReasonCodes,
  ReviewPreCheckReasonDescriptions,
  type ActivePresetState,
  type PersistedScannerCandidate,
  type ResolvedReviewPreCheckPolicy,
} from './review-pre-check.js';

function makeRegime(choppy: boolean): RegimeResult {
  return {
    pass: !choppy,
    reasons: [],
    details: {
      benchmarkSymbol: 'BTC',
      currentPrice: 100,
      emaFast: 100,
      emaSlow: 100,
      emaTrend: 100,
      emaAlignment: 'bullish',
      adxValue: 25,
      choppy,
      vwap: 100,
      priceAboveVwap: true,
      marketStructure: 'higherHighs',
    },
  };
}

describe('computeRegimeMatch', () => {
  it('matches a trend-following preset to a non-choppy regime', () => {
    expect(computeRegimeMatch('trend-following', makeRegime(false))).toBe(true);
  });
  it('does not match a trend-following preset to a choppy regime', () => {
    expect(computeRegimeMatch('trend-following', makeRegime(true))).toBe(false);
  });
  it('matches a mean-reverting preset to a choppy regime', () => {
    expect(computeRegimeMatch('mean-reverting', makeRegime(true))).toBe(true);
  });
  it('fails closed for an unknown signal bias', () => {
    expect(computeRegimeMatch('unknown', makeRegime(false))).toBe(false);
  });
});

describe('computeFreshnessNote', () => {
  it('reports an expired assessment', () => {
    const note = computeFreshnessNote(new Date(Date.now() - 1000).toISOString(), Date.now());
    expect(note).toContain('already expired');
  });
  it('reports a valid window in hours', () => {
    const note = computeFreshnessNote(new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(), Date.now());
    expect(note).toContain('Valid for approximately 3 hours');
  });
});

describe('SIGNAL_BIAS_VALUES', () => {
  it('enumerates the catalog signal biases', () => {
    expect(SIGNAL_BIAS_VALUES).toEqual(['trend-following', 'mean-reverting']);
  });
});

describe('evaluateReviewEligibility', () => {
  const policy: ResolvedReviewPreCheckPolicy = {
    signalRatioThreshold: 2.0,
    scanMetricsLookbackMs: 86_400_000,
    minSignalsForActive: 3,
    identityCooldownMs: 86_400_000,
    candidateMaxAgeMs: 86_400_000,
    policyVersion: '1.0.0',
    enablePeerComparison: true,
  };
  const activePreset: ActivePresetState = {
    presetKey: 'momentum',
    behaviorVersion: 'abc',
    styleTier: 'standard',
    signalBias: 'trend-following',
    enabledIndicators: ['rsi'],
  };
  const candidate: PersistedScannerCandidate = {
    id: 'c1',
    agentId: 'a1',
    scannedAt: new Date().toISOString(),
    scanVersion: 'v1',
    activePresetKey: 'momentum',
    presetBehaviorVersion: 'abc',
    identity: { instrumentKind: 'orderbook', venueFamily: 'hyperliquid', styleTier: 'standard', symbol: 'BTC' },
    candidateRank: 1,
    confidence: 0.8,
    disposition: 'entry_candidate',
  };

  it('advises an entry candidate with sufficient confidence', () => {
    const out = evaluateReviewEligibility({ candidate, activePreset, policy });
    expect(out.eligible).toBe(true);
    expect(out.reasons).toContain(ReviewPreCheckReasonCodes.PEER_OUTPERFORMANCE_DETECTED);
  });

  it('rejects a low-confidence candidate', () => {
    const out = evaluateReviewEligibility({ candidate: { ...candidate, confidence: 0.1 }, activePreset, policy });
    expect(out.eligible).toBe(false);
    expect(out.reasons).toContain(ReviewPreCheckReasonCodes.INSUFFICIENT_CANDIDATE_QUALITY);
  });

  it('rejects a regime-bias mismatch', () => {
    const out = evaluateReviewEligibility({ candidate: { ...candidate, regimeBucket: 'blocked' }, activePreset, policy });
    expect(out.eligible).toBe(false);
    expect(out.reasons).toContain(ReviewPreCheckReasonCodes.REGIME_BIAS_MISMATCH);
  });

  it('rejects a scored_no_signal candidate as no peer outperformance', () => {
    const out = evaluateReviewEligibility({ candidate: { ...candidate, disposition: 'scored_no_signal' }, activePreset, policy });
    expect(out.eligible).toBe(false);
    expect(out.reasons).toContain(ReviewPreCheckReasonCodes.NO_PEER_OUTPERFORMANCE);
  });
});

describe('ReviewPreCheckReasonDescriptions', () => {
  it('has a description for every reason code', () => {
    for (const code of Object.values(ReviewPreCheckReasonCodes)) {
      expect(ReviewPreCheckReasonDescriptions[code]).toBeDefined();
    }
  });
});

// ── Consumer-injected venueAccountId on the preset tool schemas (bug 2026-11-21/002) ──
// The boundary dispatcher parses each payload with the tool's Zod schema and forwards the
// PARSED result, so a key the schema does not declare is stripped before the subject
// resolver can read it. Both tools that need the agent's venue account must declare it.
describe('ChangeStrategyPresetParamsSchema venueAccountId', () => {
  const valid = { assessmentArtifactId: 'artifact-1', targetPreset: 'momentum', mode: 'entries_only', reason: 'Strong momentum' } as const;

  it('keeps an optional venueAccountId through parsing', () => {
    expect(ChangeStrategyPresetParamsSchema.parse({ ...valid, venueAccountId: 'va-1' })).toEqual({ ...valid, venueAccountId: 'va-1' });
  });

  it('parses without it and does not add one', () => {
    expect(ChangeStrategyPresetParamsSchema.parse(valid)).toEqual(valid);
  });

  it('rejects an empty or non-string venueAccountId', () => {
    expect(ChangeStrategyPresetParamsSchema.safeParse({ ...valid, venueAccountId: '' }).success).toBe(false);
    expect(ChangeStrategyPresetParamsSchema.safeParse({ ...valid, venueAccountId: null }).success).toBe(false);
  });

  it('declares venueAccountId the same way assess_strategy_preset does', () => {
    const assess = AssessStrategyPresetParamsSchema.shape.venueAccountId;
    const change = ChangeStrategyPresetParamsSchema.shape.venueAccountId;
    expect(change.description).toBe(assess.description);
    expect(change.safeParse(undefined).success).toBe(true);
    expect(change.safeParse('').success).toBe(false);
  });

  it('does not advertise venueAccountId in the get_schema entry an LLM reads', () => {
    const entry = getToolSchema('change_strategy_preset');
    expect(entry).toBeDefined();
    const properties = (entry!.schema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(properties).sort()).toEqual(['assessmentArtifactId', 'mode', 'reason', 'targetPreset']);
  });
});
