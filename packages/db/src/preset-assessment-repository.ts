import { and, desc, eq, gte, type SQL } from 'drizzle-orm';
import type { Database } from './index.js';
import {
  agentStrategyChanges,
  marketAssessmentArtifacts,
  marketAssessmentRequests,
  marketAssessmentRuns,
} from './schema/index.js';
import type { MarketAssessmentIdentity } from '@traderton/domain';

/**
 * Preset-assessment repository (004 "Preset assessment becomes data-only and
 * free"). Owns the request bookkeeping (cooldown/cache), the data-only artifact
 * rows, and the agent strategy-change audit trail. No billing — the herobids
 * billing columns are dropped.
 */

/** A request row to insert (id supplied by the caller). */
export interface InsertAssessmentRequest {
  id: string;
  ownerId: string;
  agentId: string;
  instrumentKind: string;
  venueFamily: string;
  styleTier: string;
  symbol?: string;
  network?: string;
  address?: string;
  identitySnapshot: Record<string, unknown>;
  idempotencyKey?: string;
  requestGroupKey: string;
  status: string;
  assessmentArtifactId?: string;
  failureCode?: string;
  failureMessage?: string;
  requestedAt: Date;
  completedAt?: Date;
}

/** A data-only artifact row to insert. */
export interface InsertAssessmentArtifact {
  id: string;
  instrumentKind: string;
  venueFamily: string;
  styleTier: string;
  symbol?: string;
  network?: string;
  address?: string;
  identitySnapshot: Record<string, unknown>;
  assessmentRunId: string;
  assessedAt: Date;
  expiresAt: Date;
  status: string;
  allowedPresets: string[];
  evidence: Record<string, unknown>;
  presets: Record<string, unknown>[];
  currentStrategy: Record<string, unknown>;
  evidenceRefs: string[];
}

/** A data-only assessment run row to insert (artifact FK target). */
export interface InsertAssessmentRun {
  id: string;
  instrumentKind: string;
  venueFamily: string;
  styleTier: string;
  symbol?: string;
  network?: string;
  address?: string;
  identitySnapshot: Record<string, unknown>;
  startedAt: Date;
  completedAt: Date;
  status: string;
  evidenceRefs: string[];
  evidenceSnapshot: Record<string, unknown>;
  scorecardSnapshots: Record<string, unknown>[];
  calculationVersions: Record<string, unknown>;
}

/** A strategy-change audit row to insert. */
export interface InsertAgentStrategyChange {
  id: string;
  ownerId: string;
  actorId: string;
  fromStrategy: Record<string, unknown> | null;
  toStrategy: Record<string, unknown>;
  artifactId: string;
  reason: string;
  state: string;
  appliedAt?: Date;
}

/** Identity where-clause builder shared by the request/artifact lookups. */
function identityConditions(
  identity: MarketAssessmentIdentity,
  table: typeof marketAssessmentRequests | typeof marketAssessmentArtifacts,
): SQL[] {
  const base = [
    eq(table.instrumentKind, identity.instrumentKind),
    eq(table.venueFamily, identity.venueFamily),
    eq(table.styleTier, identity.styleTier),
  ];
  if (identity.instrumentKind === 'swap' || identity.instrumentKind === 'dex') {
    return [...base, eq(table.network, identity.network), eq(table.address, identity.address)];
  }
  return [...base, eq(table.symbol, (identity as Extract<MarketAssessmentIdentity, { instrumentKind: 'orderbook' | 'perp' }>).symbol)];
}

export class PresetAssessmentRepository {
  constructor(private readonly db: Database) {}

  // ── Requests ────────────────────────────────────────────────────────────

  async insertRequest(req: InsertAssessmentRequest): Promise<void> {
    await this.db.insert(marketAssessmentRequests).values({
      id: req.id,
      ownerId: req.ownerId,
      agentId: req.agentId,
      instrumentKind: req.instrumentKind,
      venueFamily: req.venueFamily,
      styleTier: req.styleTier,
      symbol: req.symbol ?? null,
      network: req.network ?? null,
      address: req.address ?? null,
      identitySnapshot: req.identitySnapshot,
      idempotencyKey: req.idempotencyKey ?? null,
      requestGroupKey: req.requestGroupKey,
      status: req.status,
      assessmentArtifactId: req.assessmentArtifactId ?? null,
      failureCode: req.failureCode ?? null,
      failureMessage: req.failureMessage ?? null,
      requestedAt: req.requestedAt,
      completedAt: req.completedAt ?? null,
    });
  }

  /** The most recent completed request for an identity (cooldown bookkeeping). */
  async latestCompletedRequest(
    agentId: string,
    identity: MarketAssessmentIdentity,
  ): Promise<typeof marketAssessmentRequests.$inferSelect | null> {
    const [row] = await this.db
      .select()
      .from(marketAssessmentRequests)
      .where(and(
        eq(marketAssessmentRequests.agentId, agentId),
        ...identityConditions(identity, marketAssessmentRequests),
        eq(marketAssessmentRequests.status, 'assessment_completed'),
      ))
      .orderBy(desc(marketAssessmentRequests.requestedAt))
      .limit(1);
    return row ?? null;
  }

