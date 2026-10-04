// The boundary's journal_events partition-maintenance loop (plan 003 S4).
// Modelled on consumer-notification-prune.ts / agent-scan-prune.ts: a
// self-rescheduling setTimeout loop (not setInterval) so a slow or failed tick
// can never overlap the next or kill the loop. Extracted from bin.ts so it is
// unit-testable without booting the process.
//
// Each tick runs under a single-flight Redis lease (`journal-maintenance`) so
// only ONE replica performs maintenance per tick. It always provisions future
// partitions, and — only when a retention bound is set — drops partitions whose
// whole month precedes the cutoff, guarding backtest-bearing partitions per the
// S1 exempt-via-guard decision.

import { monthStartFromPartitionName } from '@traderton/db';
import type { JournalConfig } from '@traderton/domain';

/**
 * The partition-maintenance surface the loop drives (satisfied by
 * `JournalPartitionMaintenance` in @traderton/db). Kept structural so a fake can
 * drive the loop in tests.
 */
export interface JournalPartitionMaintenancePort {
  /** Ensure the current month + the next `months` monthly partitions exist. */
  ensureFuturePartitions(months: number): Promise<string[]>;
  /** List monthly partitions whose entire range is strictly older than `cutoff`. */
  listExpiredPartitions(cutoff: Date): Promise<string[]>;
  /** True if the named partition holds any row with `backtest_run_id` set. */
  partitionHasBacktestRows(name: string): Promise<boolean>;
  /** Export the partition to `dir` as a gzip archive before dropping it. */
  archivePartition(name: string, dir: string): Promise<string>;
  /** Drop the named monthly partition. */
  dropPartition(name: string): Promise<void>;
}

/**
 * Minimal single-flight lease port. The caller (bin.ts) binds this to an
 * `InstanceLease` with lease id `journal-maintenance`
 * (`lease.acquire('journal-maintenance')` / `lease.release('journal-maintenance')`).
 */
export interface JournalMaintenanceLease {
  /** Acquire the lease. Returns true if this replica now owns the tick. */
  tryAcquire(): Promise<boolean>;
  /** Release the lease (stops the InstanceLease renew timer). */
  release(): Promise<void>;
}

/** Minimal logger surface (matches `createLogger` output used in the boundary). */
interface MaintenanceLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/** The `setTimeout` seam — injected so tests drive the loop with a fake clock. */
type SetTimeoutFn = (handler: () => void, ms: number) => { unref?: () => void };

/**
 * The retention knobs the loop consumes. Derived from the domain config type
 * (`JournalConfig['retention']`) so a future schema key cannot silently drift
 * from what this loop reads — bin.ts passes `appConfig.journal.retention`.
 */
export type JournalRetentionConfig = JournalConfig['retention'];

export interface JournalMaintenanceDeps {
  maintenance: JournalPartitionMaintenancePort;
  lease: JournalMaintenanceLease;
  retention: JournalRetentionConfig;
  logger: MaintenanceLogger;
  /** Injected `setTimeout` for deterministic tests; defaults to the global. */
  setTimeoutFn?: SetTimeoutFn;
}

/**
 * First UTC instant of `(current UTC month - months)`. The partition whose whole
 * month precedes this instant is droppable (its exclusive upper bound <= cutoff).
 * `months <= 0` yields the first instant of the current month.
 */
function monthCutoff(now: Date, months: number): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1, 0, 0, 0, 0));
}

/**
 * Start the self-rescheduling journal-maintenance loop and return a stop handle.
 *
 * Each tick acquires the `journal-maintenance` lease (single-flight across
 * replicas); if another replica holds it the tick is a no-op and reschedules. On
 * acquisition it provisions future partitions, then — only when
 * `auditRetentionMonths` is set — drops expired partitions, releasing the lease
 * in a `finally`. A failed tick is logged (never swallowed) and the loop still
 * reschedules (AGENTS rule: every async loop reschedules itself on failure). The
 * first run is scheduled after `maintenanceIntervalMs`, not immediately, so
 * boundary start-up stays unblocked.
 */
export function startJournalMaintenanceLoop(deps: JournalMaintenanceDeps): { stop: () => void } {
  const schedule = deps.setTimeoutFn ?? ((handler, ms) => setTimeout(handler, ms));
  let stopped = false;

  const scheduleNext = (): void => {
    if (stopped) return;
    // House convention (the other boundary loops): do not unref; shutdown stops
    // it via the returned stop handle and the `stopped` latch no-ops a pending run.
    schedule(() => void run(), deps.retention.maintenanceIntervalMs);
  };

  const run = async (): Promise<void> => {
    if (stopped) return;
    try {
      const acquired = await deps.lease.tryAcquire();
      if (!acquired) {
        // Another replica owns this tick — skip and reschedule.
        return;
      }
      try {
        await runMaintenance(deps);
      } finally {
        // Release in finally so a renew timer never leaks, even on a body throw.
        await deps.lease.release();
      }
    } catch (err) {
      // Log and keep going — a failed tick must not stall the loop.
      deps.logger.error({ err }, 'journal maintenance tick failed; rescheduling');
    } finally {
      scheduleNext();
    }
  };

  scheduleNext();

  return {
    stop: () => {
      stopped = true;
    },
  };
}

/**
 * One maintenance pass (already holding the lease). Always provisions future
 * partitions; drops expired partitions only when `auditRetentionMonths` is set.
 * Per-partition failures are logged and skipped so one bad partition cannot
 * stall the rest; a top-level throw propagates to the loop, which reschedules.
 */
async function runMaintenance(deps: JournalMaintenanceDeps): Promise<void> {
  const { maintenance, retention, logger } = deps;

  // (2) Always provision ahead, even when retention is null.
  await maintenance.ensureFuturePartitions(retention.premakeMonths);

  // (3) Drop expired partitions only when an audit retention bound is set.
  if (retention.auditRetentionMonths === null) return;

  const now = new Date();
  const auditCutoff = monthCutoff(now, retention.auditRetentionMonths);
  const backtestCutoff = retention.backtestRetentionMonths === null
    ? null
    : monthCutoff(now, retention.backtestRetentionMonths);

  const expired = await maintenance.listExpiredPartitions(auditCutoff);
  for (const name of expired) {
    try {
      // Backtest guard (S1 exempt-via-guard): a partition with backtest rows is
      // dropped only when backtestRetentionMonths is set AND its month precedes
      // the backtest cutoff; otherwise skip it.
      if (await maintenance.partitionHasBacktestRows(name)) {
        const monthStart = monthStartFromPartitionName(name);
        const droppable =
          backtestCutoff !== null
          && monthStart !== null
          && monthStart.getTime() < backtestCutoff.getTime();
        if (!droppable) {
          logger.info(
            { partition: name, backtestCutoff: backtestCutoff?.toISOString() ?? null },
            'journal maintenance: skipping backtest-bearing partition (exempt via guard)',
          );
          continue;
        }
      }

      if (retention.archiveBeforeDrop) {
        // Schema guarantees archiveDir is non-null when archiveBeforeDrop is true.
        if (!retention.archiveDir) {
          logger.warn({ partition: name }, 'journal maintenance: archiveBeforeDrop set but archiveDir missing; skipping drop');
          continue;
        }
        await maintenance.archivePartition(name, retention.archiveDir);
      }

      await maintenance.dropPartition(name);
      logger.info({ partition: name }, 'journal maintenance: dropped expired partition');
    } catch (err) {
      // Per-partition best-effort: log and continue so one bad partition does
      // not stall the rest of the tick.
      logger.error({ err, partition: name }, 'journal maintenance: failed to process partition; continuing');
    }
  }
}
