// Drives the self-rescheduling scan-prune loop (Wave E / E1-T T3) with an
// injected setTimeout + fake repo/clock, so the behaviours that matter are
// asserted without real timers: (1) each run deletes rows older than
// retentionDays from BOTH scan tables in pruneBatchSize batches, (2) a run that
// THROWS still schedules the next run (reschedule-on-failure, the AGENTS rule),
// and (3) stop() halts scheduling. No process or clock is touched.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { startAgentScanPruneLoop } from './agent-scan-prune.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A manual scheduler: `startAgentScanPruneLoop` calls this instead of the global
 * setTimeout, so the test holds every pending callback and fires them one at a
 * time via `tick()`. Only the most recent scheduled callback is kept — the loop
 * only ever has one timer outstanding (setTimeout self-reschedule).
 */
function makeScheduler() {
  let pending: (() => void) | undefined;
  const delays: number[] = [];
  const setTimeoutFn = (handler: () => void, ms: number) => {
    pending = handler;
    delays.push(ms);
    return { unref: () => undefined };
  };
  /** Fire the pending callback and wait for its async run to settle. */
  const tick = async (): Promise<void> => {
    const next = pending;
    pending = undefined;
    next?.();
    // Let the async run() body (candidates delete, metrics delete, finally
    // reschedule) resolve — a few microtask turns.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { setTimeoutFn, tick, delays, hasPending: () => pending !== undefined };
}

const RETENTION_DAYS = 7;
const PRUNE_INTERVAL_MS = 3_600_000;
const PRUNE_BATCH_SIZE = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

function buildLogger() {
  return { info: vi.fn(), error: vi.fn() };
}

describe('startAgentScanPruneLoop', () => {
  it('prunes both scan tables with a cutoff ~retentionDays old and the batch size', async () => {
    const deleteCandidatesOlderThan = vi.fn().mockResolvedValue(4);
    const deleteMetricsOlderThan = vi.fn().mockResolvedValue(2);
    const scheduler = makeScheduler();
    const logger = buildLogger();
    const before = Date.now();

    startAgentScanPruneLoop({
      repo: { deleteCandidatesOlderThan, deleteMetricsOlderThan },
      retentionDays: RETENTION_DAYS,
      pruneIntervalMs: PRUNE_INTERVAL_MS,
      pruneBatchSize: PRUNE_BATCH_SIZE,
      logger,
      setTimeoutFn: scheduler.setTimeoutFn,
    });

    // First run is scheduled, not immediate — nothing deleted yet.
    expect(deleteCandidatesOlderThan).not.toHaveBeenCalled();
    expect(deleteMetricsOlderThan).not.toHaveBeenCalled();
    expect(scheduler.delays[0]).toBe(PRUNE_INTERVAL_MS);

    await scheduler.tick();

    expect(deleteCandidatesOlderThan).toHaveBeenCalledTimes(1);
    expect(deleteMetricsOlderThan).toHaveBeenCalledTimes(1);

    const after = Date.now();
    const [candCutoff, candBatch] = deleteCandidatesOlderThan.mock.calls[0]!;
    const [metricCutoff, metricBatch] = deleteMetricsOlderThan.mock.calls[0]!;
    // Both tables pruned against a cutoff ~retentionDays old (bounded by the wall
    // clock around the run) and the configured batch size.
    for (const cutoff of [candCutoff, metricCutoff] as Date[]) {
      expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - RETENTION_DAYS * DAY_MS);
      expect(cutoff.getTime()).toBeLessThanOrEqual(after - RETENTION_DAYS * DAY_MS);
    }
    expect(candBatch).toBe(PRUNE_BATCH_SIZE);
    expect(metricBatch).toBe(PRUNE_BATCH_SIZE);
    // The next run is scheduled after a successful run.
    expect(scheduler.hasPending()).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('reschedules after a failed run, then runs again', async () => {
    const deleteCandidatesOlderThan = vi
      .fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce(0);
    const deleteMetricsOlderThan = vi.fn().mockResolvedValue(0);
    const scheduler = makeScheduler();
    const logger = buildLogger();

    startAgentScanPruneLoop({
      repo: { deleteCandidatesOlderThan, deleteMetricsOlderThan },
      retentionDays: RETENTION_DAYS,
      pruneIntervalMs: PRUNE_INTERVAL_MS,
      pruneBatchSize: PRUNE_BATCH_SIZE,
      logger,
      setTimeoutFn: scheduler.setTimeoutFn,
    });

    // Run 1: the candidate delete throws — the loop logs and MUST still schedule
    // the next run. (The metrics delete is short-circuited by the throw.)
    await scheduler.tick();
    expect(deleteCandidatesOlderThan).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(scheduler.hasPending()).toBe(true);

    // Run 2 proceeds — proving the loop survived the failure.
    await scheduler.tick();
    expect(deleteCandidatesOlderThan).toHaveBeenCalledTimes(2);
    expect(deleteMetricsOlderThan).toHaveBeenCalledTimes(1);
    expect(scheduler.hasPending()).toBe(true);
  });

  it('stops scheduling further runs after stop()', async () => {
    const deleteCandidatesOlderThan = vi.fn().mockResolvedValue(0);
    const deleteMetricsOlderThan = vi.fn().mockResolvedValue(0);
    const scheduler = makeScheduler();
    const logger = buildLogger();

    const handle = startAgentScanPruneLoop({
      repo: { deleteCandidatesOlderThan, deleteMetricsOlderThan },
      retentionDays: RETENTION_DAYS,
      pruneIntervalMs: PRUNE_INTERVAL_MS,
      pruneBatchSize: PRUNE_BATCH_SIZE,
      logger,
      setTimeoutFn: scheduler.setTimeoutFn,
    });

    handle.stop();
    await scheduler.tick();

    // The guarded run no-ops after stop and does not reschedule.
    expect(deleteCandidatesOlderThan).not.toHaveBeenCalled();
    expect(deleteMetricsOlderThan).not.toHaveBeenCalled();
    expect(scheduler.hasPending()).toBe(false);
  });
});
