import { describe, it, expect, vi } from 'vitest';
import type { TradingToolContext, PresetEntry } from '@traderton/domain';
import { presetAssessmentTools } from './preset-assessment.js';

const listTool = presetAssessmentTools.find((t) => t.name === 'list_strategy_presets')!;
const getFullTool = presetAssessmentTools.find((t) => t.name === 'get_strategy_presets')!;
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
    getArtifact: vi.fn(async () => ({
      id: 'a1',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      presets: [],
      evidence: {},
      currentStrategy: {},
    })),
    persistAssessment: vi.fn(async () => undefined),
    findFreshArtifact: vi.fn(async () => null),
    latestCompletedRequest: vi.fn(async () => null),
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
    const ctx = makeCtx({ presetCatalog: { listPresets: () => [{ key: 'momentum', entry: momentumPreset }] } });
    const result = await listTool.execute({ styleTier: 'standard' }, ctx);
    expect(result.success).toBe(true);
    const data = result.data as { presets: Array<Record<string, unknown>> };
    expect(data.presets).toHaveLength(1);
    expect(data.presets[0]!.key).toBe('momentum');
    expect(data.presets[0]!.signalBias).toBe('trend-following');
    expect(typeof data.presets[0]!.behaviorVersion).toBe('string');
  });

  it('fails cleanly when the preset catalog port is absent', async () => {
    const result = await listTool.execute({}, makeCtx({ presetCatalog: undefined }));
    expect(result.success).toBe(false);
    expect(result.fault).toBe(false);
  });
});

