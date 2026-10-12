import { z } from 'zod';
import type { AgentTool, ToolResult, TradingToolContext } from '@traderton/domain';
import {
  AssessStrategyPresetParamsSchema,
  ChangeStrategyPresetParamsSchema,
  computeFreshnessNote,
  computeRegimeMatch,
  computePresetBehaviorVersion,
  type AssessStrategyPresetResult,
  type AssessmentEvidence,
  type CurrentStrategyView,
  type PresetAssessmentEntry,
  type PresetCatalogEntry,
  type PresetEntry,
} from '@traderton/domain';
import { convertZodToJsonSchema } from './registry.js';

// ── list_strategy_presets ──────────────────────────────────────────────────

const ListStrategyPresetsParamsSchema = z.object({
  styleTier: z.enum(['economy', 'standard', 'premium']).optional()
    .describe('Style tier to list presets for. Omit to list all tiers.'),
});

const listStrategyPresetsTool: AgentTool<TradingToolContext> = {
  name: 'list_strategy_presets',
  category: 'read-config',
  description: 'List the available strategy presets (key, name, description, strategy type, signal bias, behavior version) from the Traderton catalog. Use to understand the preset choices before assessing or changing a preset.',
  parametersSchema: ListStrategyPresetsParamsSchema,
  parameters: convertZodToJsonSchema(ListStrategyPresetsParamsSchema),
  async execute(rawParams: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const params = ListStrategyPresetsParamsSchema.parse(rawParams);
    if (!ctx.presetAssessment) {
      return { success: false, error: 'preset assessment not available in this context', fault: false };
    }
    const tiers: Array<'economy' | 'standard' | 'premium'> = params.styleTier
      ? [params.styleTier]
      : ['economy', 'standard', 'premium'];

    const entries: PresetCatalogEntry[] = [];
    for (const tier of tiers) {
      for (const { key, entry } of ctx.presetAssessment.listPresets(tier)) {
        const params_ = entry.strategy.params as Record<string, unknown>;
        entries.push({
          key,
          name: entry.name,
          description: entry.description,
          strategyType: entry.strategy.type,
          signalBias: typeof params_['signalBias'] === 'string' ? params_['signalBias'] : 'trend-following',
          behaviorVersion: computeBehaviorVersion(key, entry),
        });
      }
    }
    return { success: true, data: { ok: true, presets: entries } };
  },
};

// ── assess_strategy_preset ─────────────────────────────────────────────────

const assessStrategyPresetTool: AgentTool<TradingToolContext> = {
  name: 'assess_strategy_preset',
  category: 'read-market-data',
  description: 'Assess strategy presets for one or more symbols. Returns computed data only (evidence, per-preset scorecards and flags) — no LLM ranking, no narrative, free. Use the flags and the skill guidance to decide whether to change your preset.',
  parametersSchema: AssessStrategyPresetParamsSchema,
  parameters: convertZodToJsonSchema(AssessStrategyPresetParamsSchema),
  async execute(rawParams: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const params = AssessStrategyPresetParamsSchema.parse(rawParams);
    if (!ctx.presetAssessment) {
      return { success: false, error: 'preset assessment not available in this context', fault: false };
    }
    const pa = ctx.presetAssessment;
    const maxInstruments = pa.config.maxInstrumentsPerRequest;
    const symbols = params.symbols.slice(0, maxInstruments);
    const instrumentKind = params.instrumentKind ?? 'orderbook';

    const results: AssessStrategyPresetResult[] = [];
    for (const symbol of symbols) {
      results.push(await assessOne(ctx, symbol, params.venueFamily, instrumentKind));
    }

    return {
      success: true,
      data: {
        requestedInstrumentCount: params.symbols.length,
        assessedInstrumentCount: symbols.length,
        maxInstrumentsPerRequest: maxInstruments,
        ...(params.symbols.length > maxInstruments
          ? { message: `Only the first ${maxInstruments} instruments were assessed (cap).` }
          : {}),
        results,
      },
    };
  },
};

