// Scheduled review pre-check loop (004 "Preset assessment becomes data-only and
// free", S7). Traderton runs the deterministic pre-check over its own
// `agent_scan_candidates` / `agent_scan_metrics` (E1-T T3) and, on a positive
// result, writes an `agent_wake` notification (E3 outbox) with a review-advice
// payload. herobids delivers it and builds the wake text.
//
// Single-flight across replicas via a dedicated InstanceLease (same shape as the
// journal-maintenance loop). Self-rescheduling (reschedules on failure per
// AGENTS). Extracted from bin.ts so it is unit-testable without booting the
// process.

import crypto from 'node:crypto';
import type { PresetAssessmentConfig } from '@traderton/domain';
import { evaluateReviewEligibility, type ActivePresetState, type PersistedScannerCandidate } from '@traderton/domain';

/** Minimal logger surface (matches `createLogger` output used in the boundary). */
interface ReviewLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/** The lease surface the loop needs (acquire/release). */
export interface ReviewLease {
  tryAcquire(): Promise<boolean>;
  release(): Promise<void>;
}

/** The scan-candidate read surface the pre-check needs. */
export interface ReviewScanRepo {
  listRecentCandidates(opts: {
    agentId: string;
    since: Date;
    limit: number;
  }): Promise<Array<{
    id: string;
    agentId: string;
    scannedAt: Date;
    scanVersion: string;
    activePresetKey: string;
    presetBehaviorVersion: string;
    instrumentKind: string;
    venueFamily: string;
    styleTier: string;
    symbol: string | null;
    network: string | null;
    address: string | null;
    candidateRank: number;
    confidence: string | null;
    regimeBucket: string | null;
    volatilityFact: string | null;
    dataFreshnessTs: Date | null;
    disposition: string;
  }>>;
}

/** The notification sink the loop writes review-advice wakes to. */
export interface ReviewNotificationSink {
  append(entry: { type: string; ownerId: string; agentId: string | null; botId: string | null; payload: Record<string, unknown> }): Promise<void>;
}

export interface ReviewPreCheckLoopDeps {
  config: PresetAssessmentConfig;
  scanRepo: ReviewScanRepo;
  notifications: ReviewNotificationSink;
  lease: ReviewLease;
  /** List running agent actors (ownerId + actorId) to review. */
  listRunningAgents(): Promise<Array<{ ownerId: string; actorId: string }>>;
  /** Resolve an agent's active preset state (from the profile's active_strategy). */
  resolveActivePreset(actorId: string): Promise<ActivePresetState | null>;
  logger: ReviewLogger;
  /** Injected setTimeout for deterministic tests; defaults to the global. */
  setTimeoutFn?: (handler: () => void, ms: number) => { unref?: () => void };
}

/**
 * Start the self-rescheduling review pre-check loop and return a stop handle.
 *
 * Each tick: acquire the lease (single-flight), list running agents, and for
 * each agent run the deterministic pre-check over its recent scan candidates.
 * A candidate that passes the eligibility predicate (peer outperformance) and is
 * not in cooldown produces an `agent_wake` notification with a review-advice
 * payload. The loop reschedules in `finally` (AGENTS rule).
 */
