// Drives the self-rescheduling prune loop (Wave E / E3-T T5) with an injected
// setTimeout + fake repo/clock, so the two behaviours that matter are asserted
// without real timers: (1) each run deletes rows older than retentionDays in
// pruneBatchSize batches, and (2) a run that THROWS still schedules the next run
// (reschedule-on-failure, the AGENTS rule). No process or clock is touched.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { startConsumerNotificationPruneLoop } from './consumer-notification-prune.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A manual scheduler: `startConsumerNotificationPruneLoop` calls this instead of
 * the global setTimeout, so the test holds every pending callback and fires them
 * one at a time via `tick()`. Only the most recent scheduled callback is kept —
 * the loop only ever has one timer outstanding (setTimeout self-reschedule).
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
    // Let the async run() body (and its finally reschedule) resolve.
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

describe('startConsumerNotificationPruneLoop', () => {
  it('prune loop deletes expired notifications older than retentionDays in batches', async () => {
    const deleteOlderThan = vi.fn().mockResolvedValue(3);
    const scheduler = makeScheduler();
    const logger = buildLogger();
    const before = Date.now();

    startConsumerNotificationPruneLoop({
      repo: { deleteOlderThan },
      retentionDays: RETENTION_DAYS,
      pruneIntervalMs: PRUNE_INTERVAL_MS,
      pruneBatchSize: PRUNE_BATCH_SIZE,
      logger,
      setTimeoutFn: scheduler.setTimeoutFn,
    });

    // First run is scheduled, not immediate — nothing deleted yet.
    expect(deleteOlderThan).not.toHaveBeenCalled();
    expect(scheduler.delays[0]).toBe(PRUNE_INTERVAL_MS);

    await scheduler.tick();

    expect(deleteOlderThan).toHaveBeenCalledTimes(1);
    const [cutoff, batchSize] = deleteOlderThan.mock.calls[0]!;
    const after = Date.now();
    // Cutoff is ~retentionDays old (bounded by the wall clock around the run).
    expect((cutoff as Date).getTime()).toBeGreaterThanOrEqual(before - RETENTION_DAYS * DAY_MS);
    expect((cutoff as Date).getTime()).toBeLessThanOrEqual(after - RETENTION_DAYS * DAY_MS);
    expect(batchSize).toBe(PRUNE_BATCH_SIZE);
    // The next run is scheduled after a successful run.
    expect(scheduler.hasPending()).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('reschedules after a failed run, then runs again', async () => {
    const deleteOlderThan = vi
      .fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce(0);
    const scheduler = makeScheduler();
    const logger = buildLogger();

    startConsumerNotificationPruneLoop({
      repo: { deleteOlderThan },
      retentionDays: RETENTION_DAYS,
      pruneIntervalMs: PRUNE_INTERVAL_MS,
      pruneBatchSize: PRUNE_BATCH_SIZE,
      logger,
      setTimeoutFn: scheduler.setTimeoutFn,
    });

    // Run 1 throws — the loop logs and MUST still schedule the next run.
    await scheduler.tick();
    expect(deleteOlderThan).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(scheduler.hasPending()).toBe(true);

    // Run 2 proceeds — proving the loop survived the failure.
    await scheduler.tick();
    expect(deleteOlderThan).toHaveBeenCalledTimes(2);
    expect(scheduler.hasPending()).toBe(true);
  });

  it('stops scheduling further runs after stop()', async () => {
    const deleteOlderThan = vi.fn().mockResolvedValue(0);
    const scheduler = makeScheduler();
    const logger = buildLogger();

    const handle = startConsumerNotificationPruneLoop({
      repo: { deleteOlderThan },
      retentionDays: RETENTION_DAYS,
      pruneIntervalMs: PRUNE_INTERVAL_MS,
      pruneBatchSize: PRUNE_BATCH_SIZE,
      logger,
      setTimeoutFn: scheduler.setTimeoutFn,
    });

    handle.stop();
    await scheduler.tick();

    // The guarded run no-ops after stop and does not reschedule.
    expect(deleteOlderThan).not.toHaveBeenCalled();
    expect(scheduler.hasPending()).toBe(false);
  });
});