async function assessOne(
  ctx: TradingToolContext,
  symbol: string,
  venueFamily: string,
  instrumentKind: 'orderbook' | 'perp' | 'swap' | 'dex',
): Promise<AssessStrategyPresetResult> {
  const pa = ctx.presetAssessment!;
  const styleTier = pa.activeStrategy?.styleTier ?? 'standard';

  // ── Identity resolution (orderbook/perp only — swap/dex needs token resolution
  //    which the boundary does not yet expose; fail closed). ──
  if (instrumentKind === 'swap' || instrumentKind === 'dex') {
    return {
      success: false,
      symbol,
      error: 'Swap/dex assessment is not yet supported (token resolution is not exposed).',
      errorCode: 'assessment.identity.unsupported_instrument_kind',
    };
  }

  const identity = {
    instrumentKind: instrumentKind as 'orderbook' | 'perp',
    venueFamily,
    styleTier: styleTier as 'economy' | 'standard' | 'premium',
    symbol,
  } as const;

  // ── Cache: a fresh artifact for the same identity is returned as-is. ──
  const fresh = await pa.findFreshArtifact?.(identity);
  if (fresh) {
    const freshId = typeof fresh.id === 'string' ? fresh.id : undefined;
    const freshAssessedAt = typeof fresh.assessedAt === 'string' ? fresh.assessedAt : undefined;
    const freshExpiresAt = typeof fresh.expiresAt === 'string' ? fresh.expiresAt : undefined;
    return {
      success: true,
      symbol,
      canonicalIdentity: identity,
      evidence: fresh.evidence as AssessmentEvidence,
      currentStrategy: (fresh.currentStrategy as CurrentStrategyView | null) ?? null,
      presets: (fresh.presets as PresetAssessmentEntry[]) ?? [],
      artifactId: freshId,
      assessedAt: freshAssessedAt,
      expiresAt: freshExpiresAt,
      freshnessNote: freshExpiresAt ? computeFreshnessNote(freshExpiresAt, Date.now()) : undefined,
    };
  }

  // ── Cooldown: a recompute is allowed once per effective interval per
  //    (agent, identity). The creator may lengthen it via the profile's preset
  //    policy, never shorten it below the operator floor. ──
  const effectiveIntervalMs = Math.max(
    pa.config.minRequestIntervalMs,
    pa.presetPolicy?.minRequestIntervalMs ?? 0,
  );
  const lastRequest = await pa.latestCompletedRequest?.(identity);
  const lastCompletedAt = typeof lastRequest?.completedAt === 'string' ? lastRequest.completedAt : null;
  if (lastCompletedAt) {
    const lastCompleted = new Date(lastCompletedAt).getTime();
    const nextEligibleAt = lastCompleted + effectiveIntervalMs;
    if (Date.now() < nextEligibleAt) {
      return {
        success: false,
        symbol,
        canonicalIdentity: identity,
        error: 'A fresh assessment was already computed for this identity. Wait for the cooldown before requesting a new one.',
        errorCode: 'assessment.cooldown_blocked',
        nextEligibleAt: new Date(nextEligibleAt).toISOString(),
      };
    }
  }

  // ── Evidence: regime + volatility + candle window (behind the boundary). ──
  const regimeResult = await pa.checkRegime({ benchmarkSymbol: symbol });
  const volatilityResult = await pa.getVolatility({ symbol });
  const scoreResult = await pa.scoreCandidate({
    symbol,
    instrumentId: symbol,
    venueType: 'orderbook',
    providerSymbol: symbol,
    venue: venueFamily,
    config: { indicators: {}, signalBias: 'trend-following' },
  });

  const regime = parseRegime(regimeResult);
  const volatility = parseVolatility(volatilityResult);
  const candleWindow = parseCandleWindow(scoreResult);
  const candlesEvaluated = parseCandlesEvaluated(scoreResult);

  const nowIso = new Date().toISOString();
  const evidence: AssessmentEvidence = {
    regime: regime
      ? { state: 'available', value: regime, source: 'boundary', observedAt: nowIso, expiresAt: new Date(Date.now() + 300_000).toISOString() }
      : { state: 'unavailable', reasonCode: 'assessment.regime_unavailable', message: 'Regime evidence unavailable', observedAt: nowIso },
    volatility: volatility
      ? { state: 'available', value: volatility, source: 'boundary', observedAt: nowIso, expiresAt: new Date(Date.now() + 300_000).toISOString() }
      : { state: 'unavailable', reasonCode: 'assessment.volatility_unavailable', message: 'Volatility evidence unavailable', observedAt: nowIso },
    candleWindow,
    candlesEvaluated,
  };

  // ── Current strategy view ──
  const currentStrategy: CurrentStrategyView | null = pa.activeStrategy
    ? {
        presetKey: pa.activeStrategy.presetKey,
        styleTier: pa.activeStrategy.styleTier,
        behaviorVersion: pa.activeStrategy.behaviorVersion,
      }
    : null;

  // ── Per-preset scorecards + flags ──
  const presets = pa.listPresets(styleTier);
  const currentPresetKey = pa.activeStrategy?.presetKey ?? null;

  // Score the current preset first so `signalsVsCurrent` is a real ratio.
  let currentSignals: number | null = null;
  if (currentPresetKey) {
    const current = presets.find((p) => p.key === currentPresetKey);
    if (current && current.entry.strategy.type !== 'dca') {
      const score = await pa.scoreCandidate({
        symbol,
        instrumentId: symbol,
        venueType: 'orderbook',
        providerSymbol: symbol,
        venue: venueFamily,
        config: {
          indicators: extractIndicatorConfig(current.entry),
          signalBias: extractSignalBias(current.entry),
        },
      });
      currentSignals = parseHasSignal(score) ? 1 : 0;
    }
  }

  const presetEntries: PresetAssessmentEntry[] = [];
  for (const { key, entry } of presets) {
    if (entry.strategy.type === 'dca') continue; // bot-only, not scorable
    const score = await pa.scoreCandidate({
      symbol,
      instrumentId: symbol,
      venueType: 'orderbook',
      providerSymbol: symbol,
      venue: venueFamily,
      config: {
        indicators: extractIndicatorConfig(entry),
        signalBias: extractSignalBias(entry),
      },
    });
    const hasSignal = parseHasSignal(score);
    const signals = hasSignal ? 1 : 0;
    const scanHealth = parseScanHealth(score, candlesEvaluated);
    const signalBias = extractSignalBias(entry);
    const regimeMatch = regime ? computeRegimeMatch(signalBias, regime) : false;

    presetEntries.push({
      presetKey: key,
      name: entry.name,
      signalBias,
      behaviorVersion: computeBehaviorVersion(key, entry),
      scorecard: {
        presetKey: key,
        presetBehaviorVersion: computeBehaviorVersion(key, entry),
        candidatesDiscovered: 1,
        candidatesScored: 1,
        signalsGenerated: signals,
        topConfidence: parseConfidence(score),
        scanHealth,
        evaluationScope: 'single_symbol_dry_run',
      },
      flags: {
        creatorAllowed: isCreatorAllowed(key, pa.presetPolicy),
        evidenceFresh: scanHealth !== 'stale',
        regimeMatch,
        signalsVsCurrent: currentSignals === null || currentSignals === 0 ? null : signals / currentSignals,
      },
    });
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + pa.config.cacheFreshnessMs);
  const artifactId = `assess:${symbol}:${now.getTime()}`;

  // ── Persist the completed data-only assessment (run + artifact + request). ──
  // The artifact is the change_strategy_preset gate-1 source and the review
  // screen's get_assessment_artifact read. Persistence is best-effort: a
  // persistence failure must not fail the assessment the agent already received.
  try {
    await pa.persistAssessment?.({
      identity,
      artifactId,
      assessedAt: now,
      expiresAt,
      allowedPresets: pa.presetPolicy?.allowedPresets ?? [],
      evidence: evidence as unknown as Record<string, unknown>,
      presets: presetEntries as unknown as Record<string, unknown>[],
      currentStrategy: (currentStrategy ?? {}) as unknown as Record<string, unknown>,
    });
  } catch {
    // Best-effort — the in-memory result is still returned to the agent.
  }

  return {
    success: true,
    symbol,
    canonicalIdentity: identity,
    evidence,
    currentStrategy,
    presets: presetEntries,
    artifactId,
    assessedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    freshnessNote: computeFreshnessNote(expiresAt.toISOString(), now.getTime()),
  };
}

