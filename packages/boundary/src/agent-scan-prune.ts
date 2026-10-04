// The boundary's scan-persistence prune loop (Wave E / E1-T T3). Modelled on
// consumer-notification-prune.ts: a self-rescheduling setTimeout loop (not
// setInterval) that deletes rows older than `retentionDays` from BOTH scan
// tables so they stay bounded. herobids never pruned these tables (it reads
// them by a `scannedAt` window); Traderton adds this loop per the T3 plan.
// Extracted from bin.ts so it is unit-testable without booting the process.

/**
 * Minimal repository surface the scan-prune loop needs — the two
 * `deleteOlderThan` methods on `AgentScanRepository`. Kept structural so the
 * loop can be driven by a fake repo in tests.
 */
interface ScanPruneRepo {
  deleteCandidatesOlderThan(cutoff: Date, batchSize: number): Promise<number>;
  deleteMetricsOlderThan(cutoff: Date, batchSize: number): Promise<number>;
}

/** Minimal logger surface (matches `createLogger` output used in the boundary). */
interface PruneLogger {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/** The `setTimeout` seam — injected so tests drive the loop with a fake clock. */
type SetTimeoutFn = (handler: () => void, ms: number) => { unref?: () => void };

export interface AgentScanPruneDeps {
  repo: ScanPruneRepo;
  /** Rows older than this many days are deleted (from both scan tables). */
  retentionDays: number;
  /** Delay between runs (ms). The NEXT run is scheduled after the current one
   *  finishes, so a slow or failed run can never overlap or kill the loop. */
  pruneIntervalMs: number;
  /** Expired rows deleted per batch, per table, inside each `deleteOlderThan`. */
  pruneBatchSize: number;
  logger: PruneLogger;
  /** Injected `setTimeout` for deterministic tests; defaults to the global. */
  setTimeoutFn?: SetTimeoutFn;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Start the self-rescheduling scan-prune loop and return a stop handle.
 *
 * Each tick prunes BOTH scan tables (candidates + metrics) against the same
 * cutoff, then schedules the next run via `setTimeout` on completion — whether
 * the run succeeded OR threw. A failure is logged (never swallowed) and the loop
 * still reschedules (AGENTS rule: every async loop reschedules itself on
 * failure). A `setTimeout`-based self-reschedule (not `setInterval`) means a
 * slow run can't overlap the next and a throw can't kill the loop. The first run
 * is scheduled after `pruneIntervalMs`, not immediately, so boundary start-up
 * stays unblocked.
 */
export function startAgentScanPruneLoop(deps: AgentScanPruneDeps): { stop: () => void } {
  const schedule = deps.setTimeoutFn ?? ((handler, ms) => setTimeout(handler, ms));
  let stopped = false;

  const scheduleNext = (): void => {
    if (stopped) return;
    // Follow the house convention (consumer-notification prune): do not unref;
    // shutdown stops it explicitly via the returned stop handle and the `stopped`
    // latch no-ops any pending run.
    schedule(() => void run(), deps.pruneIntervalMs);
  };

  const run = async (): Promise<void> => {
    if (stopped) return;
    const cutoff = new Date(Date.now() - deps.retentionDays * DAY_MS);
    try {
      // Prune both tables against the same cutoff. Candidates typically outnumber
      // metrics (many candidates per scan, one metrics row), but each uses its own
      // batched delete so neither starves the other.
      const candidates = await deps.repo.deleteCandidatesOlderThan(cutoff, deps.pruneBatchSize);
      const metrics = await deps.repo.deleteMetricsOlderThan(cutoff, deps.pruneBatchSize);
      if (candidates > 0 || metrics > 0) {
        deps.logger.info(
          { candidates, metrics, cutoff: cutoff.toISOString() },
          'agent-scan prune: deleted expired rows',
        );
      }
    } catch (err) {
      // Log and keep going — a failed prune must not stall the loop.
      deps.logger.error({ err, cutoff: cutoff.toISOString() }, 'agent-scan prune failed; rescheduling');
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