describe('get_strategy_presets', () => {
  it('returns the full preset entry (params, risk, execution) grouped by tier', async () => {
    const ctx = makeCtx({
      presetCatalog: {
        listPresets: () => [{ key: 'momentum', entry: momentumPreset }],
      },
    });
    const result = await getFullTool.execute({ styleTier: 'standard' }, ctx);
    expect(result.success).toBe(true);
    const data = result.data as { presets: Record<string, Array<{ key: string; entry: PresetEntry }>> };
    expect(data.presets['standard']).toHaveLength(1);
    expect(data.presets['standard']![0]!.key).toBe('momentum');
    expect(data.presets['standard']![0]!.entry.strategy.type).toBe('momentum');
    expect(data.presets['standard']![0]!.entry.strategy.params).toEqual({ signalBias: 'trend-following', indicators: {} });
  });

  it('fails cleanly when the preset catalog port is absent', async () => {
    const result = await getFullTool.execute({}, makeCtx({ presetCatalog: undefined }));
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

  it('returns the cached artifact while it is fresh', async () => {
    const findFreshArtifact = vi.fn(async () => ({
      id: 'cached-1',
      assessedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      evidence: {},
      currentStrategy: null,
      presets: [],
    }));
    const ctx = makeCtx({ presetAssessment: makePresetAssessment({ findFreshArtifact }) });
    const result = await assessTool.execute({ symbols: ['BTC'], venueFamily: 'hyperliquid' }, ctx);
    expect(result.success).toBe(true);
    const data = result.data as { results: Array<Record<string, unknown>> };
    expect(data.results[0]!.artifactId).toBe('cached-1');
  });

  it('blocks a recompute inside the cooldown', async () => {
    const latestCompletedRequest = vi.fn(async () => ({
      id: 'req-1',
      completedAt: new Date().toISOString(),
      assessmentArtifactId: 'a1',
    }));
    const ctx = makeCtx({ presetAssessment: makePresetAssessment({ latestCompletedRequest }) });
    const result = await assessTool.execute({ symbols: ['BTC'], venueFamily: 'hyperliquid' }, ctx);
    expect(result.success).toBe(true);
    const data = result.data as { results: Array<Record<string, unknown>> };
    expect(data.results[0]!.success).toBe(false);
    expect(data.results[0]!.errorCode).toBe('assessment.cooldown_blocked');
    expect(data.results[0]!.nextEligibleAt).toBeDefined();
  });

  it('persists the completed assessment artifact', async () => {
    const persistAssessment = vi.fn(async () => undefined);
    const ctx = makeCtx({ presetAssessment: makePresetAssessment({ persistAssessment }) });
    const result = await assessTool.execute({ symbols: ['BTC'], venueFamily: 'hyperliquid' }, ctx);
    expect(result.success).toBe(true);
    expect(persistAssessment).toHaveBeenCalledTimes(1);
    const arg = persistAssessment.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.artifactId).toBeDefined();
    expect(arg.presets).toBeDefined();
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

  it('rejects an expired artifact', async () => {
    const getArtifact = vi.fn(async () => ({
      id: 'a1',
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      presets: [],
      evidence: {},
      currentStrategy: {},
    }));
    const ctx = makeCtx({ presetAssessment: makePresetAssessment({ getArtifact }) });
    const result = await changeTool.execute({ assessmentArtifactId: 'a1', targetPreset: 'momentum', mode: 'entries_only', reason: 'x' }, ctx);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('assessment.artifact_expired');
  });

  it('rejects a missing artifact', async () => {
    const getArtifact = vi.fn(async () => null);
    const ctx = makeCtx({ presetAssessment: makePresetAssessment({ getArtifact }) });
    const result = await changeTool.execute({ assessmentArtifactId: 'missing', targetPreset: 'momentum', mode: 'entries_only', reason: 'x' }, ctx);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('assessment.artifact_not_found');
  });
});

// ── list_strategy_presets is venue-independent (bug 2026-11-21/002, T1) ─────────
// The boundary builds `presetAssessment` only for an agent subject that carries a
// resolved venue account, and the dispatcher strips undeclared payload keys, so a
// consumer cannot hand `list_strategy_presets` an account. The tool therefore reads
// the always-present `presetCatalog` (the same source as `get_strategy_presets`), and
// only that: `bin.ts` is the sole builder of either context and always sets the catalog.
describe('list_strategy_presets reads the venue-independent catalog', () => {
  const rangePreset: PresetEntry = {
    name: 'Range — Day',
    description: 'Mean reversion in a range',
    strategy: { type: 'meanReversion', decisionMode: 'mechanical', params: { signalBias: 'mean-reverting', indicators: {} } },
  };
  const catalogByTier: Record<string, Array<{ key: string; entry: PresetEntry }>> = {
    economy: [{ key: 'range', entry: rangePreset }],
    standard: [{ key: 'momentum', entry: momentumPreset }],
    premium: [{ key: 'momentum', entry: momentumPreset }, { key: 'range', entry: rangePreset }],
  };
  function catalogOnlyCtx(listPresets = vi.fn((tier: string) => catalogByTier[tier] ?? [])): { ctx: TradingToolContext; listPresets: typeof listPresets } {
    return {
      ctx: makeCtx({ presetAssessment: undefined, presetCatalog: { listPresets } }),
      listPresets,
    };
  }

  it('succeeds with the catalog present and NO preset-assessment context (the bug shape)', async () => {
    const { ctx } = catalogOnlyCtx();
    const result = await listTool.execute({ styleTier: 'standard' }, ctx);
    expect(result.success).toBe(true);
    const data = result.data as { ok: boolean; presets: Array<Record<string, unknown>> };
    expect(data.ok).toBe(true);
    expect(data.presets.map((p) => p.key)).toEqual(['momentum']);
  });

  it('lists every tier, in order, when no styleTier is given', async () => {
    const { ctx, listPresets } = catalogOnlyCtx();
    const result = await listTool.execute({}, ctx);
    expect(result.success).toBe(true);
    expect(listPresets.mock.calls.map((call) => call[0])).toEqual(['economy', 'standard', 'premium']);
    const data = result.data as { presets: Array<Record<string, unknown>> };
    expect(data.presets.map((p) => p.key)).toEqual(['range', 'momentum', 'momentum', 'range']);
  });

  it('asks the catalog for only the requested tier', async () => {
    const { ctx, listPresets } = catalogOnlyCtx();
    await listTool.execute({ styleTier: 'premium' }, ctx);
    expect(listPresets).toHaveBeenCalledTimes(1);
    expect(listPresets).toHaveBeenCalledWith('premium');
  });

  it('returns the same entry shape as before: key, name, description, strategyType, signalBias, behaviorVersion', async () => {
    const { ctx } = catalogOnlyCtx();
    const result = await listTool.execute({ styleTier: 'economy' }, ctx);
    const entry = (result.data as { presets: Array<Record<string, unknown>> }).presets[0]!;
    expect(Object.keys(entry).sort()).toEqual(['behaviorVersion', 'description', 'key', 'name', 'signalBias', 'strategyType']);
    expect(entry).toMatchObject({
      key: 'range',
      name: 'Range — Day',
      description: 'Mean reversion in a range',
      strategyType: 'meanReversion',
      signalBias: 'mean-reverting',
    });
    expect(entry.behaviorVersion).toEqual(expect.any(String));
  });

  it('ignores the preset-assessment context: the catalog is the only source', async () => {
    const assessmentListPresets = vi.fn(() => [{ key: 'from-assessment', entry: momentumPreset }]);
    const ctx = makeCtx({
      presetAssessment: makePresetAssessment({ listPresets: assessmentListPresets }),
      presetCatalog: { listPresets: () => [{ key: 'from-catalog', entry: rangePreset }] },
    });
    const result = await listTool.execute({ styleTier: 'standard' }, ctx);
    expect((result.data as { presets: Array<{ key: string }> }).presets.map((p) => p.key)).toEqual(['from-catalog']);
    expect(assessmentListPresets).not.toHaveBeenCalled();
  });

  it('fails cleanly, without a fault, when the catalog is absent, even if a preset-assessment context exists', async () => {
    const result = await listTool.execute({}, makeCtx({ presetCatalog: undefined }));
    expect(result.success).toBe(false);
    expect(result.fault).toBe(false);
    expect(result.error).toBe('preset catalog not available in this context');
  });

  it('rejects a style tier outside economy, standard and premium', () => {
    expect(() => listTool.parametersSchema!.parse({ styleTier: 'platinum' })).toThrow();
  });

  it('declares no venueAccountId, because the catalog needs no account', () => {
    const properties = (listTool.parameters as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(properties)).toEqual(['styleTier']);
  });
});

// ── change_strategy_preset accepts the consumer-injected venue account (T2) ─────
// `change_strategy_preset` is `ownerScopedNoVenue`, so the boundary resolves the
// venue account from the payload's `venueAccountId`. The dispatcher strips keys the
// schema does not declare, so the schema has to declare it (same as
// `assess_strategy_preset`). The tool itself never consumes it.
describe('change_strategy_preset venueAccountId', () => {
  const validParams = { assessmentArtifactId: 'a1', targetPreset: 'momentum', mode: 'entries_only', reason: 'Strong momentum' } as const;

  it('keeps an optional consumer-injected venueAccountId when the schema parses the payload', () => {
    const parsed = changeTool.parametersSchema!.parse({ ...validParams, venueAccountId: 'va-1' }) as Record<string, unknown>;
    expect(parsed.venueAccountId).toBe('va-1');
  });

  it('still parses without venueAccountId (older consumers keep working)', () => {
    const parsed = changeTool.parametersSchema!.parse(validParams) as Record<string, unknown>;
    expect(parsed).toEqual(validParams);
    expect('venueAccountId' in parsed).toBe(false);
  });

  it('rejects an empty venueAccountId', () => {
    expect(() => changeTool.parametersSchema!.parse({ ...validParams, venueAccountId: '' })).toThrow();
  });

  it('rejects a non-string venueAccountId', () => {
    expect(() => changeTool.parametersSchema!.parse({ ...validParams, venueAccountId: 42 })).toThrow();
  });

  it('keeps every other field required and strict', () => {
    for (const missing of ['assessmentArtifactId', 'targetPreset', 'mode', 'reason'] as const) {
      const { [missing]: _omitted, ...rest } = validParams;
      expect(() => changeTool.parametersSchema!.parse({ ...rest, venueAccountId: 'va-1' }), `missing ${missing}`).toThrow();
    }
    expect(() => changeTool.parametersSchema!.parse({ ...validParams, mode: 'full_transition', venueAccountId: 'va-1' })).toThrow();
  });

  it('lists venueAccountId in the JSON schema as an optional property', () => {
    const json = changeTool.parameters as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(json.properties)).toContain('venueAccountId');
    expect(json.required ?? []).not.toContain('venueAccountId');
    expect(json.required ?? []).toEqual(expect.arrayContaining(['assessmentArtifactId', 'targetPreset', 'mode', 'reason']));
  });

  it('applies the change and never forwards venueAccountId to the apply seam', async () => {
    const applyPresetChange = vi.fn(async () => ({ ok: true as const }));
    const ctx = makeCtx({ presetAssessment: makePresetAssessment({ applyPresetChange }) });
    const result = await changeTool.execute({ ...validParams, venueAccountId: 'va-1' }, ctx);
    expect(result.success).toBe(true);
    expect(applyPresetChange).toHaveBeenCalledTimes(1);
    expect(applyPresetChange).toHaveBeenCalledWith({
      targetPreset: 'momentum',
      styleTier: 'standard',
      reason: 'Strong momentum',
      artifactId: 'a1',
    });
  });

  it('still fails cleanly when no preset-assessment context was built (no account reached the boundary)', async () => {
    const result = await changeTool.execute(validParams, makeCtx({ presetAssessment: undefined }));
    expect(result.success).toBe(false);
    expect(result.fault).toBe(false);
    expect(result.error).toBe('preset assessment not available in this context');
  });
});