// ── change_strategy_preset ─────────────────────────────────────────────────

const changeStrategyPresetTool: AgentTool<TradingToolContext> = {
  name: 'change_strategy_preset',
  category: 'write-database',
  ownerScopedNoVenue: true,
  description: 'Change your active strategy preset, using an assessment artifact from assess_strategy_preset. Only entries_only is supported. You must give a reason (shown on the review screen). The creator\'s policy and cooldowns are enforced.',
  parametersSchema: ChangeStrategyPresetParamsSchema,
  parameters: convertZodToJsonSchema(ChangeStrategyPresetParamsSchema),
  async execute(rawParams: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const params = ChangeStrategyPresetParamsSchema.parse(rawParams);
    if (!ctx.presetAssessment) {
      return { success: false, error: 'preset assessment not available in this context', fault: false };
    }
    const pa = ctx.presetAssessment;

    // ── Gate 1: the artifact must exist, belong to this owner/agent identity,
    //    and be fresh. ──
    const artifact = await pa.getArtifact?.(params.assessmentArtifactId);
    if (!artifact) {
      return { success: false, error: 'The assessment artifact does not exist or is not owned by this agent.', errorCode: 'assessment.artifact_not_found', fault: false };
    }
    const expiresAt = typeof artifact.expiresAt === 'string' ? new Date(artifact.expiresAt).getTime() : NaN;
    if (Number.isNaN(expiresAt) || Date.now() >= expiresAt) {
      return { success: false, error: 'The assessment artifact has expired. Request a fresh assessment before changing your preset.', errorCode: 'assessment.artifact_expired', fault: false };
    }

    // ── Gate 2: creator policy ──
    if (!pa.presetPolicy || !pa.presetPolicy.changesAllowed) {
      return { success: false, error: 'The creator has disabled preset changes.', errorCode: 'assessment.preset_changes_disabled', fault: false };
    }
    if (pa.presetPolicy.allowedPresets.length > 0 && !pa.presetPolicy.allowedPresets.includes(params.targetPreset)) {
      return { success: false, error: `Preset "${params.targetPreset}" is not in the creator's allowed presets.`, errorCode: 'assessment.preset_not_allowed', fault: false };
    }

    const result = await pa.applyPresetChange({
      targetPreset: params.targetPreset,
      styleTier: pa.presetPolicy.styleTier,
      reason: params.reason,
      artifactId: params.assessmentArtifactId,
    });
    if (!result.ok) {
      return { success: false, error: result.message, errorCode: result.code, fault: false };
    }
    return { success: true, data: { ok: true, targetPreset: params.targetPreset } };
  },
};

