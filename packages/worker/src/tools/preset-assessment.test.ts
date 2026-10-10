import { describe, it, expect, vi } from 'vitest';
import type { TradingToolContext, PresetEntry } from '@traderton/domain';
import { presetAssessmentTools } from './preset-assessment.js';

const listTool = presetAssessmentTools.find((t) => t.name === 'list_strategy_presets')!;
const assessTool = presetAssessmentTools.find((t) => t.name === 'assess_strategy_preset')!;
const changeTool = presetAssessmentTools.find((t) => t.name === 'change_strategy_preset')!;

const momentumPreset: PresetEntry = {
  name: 'Momentum — Day',
  description: 'Day-trend following',
  strategy: { type: 'momentum', decisionMode: 'mechanical', params: { signalBias: 'trend-following', indicators: {} } },
};

function makePresetAssessment(overrides: Partial<NonNullable<TradingToolContext['presetAssessment']>> = {}): NonNullable<TradingToolContext['presetAssessment']> {
  return {
    config: {
      minRequestIntervalMs: 86_400_000,
      cacheFreshnessMs: 21_600_000,
      maxInstrumentsPerRequest: 3,
      minChangeCooldownMs: 86_400_000,
      preCheck: {
        signalRatioThreshold: 2.0,
        scanMetricsLookbackMs: 86_400_000,
        minSignalsForActive: 3,
        identityCooldownMs: 86_400_000,
        candidateMaxAgeMs: 86_400_000,
        policyVersion: '1.0.0',
        enablePeerComparison: true,
        reviewIntervalMs: 3_600_000,
      },
    },
    presetPolicy: { changesAllowed: true, allowedPresets: [], styleTier: 'standard' },
    activeStrategy: { presetKey: 'momentum', styleTier: 'standard', behaviorVersion: 'abc', technical: {} as never, source: 'creator', changedAt: new Date().toISOString() },
    venue: 'hyperliquid',
    venueType: 'orderbook',
    venueAccountId: 'venue-1',
    executionMode: 'paper',
    listPresets: () => [{ key: 'momentum', entry: momentumPreset }],
    fetchCandles: vi.fn(async () => []),
    scoreCandidate: vi.fn(async () => ({ kind: 'success', data: { signal: null, candlesEvaluated: 48, candleWindow: { start: 'a', end: 'b' } } })),
    checkRegime: vi.fn(async () => ({ kind: 'success', data: { pass: true, reasons: [], details: { benchmarkSymbol: 'BTC', currentPrice: 1, emaFast: 1, emaSlow: 1, emaTrend: 1, emaAlignment: 'bullish', adxValue: 25, choppy: false, vwap: 1, priceAboveVwap: true, marketStructure: 'higherHighs' } } })),
    getVolatility: vi.fn(async () => ({ kind: 'success', data: { volatilityEvidence: { averageTrueRange: 10, volatilityRegime: 'normal', calculationVersion: '1.0.0' } } })),
    applyPresetChange: vi.fn(async () => ({ ok: true as const })),
    ...overrides,
  };
}

function makeCtx(overrides: Partial<TradingToolContext> = {}): TradingToolContext {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    ownerId: 'owner-1',
    executionMode: 'paper',
    authorizationMode: 'direct',
    redis: {} as unknown as TradingToolContext['redis'],
    publishToInbound: vi.fn(async () => undefined),
    presetAssessment: makePresetAssessment(),
    ...overrides,
  };
}

describe('list_strategy_presets', () => {
  it('lists every catalog preset for a style tier with its behaviour version', async () => {
    const result = await listTool.execute({ styleTier: 'standard' }, makeCtx());
    expect(result.success).toBe(true);
    const data = result.data as { presets: Array<Record<string, unknown>> };
    expect(data.presets).toHaveLength(1);
    expect(data.presets[0]!.key).toBe('momentum');
    expect(data.presets[0]!.signalBias).toBe('trend-following');
    expect(typeof data.presets[0]!.behaviorVersion).toBe('string');
  });

  it('fails cleanly when the preset-assessment port is absent', async () => {
    const result = await listTool.execute({}, makeCtx({ presetAssessment: undefined }));
    expect(result.success).toBe(false);
    expect(result.fault).toBe(false);
  });
});

