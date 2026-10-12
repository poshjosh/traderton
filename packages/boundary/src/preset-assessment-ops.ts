// Preset-assessment operations (004 "Preset assessment becomes data-only and
// free", S1-S8) — the boundary-side glue the `assess_strategy_preset` /
// `change_strategy_preset` / `list_strategy_presets` / consumer-only read tools
// consume via the ctx `presetAssessment` port. Built ONCE in bin.ts over the
// assessment repo + the profile repo + the preset catalog + the scanner candle
// fetcher + the market-data registry, so the tools never touch `@traderton/db`
// or the runtime directly (ports-carry-values).
//
// Keeping the apply/read logic here (not inline in bin.ts) makes it unit-testable
// with fakes and keeps bin.ts a thin composition root.

import crypto from 'node:crypto';
import type {
  ActiveStrategy,
  MarketAssessmentIdentity,
  PresetAssessmentConfig,
  PresetEntry,
  PresetPolicy,
} from '@traderton/domain';
import { listPresets } from '@traderton/domain/config/presets-loader';
import type {
  AgentTradingProfileRepository,
  PresetAssessmentRepository,
} from '@traderton/db';
import type { PriceCandle, ScannerCandleTarget } from '@traderton/domain';

/** Minimal logger surface (matches `createLogger` output used in the boundary). */
interface OpsLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/** A boundary read result (score_candidate / check_regime / get_volatility). */
export type BoundaryReadResult =
  | { kind: 'success'; data: unknown }
  | { kind: 'failure'; code: string; message: string }
  | { kind: 'transport_error'; message: string }
  | { kind: 'in_progress' };

export interface PresetAssessmentOpsDeps {
  config: PresetAssessmentConfig;
  assessmentRepo: PresetAssessmentRepository;
  profileRepo: AgentTradingProfileRepository;
  /** Fetch candles behind the boundary for a scanner target. */
  fetchCandles(target: ScannerCandleTarget, interval: string, limit: number): Promise<PriceCandle[]>;
  /** Score a candidate behind the boundary (score_candidate). */
  scoreCandidate(payload: unknown): Promise<BoundaryReadResult>;
  /** Evaluate the market regime behind the boundary (check_regime). */
  checkRegime(payload: unknown): Promise<BoundaryReadResult>;
  /** Get volatility evidence behind the boundary (get_volatility). */
  getVolatility(payload: unknown): Promise<BoundaryReadResult>;
  logger: OpsLogger;
}

/** The per-request preset-assessment context the tools consume. */
export interface PresetAssessmentContext {
  config: PresetAssessmentConfig;
  presetPolicy: PresetPolicy | null;
  activeStrategy: ActiveStrategy | null;
  venue: string;
  venueType: 'orderbook' | 'swap';
  venueAccountId: string;
  executionMode: 'paper' | 'shadow' | 'live';
  listPresets(styleTier: string): Array<{ key: string; entry: PresetEntry }>;
  fetchCandles(target: ScannerCandleTarget, interval: string, limit: number): Promise<PriceCandle[]>;
  scoreCandidate(payload: unknown): Promise<BoundaryReadResult>;
  checkRegime(payload: unknown): Promise<BoundaryReadResult>;
  getVolatility(payload: unknown): Promise<BoundaryReadResult>;
  applyPresetChange(params: {
    targetPreset: string;
    styleTier: string;
    reason: string;
    artifactId: string;
  }): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  listStrategyChanges(actorId: string, since?: string, limit?: number): Promise<Array<Record<string, unknown>>>;
  getArtifact(artifactId: string): Promise<Record<string, unknown> | null>;
  /** Persist a completed data-only assessment (run + artifact + request bookkeeping). */
  persistAssessment(params: {
    identity: MarketAssessmentIdentity;
    artifactId: string;
    assessedAt: Date;
    expiresAt: Date;
    allowedPresets: string[];
    evidence: Record<string, unknown>;
    presets: Record<string, unknown>[];
    currentStrategy: Record<string, unknown>;
  }): Promise<void>;
  /** The freshest active artifact for an identity, or null (cache). */
  findFreshArtifact(identity: MarketAssessmentIdentity): Promise<Record<string, unknown> | null>;
  /** The most recent completed request for an identity (cooldown bookkeeping). */
  latestCompletedRequest(identity: MarketAssessmentIdentity): Promise<Record<string, unknown> | null>;
}