// ── list_agent_strategy_changes (consumer-only read) ───────────────────────

const ListAgentStrategyChangesParamsSchema = z.object({
  actorId: z.string().min(1).describe('The agent whose strategy changes to list.'),
  since: z.string().optional().describe('ISO timestamp — only changes after this.'),
  limit: z.number().int().min(1).max(500).optional().describe('Max rows (default 50).'),
});

const listAgentStrategyChangesTool: AgentTool<TradingToolContext> = {
  name: 'list_agent_strategy_changes',
  category: 'read-database',
  ownerScopedNoVenue: true,
  description: 'List an agent\'s strategy-change history (from → to strategy, reason, state). Consumer-only — powers the review screen.',
  parametersSchema: ListAgentStrategyChangesParamsSchema,
  parameters: convertZodToJsonSchema(ListAgentStrategyChangesParamsSchema),
  async execute(rawParams: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const params = ListAgentStrategyChangesParamsSchema.parse(rawParams);
    if (!ctx.presetAssessment) {
      return { success: false, error: 'preset assessment not available in this context', fault: false };
    }
    // The boundary wires the change-list read through the presetAssessment seam.
    const changes = await ctx.presetAssessment.listStrategyChanges?.(params.actorId, params.since, params.limit ?? 50);
    if (!changes) {
      return { success: false, error: 'strategy-change read not available in this context', fault: false };
    }
    return { success: true, data: { ok: true, changes } };
  },
};