describe('assess_strategy_preset', () => {
  it('returns computed evidence and every preset with flags, without narrative fields', async () => {
    const result = await assessTool.execute({ symbols: ['BTC'], venueFamily: 'hyperliquid' }, makeCtx());
    expect(result.success).toBe(true);
    const data = result.data as { results: Array<Record<string, unknown>> };
    const entry = data.results[0]!;
    expect(entry.success).toBe(true);
    expect(entry.evidence).toBeDefined();
    expect(entry.presets).toHaveLength(1);
    const preset = (entry.presets as Array<Record<string, unknown>>)[0]!;
    expect(preset.flags).toBeDefined();
    // No narrative/LLM fields.
    expect(preset).not.toHaveProperty('pros');
    expect(preset).not.toHaveProperty('cons');
    expect(preset).not.toHaveProperty('score');
    expect(entry).not.toHaveProperty('marketSummary');
  });

  it('caps the number of instruments to the configured maximum', async () => {
    const result = await assessTool.execute({ symbols: ['BTC', 'ETH', 'SOL', 'XRP'], venueFamily: 'hyperliquid' }, makeCtx());
    const data = result.data as { requestedInstrumentCount: number; assessedInstrumentCount: number; maxInstrumentsPerRequest: number };
    expect(data.requestedInstrumentCount).toBe(4);
    expect(data.assessedInstrumentCount).toBe(3);
    expect(data.maxInstrumentsPerRequest).toBe(3);
  });

  it('fails cleanly when the preset-assessment port is absent', async () => {
    const result = await assessTool.execute({ symbols: ['BTC'], venueFamily: 'hyperliquid' }, makeCtx({ presetAssessment: undefined }));
    expect(result.success).toBe(false);
  });
});

describe('change_strategy_preset', () => {
  it('applies a preset change and records the agent reason', async () => {
    const applyPresetChange = vi.fn(async () => ({ ok: true as const }));
    const ctx = makeCtx({ presetAssessment: makePresetAssessment({ applyPresetChange }) });
    const result = await changeTool.execute({ assessmentArtifactId: 'a1', targetPreset: 'momentum', mode: 'entries_only', reason: 'Strong momentum' }, ctx);
    expect(result.success).toBe(true);
    expect(applyPresetChange).toHaveBeenCalledWith(expect.objectContaining({ targetPreset: 'momentum', reason: 'Strong momentum' }));
  });

  it('rejects a preset the creator policy forbids', async () => {
    const ctx = makeCtx({ presetAssessment: makePresetAssessment({ presetPolicy: { changesAllowed: true, allowedPresets: ['range'], styleTier: 'standard' } }) });
    const result = await changeTool.execute({ assessmentArtifactId: 'a1', targetPreset: 'momentum', mode: 'entries_only', reason: 'x' }, ctx);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('assessment.preset_not_allowed');
  });

  it('rejects when the creator disabled preset changes', async () => {
    const ctx = makeCtx({ presetAssessment: makePresetAssessment({ presetPolicy: { changesAllowed: false, allowedPresets: [], styleTier: 'standard' } }) });
    const result = await changeTool.execute({ assessmentArtifactId: 'a1', targetPreset: 'momentum', mode: 'entries_only', reason: 'x' }, ctx);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('assessment.preset_changes_disabled');
  });

  it('requires a reason', () => {
    expect(() => changeTool.parametersSchema!.parse({ assessmentArtifactId: 'a1', targetPreset: 'momentum', mode: 'entries_only' })).toThrow();
  });
});