export function buildPresetAssessmentOps(deps: PresetAssessmentOpsDeps): {
  buildContext(input: {
    ownerId: string;
    actorId: string;
    venueAccountId: string;
    venue: string;
    venueType: 'orderbook' | 'swap';
    executionMode: 'paper' | 'shadow' | 'live';
    presetPolicy: PresetPolicy | null;
    activeStrategy: ActiveStrategy | null;
  }): PresetAssessmentContext;
} {
  const listPresetsFor = (styleTier: string): Array<{ key: string; entry: PresetEntry }> => {
    const raw = listPresets(styleTier as 'economy' | 'standard' | 'premium');
    return raw.map(({ key, ...entryFields }) => ({ key, entry: entryFields as PresetEntry }));
  };

  return {
    buildContext(input) {
      const applyPresetChange: PresetAssessmentContext['applyPresetChange'] = async (params) => {
        try {
          const revision = await deps.profileRepo.applyAgentPresetChange({
            ownerId: input.ownerId,
            actorId: input.actorId,
            venueAccountId: input.venueAccountId,
            targetPreset: params.targetPreset,
            styleTier: params.styleTier,
            changedAt: new Date().toISOString(),
          });
          if (revision === null) {
            return { ok: false, code: 'assessment.profile_not_found', message: 'No trading profile for this agent' };
          }
          // Record the audit row (from → to strategy).
          const profile = await deps.profileRepo.getByOwnerActorVenueAccount(input.ownerId, input.actorId, input.venueAccountId);
          await deps.assessmentRepo.insertStrategyChange({
            id: crypto.randomUUID(),
            ownerId: input.ownerId,
            actorId: input.actorId,
            fromStrategy: (profile?.activeStrategy ?? null) as unknown as Record<string, unknown> | null,
            toStrategy: (profile?.activeStrategy ?? {}) as unknown as Record<string, unknown>,
            artifactId: params.artifactId,
            reason: params.reason,
            state: 'applied',
            appliedAt: new Date(),
          });
          return { ok: true };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          deps.logger.error({ err, actorId: input.actorId }, 'preset change failed');
          return { ok: false, code: 'assessment.change_failed', message };
        }
      };

      return {
        config: deps.config,
        presetPolicy: input.presetPolicy,
        activeStrategy: input.activeStrategy,
        venue: input.venue,
        venueType: input.venueType,
        venueAccountId: input.venueAccountId,
        executionMode: input.executionMode,
        listPresets: listPresetsFor,
        fetchCandles: deps.fetchCandles,
        scoreCandidate: deps.scoreCandidate,
        checkRegime: deps.checkRegime,
        getVolatility: deps.getVolatility,
        applyPresetChange,
        listStrategyChanges: async (actorId, since, limit) => {
          const rows = await deps.assessmentRepo.listStrategyChanges({
            ownerId: input.ownerId,
            actorId,
            since: since ? new Date(since) : undefined,
            limit: limit ?? 50,
          });
          return rows.map((r) => ({
            id: r.id,
            ownerId: r.ownerId,
            actorId: r.actorId,
            fromStrategy: r.fromStrategy,
            toStrategy: r.toStrategy,
            artifactId: r.artifactId,
            reason: r.reason,
            state: r.state,
            createdAt: r.createdAt.toISOString(),
            appliedAt: r.appliedAt?.toISOString() ?? null,
          }));
        },
        getArtifact: async (artifactId) => {
          const artifact = await deps.assessmentRepo.getArtifactById(artifactId);
          if (!artifact) return null;
          return {
            id: artifact.id,
            instrumentKind: artifact.instrumentKind,
            venueFamily: artifact.venueFamily,
            styleTier: artifact.styleTier,
            symbol: artifact.symbol,
            network: artifact.network,
            address: artifact.address,
            assessedAt: artifact.assessedAt.toISOString(),
            expiresAt: artifact.expiresAt.toISOString(),
            status: artifact.status,
            allowedPresets: artifact.allowedPresets,
            evidence: artifact.evidence,
            presets: artifact.presets,
            currentStrategy: artifact.currentStrategy,
          };
        },
        persistAssessment: async (params) => {
          const identity = params.identity;
          const symbol = identity.instrumentKind === 'orderbook' || identity.instrumentKind === 'perp'
            ? identity.symbol
            : undefined;
          const network = identity.instrumentKind === 'swap' || identity.instrumentKind === 'dex'
            ? identity.network
            : undefined;
          const address = identity.instrumentKind === 'swap' || identity.instrumentKind === 'dex'
            ? identity.address
            : undefined;
          const identitySnapshot = identity as unknown as Record<string, unknown>;
          const runId = crypto.randomUUID();
          await deps.assessmentRepo.insertRun({
            id: runId,
            instrumentKind: identity.instrumentKind,
            venueFamily: identity.venueFamily,
            styleTier: identity.styleTier,
            symbol,
            network,
            address,
            identitySnapshot,
            startedAt: params.assessedAt,
            completedAt: params.assessedAt,
            status: 'completed',
            evidenceRefs: [],
            evidenceSnapshot: params.evidence,
            scorecardSnapshots: params.presets,
            calculationVersions: {},
          });
          await deps.assessmentRepo.insertArtifact({
            id: params.artifactId,
            instrumentKind: identity.instrumentKind,
            venueFamily: identity.venueFamily,
            styleTier: identity.styleTier,
            symbol,
            network,
            address,
            identitySnapshot,
            assessmentRunId: runId,
            assessedAt: params.assessedAt,
            expiresAt: params.expiresAt,
            status: 'active',
            allowedPresets: params.allowedPresets,
            evidence: params.evidence,
            presets: params.presets,
            currentStrategy: params.currentStrategy,
            evidenceRefs: [],
          });
          await deps.assessmentRepo.insertRequest({
            id: crypto.randomUUID(),
            ownerId: input.ownerId,
            agentId: input.actorId,
            instrumentKind: identity.instrumentKind,
            venueFamily: identity.venueFamily,
            styleTier: identity.styleTier,
            symbol,
            network,
            address,
            identitySnapshot,
            requestGroupKey: crypto.randomUUID(),
            status: 'assessment_completed',
            assessmentArtifactId: params.artifactId,
            requestedAt: params.assessedAt,
            completedAt: params.assessedAt,
          });
        },
        findFreshArtifact: async (identity) => {
          const artifact = await deps.assessmentRepo.findFreshArtifact(identity, new Date());
          if (!artifact) return null;
          return {
            id: artifact.id,
            instrumentKind: artifact.instrumentKind,
            venueFamily: artifact.venueFamily,
            styleTier: artifact.styleTier,
            symbol: artifact.symbol,
            network: artifact.network,
            address: artifact.address,
            assessedAt: artifact.assessedAt.toISOString(),
            expiresAt: artifact.expiresAt.toISOString(),
            status: artifact.status,
            allowedPresets: artifact.allowedPresets,
            evidence: artifact.evidence,
            presets: artifact.presets,
            currentStrategy: artifact.currentStrategy,
          };
        },
        latestCompletedRequest: async (identity) => {
          const req = await deps.assessmentRepo.latestCompletedRequest(input.actorId, identity);
          if (!req) return null;
          return {
            id: req.id,
            requestedAt: req.requestedAt.toISOString(),
            completedAt: req.completedAt?.toISOString() ?? null,
            assessmentArtifactId: req.assessmentArtifactId ?? null,
          };
        },
      };
    },
  };
}