// ── get_assessment_artifact (consumer-only read) ───────────────────────────

const GetAssessmentArtifactParamsSchema = z.object({
  artifactId: z.string().min(1).describe('The assessment artifact id.'),
});

const getAssessmentArtifactTool: AgentTool<TradingToolContext> = {
  name: 'get_assessment_artifact',
  category: 'read-database',
  ownerScopedNoVenue: true,
  description: 'Read a data-only assessment artifact by id. Consumer-only — powers the review screen.',
  parametersSchema: GetAssessmentArtifactParamsSchema,
  parameters: convertZodToJsonSchema(GetAssessmentArtifactParamsSchema),
  async execute(rawParams: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const params = GetAssessmentArtifactParamsSchema.parse(rawParams);
    if (!ctx.presetAssessment) {
      return { success: false, error: 'preset assessment not available in this context', fault: false };
    }
    const artifact = await ctx.presetAssessment.getArtifact?.(params.artifactId);
    if (!artifact) {
      return { success: false, error: 'assessment artifact read not available in this context', fault: false };
    }
    return { success: true, data: { ok: true, artifact } };
  },
};

// ── get_strategy_presets ───────────────────────────────────────────────────
// D2-a: the full-preset read tool. Unlike `list_strategy_presets` (a thin
// catalog for the agent), this returns the COMPLETE `PresetEntry` (strategy
// params, risk, execution) so a consumer (herobids) can derive agent config
// without holding its own copy of the preset YAML. Venue-independent.

const GetStrategyPresetsParamsSchema = z.object({
  styleTier: z.enum(['economy', 'standard', 'premium']).optional()
    .describe('Style tier to list presets for. Omit to list all tiers.'),
});

const getStrategyPresetsTool: AgentTool<TradingToolContext> = {
  name: 'get_strategy_presets',
  category: 'read-config',
  description: 'Read the full strategy preset definitions (name, description, strategy type, decision mode, params, risk, execution) from the Traderton catalog. Returns the complete preset entries, not the thin catalog.',
  parametersSchema: GetStrategyPresetsParamsSchema,
  parameters: convertZodToJsonSchema(GetStrategyPresetsParamsSchema),
  async execute(rawParams: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const params = GetStrategyPresetsParamsSchema.parse(rawParams);
    if (!ctx.presetCatalog) {
      return { success: false, error: 'preset catalog not available in this context', fault: false };
    }
    const tiers: Array<'economy' | 'standard' | 'premium'> = params.styleTier
      ? [params.styleTier]
      : ['economy', 'standard', 'premium'];

    const presets: Array<{ key: string; entry: PresetEntry }> = [];
    for (const tier of tiers) {
      for (const { key, entry } of ctx.presetCatalog.listPresets(tier)) {
        presets.push({ key, entry });
      }
    }
    return { success: true, data: { ok: true, presets } };
  },
};

export const presetAssessmentTools: AgentTool<TradingToolContext>[] = [
  listStrategyPresetsTool,
  getStrategyPresetsTool,
  assessStrategyPresetTool,
  changeStrategyPresetTool,
  listAgentStrategyChangesTool,
  getAssessmentArtifactTool,
];

// ── Helpers ────────────────────────────────────────────────────────────────

function computeBehaviorVersion(_key: string, entry: PresetEntry): string {
  return computePresetBehaviorVersion(entry);
}

function extractIndicatorConfig(entry: { strategy: { params: Record<string, unknown> } }): Record<string, unknown> {
  const raw = entry.strategy.params['indicators'];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return {};
}

function extractSignalBias(entry: { strategy: { params: Record<string, unknown> } }): 'trend-following' | 'mean-reverting' {
  const raw = entry.strategy.params['signalBias'];
  if (raw === 'mean-reverting') return 'mean-reverting';
  return 'trend-following';
}

function isCreatorAllowed(key: string, policy: { allowedPresets: string[] } | null): boolean {
  if (!policy) return true;
  if (policy.allowedPresets.length === 0) return true;
  return policy.allowedPresets.includes(key);
}

