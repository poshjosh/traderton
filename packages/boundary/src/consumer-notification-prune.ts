// Extracted from bin.ts so the boundary's consumer-notification prune loop (Wave
// E / E3-T T5) is unit-testable without booting the process (mirrors the
// boundary-shutdown.ts / build-boundary-runtime.ts extractions). The loop deletes
// outbox rows older than `retentionDays` so the table stays bounded; the relay
// (E3-H) and other MCP consumers must poll within that window.

/** Minimal repository surface the prune loop needs. */
interface PruneRepo {
  deleteOlderThan(cutoff: Date, batchSize: number): Promise<number>;
}

/** Minimal logger surface (matches `createLogger` output used in the boundary). */
interface PruneLogger {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/** The `setTimeout` seam — injected so tests drive the loop with a fake clock. */
type SetTimeoutFn = (handler: () => void, ms: number) => { unref?: () => void };

export interface ConsumerNotificationPruneDeps {
  repo: PruneRepo;
  /** Rows older than this many days are deleted. */
  retentionDays: number;
  /** Delay between runs (ms). The NEXT run is scheduled after the current one
   *  finishes, so a slow or failed run can never overlap or kill the loop. */
  pruneIntervalMs: number;
  /** Expired rows deleted per batch inside `deleteOlderThan`. */
  pruneBatchSize: number;
  logger: PruneLogger;
  /** Injected `setTimeout` for deterministic tests; defaults to the global. */
  setTimeoutFn?: SetTimeoutFn;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Start the self-rescheduling prune loop and return a stop handle.
 *
 * The loop runs one prune, then schedules the next via `setTimeout` on
 * completion — whether the run succeeded OR threw. A failure is logged (never
 * swallowed) and the loop still reschedules (AGENTS rule: every async loop
 * reschedules itself on failure). A `setTimeout`-based self-reschedule (not
 * `setInterval`) means a slow run can't overlap the next and a throw can't kill
 * the loop. The first run is scheduled after `pruneIntervalMs`, not immediately,
 * so boundary start-up stays unblocked.
 */
export function startConsumerNotificationPruneLoop(
  deps: ConsumerNotificationPruneDeps,
): { stop: () => void } {
  const schedule = deps.setTimeoutFn ?? ((handler, ms) => setTimeout(handler, ms));
  let stopped = false;

  const scheduleNext = (): void => {
    if (stopped) return;
    // The economic-calendar loop in bin.ts does not unref its interval, so this
    // keeps the house convention: do not unref (shutdown stops it explicitly via
    // the returned stop handle, and the `stopped` latch no-ops any pending run).
    schedule(() => void run(), deps.pruneIntervalMs);
  };

  const run = async (): Promise<void> => {
    if (stopped) return;
    const cutoff = new Date(Date.now() - deps.retentionDays * DAY_MS);
    try {
      const deleted = await deps.repo.deleteOlderThan(cutoff, deps.pruneBatchSize);
      if (deleted > 0) {
        deps.logger.info({ deleted, cutoff: cutoff.toISOString() }, 'consumer-notification prune: deleted expired rows');
      }
    } catch (err) {
      // Log and keep going — a failed prune must not stall the loop.
      deps.logger.error({ err, cutoff: cutoff.toISOString() }, 'consumer-notification prune failed; rescheduling');
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