  // ── Runs ────────────────────────────────────────────────────────────────

  async insertRun(run: InsertAssessmentRun): Promise<void> {
    await this.db.insert(marketAssessmentRuns).values({
      id: run.id,
      instrumentKind: run.instrumentKind,
      venueFamily: run.venueFamily,
      styleTier: run.styleTier,
      symbol: run.symbol ?? null,
      network: run.network ?? null,
      address: run.address ?? null,
      identitySnapshot: run.identitySnapshot,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      status: run.status,
      evidenceRefs: run.evidenceRefs,
      evidenceSnapshot: run.evidenceSnapshot,
      scorecardSnapshots: run.scorecardSnapshots,
      calculationVersions: run.calculationVersions,
    });
  }

  // ── Artifacts ───────────────────────────────────────────────────────────

  async insertArtifact(artifact: InsertAssessmentArtifact): Promise<void> {
    await this.db.insert(marketAssessmentArtifacts).values({
      id: artifact.id,
      instrumentKind: artifact.instrumentKind,
      venueFamily: artifact.venueFamily,
      styleTier: artifact.styleTier,
      symbol: artifact.symbol ?? null,
      network: artifact.network ?? null,
      address: artifact.address ?? null,
      identitySnapshot: artifact.identitySnapshot,
      assessmentRunId: artifact.assessmentRunId,
      assessedAt: artifact.assessedAt,
      expiresAt: artifact.expiresAt,
      status: artifact.status,
      allowedPresets: artifact.allowedPresets,
      evidence: artifact.evidence,
      presets: artifact.presets,
      currentStrategy: artifact.currentStrategy,
      evidenceRefs: artifact.evidenceRefs,
    });
  }

  /** The freshest active artifact for an identity, or null. */
  async findFreshArtifact(
    identity: MarketAssessmentIdentity,
    now: Date,
  ): Promise<typeof marketAssessmentArtifacts.$inferSelect | null> {
    const [row] = await this.db
      .select()
      .from(marketAssessmentArtifacts)
      .where(and(
        ...identityConditions(identity, marketAssessmentArtifacts),
        eq(marketAssessmentArtifacts.status, 'active'),
        gte(marketAssessmentArtifacts.expiresAt, now),
      ))
      .orderBy(desc(marketAssessmentArtifacts.assessedAt))
      .limit(1);
    return row ?? null;
  }

  async getArtifactById(
    id: string,
  ): Promise<typeof marketAssessmentArtifacts.$inferSelect | null> {
    const [row] = await this.db
      .select()
      .from(marketAssessmentArtifacts)
      .where(eq(marketAssessmentArtifacts.id, id))
      .limit(1);
    return row ?? null;
  }

  // ── Strategy changes ────────────────────────────────────────────────────

  async insertStrategyChange(change: InsertAgentStrategyChange): Promise<void> {
    await this.db.insert(agentStrategyChanges).values({
      id: change.id,
      ownerId: change.ownerId,
      actorId: change.actorId,
      fromStrategy: change.fromStrategy,
      toStrategy: change.toStrategy,
      artifactId: change.artifactId,
      reason: change.reason,
      state: change.state,
      appliedAt: change.appliedAt ?? null,
    });
  }

  async updateStrategyChangeState(id: string, state: string, appliedAt?: Date): Promise<void> {
    await this.db
      .update(agentStrategyChanges)
      .set({ state, ...(appliedAt ? { appliedAt } : {}) })
      .where(eq(agentStrategyChanges.id, id));
  }

  async listStrategyChanges(opts: {
    ownerId: string;
    actorId: string;
    since?: Date;
    limit: number;
  }): Promise<typeof agentStrategyChanges.$inferSelect[]> {
    const conditions: SQL[] = [
      eq(agentStrategyChanges.ownerId, opts.ownerId),
      eq(agentStrategyChanges.actorId, opts.actorId),
    ];
    if (opts.since) conditions.push(gte(agentStrategyChanges.createdAt, opts.since));
    return this.db
      .select()
      .from(agentStrategyChanges)
      .where(and(...conditions))
      .orderBy(desc(agentStrategyChanges.createdAt))
      .limit(opts.limit);
  }

  /** The most recent applied change for an actor (preset-change cooldown, S6). */
  async latestAppliedChange(actorId: string): Promise<typeof agentStrategyChanges.$inferSelect | null> {
    const [row] = await this.db
      .select()
      .from(agentStrategyChanges)
      .where(and(
        eq(agentStrategyChanges.actorId, actorId),
        eq(agentStrategyChanges.state, 'applied'),
      ))
      .orderBy(desc(agentStrategyChanges.appliedAt))
      .limit(1);
    return row ?? null;
  }
}