type BoundaryRead = { kind: 'success'; data: unknown } | { kind: 'failure'; code: string; message: string } | { kind: 'transport_error'; message: string } | { kind: 'in_progress' };

function parseRegime(result: BoundaryRead): import('@traderton/domain').RegimeResult | null {
  if (result.kind !== 'success') return null;
  const data = result.data as Record<string, unknown>;
  const pass = data['pass'] === true;
  const reasons = Array.isArray(data['reasons']) ? (data['reasons'] as string[]) : [];
  const details = (data['details'] ?? {}) as Record<string, unknown>;
  return {
    pass,
    reasons,
    details: {
      benchmarkSymbol: typeof details['benchmarkSymbol'] === 'string' ? details['benchmarkSymbol'] : '',
      currentPrice: typeof details['currentPrice'] === 'number' ? details['currentPrice'] : 0,
      emaFast: typeof details['emaFast'] === 'number' ? details['emaFast'] : 0,
      emaSlow: typeof details['emaSlow'] === 'number' ? details['emaSlow'] : 0,
      emaTrend: typeof details['emaTrend'] === 'number' ? details['emaTrend'] : 0,
      emaAlignment: details['emaAlignment'] === 'bearish' ? 'bearish' : 'bullish',
      adxValue: typeof details['adxValue'] === 'number' ? details['adxValue'] : 0,
      choppy: details['choppy'] === true,
      vwap: typeof details['vwap'] === 'number' ? details['vwap'] : 0,
      priceAboveVwap: details['priceAboveVwap'] === true,
      marketStructure: details['marketStructure'] === 'lowerHighs' || details['marketStructure'] === 'mixed' ? details['marketStructure'] : 'higherHighs',
    },
  };
}

function parseVolatility(result: BoundaryRead): import('@traderton/domain').VolatilityEvidence | null {
  if (result.kind !== 'success') return null;
  const data = result.data as Record<string, unknown>;
  const evidence = data['volatilityEvidence'];
  if (!evidence || typeof evidence !== 'object') return null;
  const e = evidence as Record<string, unknown>;
  if (typeof e['averageTrueRange'] !== 'number') return null;
  const regime = e['volatilityRegime'];
  if (regime !== 'low' && regime !== 'normal' && regime !== 'high' && regime !== 'extreme') return null;
  return {
    averageTrueRange: e['averageTrueRange'],
    volatilityRegime: regime,
    calculationVersion: typeof e['calculationVersion'] === 'string' ? e['calculationVersion'] : '1.0.0',
  };
}

function parseCandleWindow(result: BoundaryRead): { start: string; end: string } | null {
  if (result.kind !== 'success') return null;
  const data = result.data as Record<string, unknown>;
  const window = data['candleWindow'];
  if (window && typeof window === 'object') {
    const w = window as Record<string, unknown>;
    if (typeof w['start'] === 'string' && typeof w['end'] === 'string') return { start: w['start'], end: w['end'] };
  }
  return null;
}

function parseCandlesEvaluated(result: BoundaryRead): number {
  if (result.kind !== 'success') return 0;
  const data = result.data as Record<string, unknown>;
  const n = data['candlesEvaluated'];
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

function parseHasSignal(result: BoundaryRead): boolean {
  if (result.kind !== 'success') return false;
  const data = result.data as Record<string, unknown>;
  return data['signal'] != null && typeof data['signal'] === 'object';
}

function parseConfidence(result: BoundaryRead): number | null {
  if (result.kind !== 'success') return null;
  const data = result.data as Record<string, unknown>;
  const signal = data['signal'];
  if (signal && typeof signal === 'object') {
    const c = (signal as Record<string, unknown>)['confidence'];
    return typeof c === 'number' ? c : null;
  }
  return null;
}

function parseScanHealth(result: BoundaryRead, candlesEvaluated: number): 'healthy' | 'degraded' | 'no_signal' | 'stale' {
  if (result.kind !== 'success') return 'stale';
  if (parseHasSignal(result)) return 'healthy';
  if (candlesEvaluated > 0) return 'no_signal';
  return 'stale';
}