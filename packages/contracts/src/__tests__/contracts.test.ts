import { describe, it, expect } from 'vitest';
import {
  WatchEntrySchema,
  WatchPurposeEnum,
  AgentRiskOverridesSchema,
  RegimeResultSchema,
  VolatilityEvidenceSchema,
  EvidenceValueSchema,
  ScannerWakeContextSchema,
  WakePrioritySchema,
} from '../index.js';

describe('@poshjosh/contracts round-trip fixtures', () => {
  it('parses a structured watch with purpose, instrument and coverage', () => {
    const watch = WatchEntrySchema.parse({
      watchId: '3f2a8e0c-0000-4000-8000-000000000001',
      symbol: 'BTC',
      chain: 'hyperliquid',
      thresholdPrice: 90000,
      condition: 'above',
      createdAt: '2026-10-10T00:00:00.000Z',
      lastConditionMet: false,
      schemaVersion: 2,
      purpose: 'entry',
      instrument: { venue: 'hyperliquid', instrumentId: 'BTC', symbol: 'BTC' },
      coverage: { actorType: 'agent', actorId: 'agent-1' },
    });
    expect(watch.symbol).toBe('BTC');
    expect(watch.purpose).toBe('entry');
  });

  it('rejects an unknown watch purpose', () => {
    expect(() => WatchPurposeEnum.parse('daylight')).toThrow();
  });

  it('parses a strict risk-overrides payload and rejects unknown keys', () => {
    const overrides = AgentRiskOverridesSchema.parse({ maxOpenPositions: 3, stopLossPct: 5 });
    expect(overrides.maxOpenPositions).toBe(3);
    expect(() => AgentRiskOverridesSchema.parse({ maxOpenPositions: 3, bogus: 1 })).toThrow();
  });

  it('parses a regime result', () => {
    const regime = RegimeResultSchema.parse({
      pass: true,
      reasons: ['trend aligned'],
      details: {
        benchmarkSymbol: 'BTC',
        currentPrice: 90000,
        emaFast: 89000,
        emaSlow: 85000,
        emaTrend: 1.02,
        emaAlignment: 'bullish',
        adxValue: 28,
        choppy: false,
        vwap: 89100,
        priceAboveVwap: true,
        marketStructure: 'higherHighs',
      },
    });
    expect(regime.pass).toBe(true);
  });

  it('parses volatility evidence', () => {
    const v = VolatilityEvidenceSchema.parse({ averageTrueRange: 120, volatilityRegime: 'high', calculationVersion: 'v1' });
    expect(v.volatilityRegime).toBe('high');
  });

  it('parses both evidence states', () => {
    const schema = EvidenceValueSchema(VolatilityEvidenceSchema);
    const available = schema.parse({ state: 'available', value: { averageTrueRange: 120, volatilityRegime: 'high', calculationVersion: 'v1' }, source: 'x', observedAt: 't', expiresAt: 't' });
    const unavailable = schema.parse({ state: 'unavailable', reasonCode: 'n/a', message: 'none', observedAt: 't' });
    expect(available.state).toBe('available');
    expect(unavailable.state).toBe('unavailable');
  });

  it('parses each scanner wake variant', () => {
    expect(ScannerWakeContextSchema.parse({ scannerKind: 'signal_scoring', signalCount: 2 }).scannerKind).toBe('signal_scoring');
    expect(ScannerWakeContextSchema.parse({
      scannerKind: 'preset_review', assessmentRef: 'a', recommendedPreset: 'momentum', currentPreset: 'range', relativeUplift: 0.2, confidence: 0.9,
    }).scannerKind).toBe('preset_review');
    expect(ScannerWakeContextSchema.parse({
      scannerKind: 'assessment_review',
      advice: [{ identity: { instrumentKind: 'orderbook', venueFamily: 'hl', styleTier: 'premium', symbol: 'BTC' }, candidateRank: 1, activePreset: 'momentum', presetBehaviorVersion: 'v1', reasons: ['up'] }],
      checkedAt: '2026-10-10T00:00:00.000Z',
      nextEligibleAt: '2026-10-10T00:00:00.000Z',
    }).scannerKind).toBe('assessment_review');
  });

  it('parses wake priority', () => {
    expect(WakePrioritySchema.parse('high')).toBe('high');
    expect(() => WakePrioritySchema.parse('urgent')).toThrow();
  });
});