export function startReviewPreCheckLoop(deps: ReviewPreCheckLoopDeps): { stop: () => void } {
  const schedule = deps.setTimeoutFn ?? ((handler, ms) => setTimeout(handler, ms));
  let stopped = false;

  const scheduleNext = (): void => {
    if (stopped) return;
    schedule(() => void run(), deps.config.preCheck.reviewIntervalMs);
  };

  const run = async (): Promise<void> => {
    if (stopped) return;
    const acquired = await deps.lease.tryAcquire();
    if (!acquired) {
      scheduleNext();
      return;
    }
    try {
      const agents = await deps.listRunningAgents();
      for (const agent of agents) {
        await reviewAgent(agent.ownerId, agent.actorId);
      }
    } catch (err) {
      deps.logger.error({ err }, 'review pre-check failed; rescheduling');
    } finally {
      await deps.lease.release().catch(() => { /* lease release is best-effort */ });
      scheduleNext();
    }
  };

  const reviewAgent = async (ownerId: string, actorId: string): Promise<void> => {
    const activePreset = await deps.resolveActivePreset(actorId);
    if (!activePreset) return;

    const since = new Date(Date.now() - deps.config.preCheck.candidateMaxAgeMs);
    const candidates = await deps.scanRepo.listRecentCandidates({
      agentId: actorId,
      since,
      limit: 20,
    });

    const cooldownCutoff = new Date(Date.now() - deps.config.preCheck.identityCooldownMs);
    const policy = {
      signalRatioThreshold: deps.config.preCheck.signalRatioThreshold,
      scanMetricsLookbackMs: deps.config.preCheck.scanMetricsLookbackMs,
      minSignalsForActive: deps.config.preCheck.minSignalsForActive,
      identityCooldownMs: deps.config.preCheck.identityCooldownMs,
      candidateMaxAgeMs: deps.config.preCheck.candidateMaxAgeMs,
      policyVersion: deps.config.preCheck.policyVersion,
      enablePeerComparison: deps.config.preCheck.enablePeerComparison,
    };

    const advice: Array<Record<string, unknown>> = [];
    for (const row of candidates) {
      const candidate = toCandidate(row);
      if (!candidate) continue;
      // Stale guard.
      const dataFreshness = row.dataFreshnessTs?.getTime() ?? row.scannedAt.getTime();
      if (Date.now() - dataFreshness > deps.config.preCheck.candidateMaxAgeMs) continue;
      // Cooldown guard (per identity): skip candidates reviewed recently.
      if (row.scannedAt.getTime() >= cooldownCutoff.getTime()) continue;

      const evalResult = evaluateReviewEligibility({ candidate, activePreset, policy });
      if (!evalResult.eligible) continue;

      advice.push({
        identity: candidate.identity,
        candidateRank: candidate.candidateRank,
        activePreset: candidate.activePresetKey,
        presetBehaviorVersion: candidate.presetBehaviorVersion,
        reasons: evalResult.reasons,
      });
    }

    if (advice.length === 0) return;

    await deps.notifications.append({
      type: 'agent_wake',
      ownerId,
      agentId: actorId,
      botId: null,
      payload: {
        wake: {
          wakeId: crypto.randomUUID(),
          reason: 'A peer preset is outperforming your current preset',
          eventIds: [],
          priority: 'normal',
          requestedAt: new Date().toISOString(),
          source: 'scanner',
          context: {
            scannerKind: 'assessment_review',
            advice,
            checkedAt: new Date().toISOString(),
            nextEligibleAt: new Date(Date.now() + deps.config.preCheck.identityCooldownMs).toISOString(),
          },
        },
      },
    });
    deps.logger.info({ actorId, adviceCount: advice.length }, 'review advice emitted');
  };

  scheduleNext();
  return { stop: () => { stopped = true; } };
}

function toCandidate(row: {
  id: string;
  agentId: string;
  scannedAt: Date;
  scanVersion: string;
  activePresetKey: string;
  presetBehaviorVersion: string;
  instrumentKind: string;
  venueFamily: string;
  styleTier: string;
  symbol: string | null;
  network: string | null;
  address: string | null;
  candidateRank: number;
  confidence: string | null;
  regimeBucket: string | null;
  volatilityFact: string | null;
  dataFreshnessTs: Date | null;
  disposition: string;
}): PersistedScannerCandidate | null {
  let identity: PersistedScannerCandidate['identity'];
  if (row.symbol && !row.network && !row.address) {
    identity = { instrumentKind: 'orderbook', venueFamily: row.venueFamily, styleTier: row.styleTier as 'economy' | 'standard' | 'premium', symbol: row.symbol };
  } else if (row.network && row.address && !row.symbol) {
    identity = { instrumentKind: 'swap', venueFamily: row.venueFamily, styleTier: row.styleTier as 'economy' | 'standard' | 'premium', network: row.network, address: row.address };
  } else {
    return null;
  }
  return {
    id: row.id,
    agentId: row.agentId,
    scannedAt: row.scannedAt.toISOString(),
    scanVersion: row.scanVersion,
    activePresetKey: row.activePresetKey,
    presetBehaviorVersion: row.presetBehaviorVersion,
    identity,
    candidateRank: row.candidateRank,
    signalFacts: {},
    confidence: row.confidence !== null ? Number(row.confidence) : undefined,
    regimeBucket: row.regimeBucket ?? undefined,
    volatilityFact: row.volatilityFact !== null ? Number(row.volatilityFact) : undefined,
    dataFreshnessTs: row.dataFreshnessTs?.toISOString(),
    disposition: row.disposition as PersistedScannerCandidate['disposition'],
  };
}