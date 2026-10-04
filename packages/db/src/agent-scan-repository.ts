import crypto from 'node:crypto';
import { inArray, lt } from 'drizzle-orm';
import type { Database } from './index.js';
import { agentScanCandidates, agentScanMetrics } from './schema/index.js';

/**
 * Scan-persistence repository (Wave E / E1-T T3). Writes scanner candidate
 * observations and per-scan metrics rows, and prunes both tables in batches so
 * they stay bounded (herobids reads these by a `scannedAt` window and never
 * deleted — Traderton adds the pruner, modelled on the E3 notification prune).
 *
 * Input types mirror the worker's `PersistableScanCandidate` / `ScanMetricInput`
 * shapes field-for-field. They are redeclared HERE (not imported) because
 * `@traderton/db` sits below `@traderton/worker` — importing the worker would be
 * a wrong-direction dependency. The actor passes structurally-compatible values.
 */

/**
 * One scored-candidate row to persist. Mirrors the worker's
 * `PersistableScanCandidate`: `id` is supplied by the caller; string timestamps
 * (`scannedAt`, `dataFreshnessTs`) are ISO strings mapped to `Date` on insert;
 * numeric facts (`confidence`, `volatilityFact`) are numbers mapped to the
 * `numeric` columns as strings. `scanScope` is a plain text column here (matches
 * herobids `agent_scan_candidates.scan_scope text`).
 */
export interface InsertScanCandidate {
  id: string;
  agentId: string;
  scannedAt: string;
  scanVersion: string;
  activePresetKey: string;
  presetBehaviorVersion: string;
  instrumentKind: string;
  venueFamily: string;
  styleTier: string;
  symbol?: string;
  network?: string;
  address?: string;
  rawCandidateId?: string;
  resolutionStatus?: string;
  candidateRank: number;
  scanScope?: string;
  signalFacts: Record<string, unknown>;
  confidence?: number;
  regimeBucket?: string;
  volatilityFact?: number;
  dataFreshnessTs?: string;
  disposition: string;
}

/**
 * One per-scan metrics row to persist. Mirrors the worker's `ScanMetricInput`.
 * Unlike candidates it carries NO `id` — the repo generates one
 * (`crypto.randomUUID()`, matching PgJournal / consumer-notifications). `scanScope`
 * is a jsonb Record here (matches herobids `agent_scan_metrics.scan_scope jsonb`).
 * `scannedAt` is an ISO string mapped to `Date`; `topConfidence` is a number|null
 * mapped to the `numeric` column as a string|null.
 */
export interface InsertScanMetric {
  agentId: string;
  presetKey: string;
  presetBehaviorVersion: string;
  venueFamily: string;
  styleTier: string;
  scanScope: Record<string, unknown>;
  scannedAt: string;
  candidatesDiscovered: number;
  candidatesScored: number;
  signalsGenerated: number;
  scanHealth: string;
  topConfidence: number | null;
  regimeBucket: string | null;
}

/** Postgres-backed repository for `agent_scan_candidates` + `agent_scan_metrics`. */
export class AgentScanRepository {
  constructor(private readonly db: Database) {}

  /**
   * Bulk-insert scored-candidate rows. The caller supplies each `id`. String
   * timestamps become `Date`; numeric facts become numeric-column strings. A
   * no-op (returns early) when the batch is empty so an empty scan writes nothing.
   */
  async insertCandidates(candidates: InsertScanCandidate[]): Promise<void> {
    if (candidates.length === 0) return;
    await this.db.insert(agentScanCandidates).values(
      candidates.map((c) => ({
        id: c.id,
        agentId: c.agentId,
        scannedAt: new Date(c.scannedAt),
        scanVersion: c.scanVersion,
        activePresetKey: c.activePresetKey,
        presetBehaviorVersion: c.presetBehaviorVersion,
        instrumentKind: c.instrumentKind,
        venueFamily: c.venueFamily,
        styleTier: c.styleTier,
        symbol: c.symbol ?? null,
        network: c.network ?? null,
        address: c.address ?? null,
        rawCandidateId: c.rawCandidateId ?? null,
        resolutionStatus: c.resolutionStatus ?? null,
        candidateRank: c.candidateRank,
        scanScope: c.scanScope ?? null,
        signalFacts: c.signalFacts,
        confidence: c.confidence !== undefined ? String(c.confidence) : null,
        regimeBucket: c.regimeBucket ?? null,
        volatilityFact: c.volatilityFact !== undefined ? String(c.volatilityFact) : null,
        dataFreshnessTs: c.dataFreshnessTs !== undefined ? new Date(c.dataFreshnessTs) : null,
        disposition: c.disposition,
      })),
    );
  }

  /** Insert one per-scan metrics row. Generates the row `id`. */
  async insertMetrics(metrics: InsertScanMetric): Promise<void> {
    await this.db.insert(agentScanMetrics).values({
      id: crypto.randomUUID(),
      agentId: metrics.agentId,
      presetKey: metrics.presetKey,
      presetBehaviorVersion: metrics.presetBehaviorVersion,
      venueFamily: metrics.venueFamily,
      styleTier: metrics.styleTier,
      scanScope: metrics.scanScope,
      scannedAt: new Date(metrics.scannedAt),
      candidatesDiscovered: metrics.candidatesDiscovered,
      candidatesScored: metrics.candidatesScored,
      signalsGenerated: metrics.signalsGenerated,
      scanHealth: metrics.scanHealth,
      topConfidence: metrics.topConfidence !== null ? String(metrics.topConfidence) : null,
      regimeBucket: metrics.regimeBucket,
    });
  }

  /**
   * Delete candidate rows with `scannedAt < cutoff` in batches of `batchSize`,
   * looping until a batch deletes fewer than `batchSize`. Keyed on `scannedAt`
   * (the scan observation time), consistent with how herobids reads these rows
   * by their `scannedAt` window. Returns the total deleted. Same batched-subselect
   * pattern as `ConsumerNotificationRepository.deleteOlderThan` (Postgres can't
   * LIMIT a plain DELETE).
   */
  async deleteCandidatesOlderThan(cutoff: Date, batchSize: number): Promise<number> {
    let total = 0;
    for (;;) {
      const batchIds = this.db
        .select({ id: agentScanCandidates.id })
        .from(agentScanCandidates)
        .where(lt(agentScanCandidates.scannedAt, cutoff))
        .limit(batchSize);

      const deleted = await this.db
        .delete(agentScanCandidates)
        .where(inArray(agentScanCandidates.id, batchIds))
        .returning({ id: agentScanCandidates.id });

      total += deleted.length;
      if (deleted.length < batchSize) break;
    }
    return total;
  }

  /**
   * Delete metrics rows with `scannedAt < cutoff` in batches of `batchSize`.
   * Same keying and batched pattern as {@link deleteCandidatesOlderThan}.
   */
  async deleteMetricsOlderThan(cutoff: Date, batchSize: number): Promise<number> {
    let total = 0;
    for (;;) {
      const batchIds = this.db
        .select({ id: agentScanMetrics.id })
        .from(agentScanMetrics)
        .where(lt(agentScanMetrics.scannedAt, cutoff))
        .limit(batchSize);

      const deleted = await this.db
        .delete(agentScanMetrics)
        .where(inArray(agentScanMetrics.id, batchIds))
        .returning({ id: agentScanMetrics.id });

      total += deleted.length;
      if (deleted.length < batchSize) break;
    }
    return total;
  }
}
