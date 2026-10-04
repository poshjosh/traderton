// Drives the self-rescheduling journal-maintenance loop (plan 003 S4) with an
// injected setTimeout + fake lease + fake JournalPartitionMaintenance, so the
// behaviours that matter are asserted without real timers, Redis, or Postgres:
// (1) one tick per interval under an acquired lease, rescheduling after a
// failure; (2) a lease held elsewhere skips the whole body but still reschedules;
// (3) with auditRetentionMonths null only ensureFuturePartitions runs; (4) the
// backtest guard skips a backtest-bearing partition when backtestRetentionMonths
// is null; (5) archiveBeforeDrop archives before dropping; (6) the lease is
// released in finally even when the body throws.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  startJournalMaintenanceLoop,
  type JournalPartitionMaintenancePort,
  type JournalMaintenanceLease,
  type JournalRetentionConfig,
} from './journal-maintenance.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const INTERVAL_MS = 86_400_000;

/**
 * A manual scheduler: the loop calls this instead of the global setTimeout, so
 * the test holds the single pending callback and fires it via `tick()`. The loop
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
  const tick = async (): Promise<void> => {
    const next = pending;
    pending = undefined;
    next?.();
    // Let the async run() body + its finally reschedule settle.
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };
  return { setTimeoutFn, tick, delays, hasPending: () => pending !== undefined };
}

function buildLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** A fake maintenance port whose methods are all spies with safe defaults. */
function buildMaintenance(
  overrides: Partial<JournalPartitionMaintenancePort> = {},
): JournalPartitionMaintenancePort & {
  ensureFuturePartitions: ReturnType<typeof vi.fn>;
  listExpiredPartitions: ReturnType<typeof vi.fn>;
  partitionHasBacktestRows: ReturnType<typeof vi.fn>;
  archivePartition: ReturnType<typeof vi.fn>;
  dropPartition: ReturnType<typeof vi.fn>;
} {
  const base = {
    ensureFuturePartitions: vi.fn().mockResolvedValue([]),
    listExpiredPartitions: vi.fn().mockResolvedValue([]),
    partitionHasBacktestRows: vi.fn().mockResolvedValue(false),
    archivePartition: vi.fn().mockResolvedValue('/archive/x.csv.gz'),
    dropPartition: vi.fn().mockResolvedValue(undefined),
  };
  return { ...base, ...overrides } as typeof base & JournalPartitionMaintenancePort;
}

/** A fake lease that acquires by default. */
function buildLease(acquired = true): JournalMaintenanceLease & {
  tryAcquire: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
} {
  return {
    tryAcquire: vi.fn().mockResolvedValue(acquired),
    release: vi.fn().mockResolvedValue(undefined),
  };
}

function retention(overrides: Partial<JournalRetentionConfig> = {}): JournalRetentionConfig {
  return {
    auditRetentionMonths: null,
    backtestRetentionMonths: null,
    archiveBeforeDrop: false,
    archiveDir: null,
    premakeMonths: 3,
    maintenanceIntervalMs: INTERVAL_MS,
    ...overrides,
  };
}

describe('startJournalMaintenanceLoop', () => {
  it('runs once per interval under a lease and reschedules after a failure', async () => {
    const maintenance = buildMaintenance({
      ensureFuturePartitions: vi
        .fn()
        .mockRejectedValueOnce(new Error('db down'))
        .mockResolvedValue([]),
    });
    const lease = buildLease(true);
    const scheduler = makeScheduler();
    const logger = buildLogger();

    startJournalMaintenanceLoop({
      maintenance,
      lease,
      retention: retention(),
      logger,
      setTimeoutFn: scheduler.setTimeoutFn,
    });

    // First run is scheduled after the interval, not immediate.
    expect(scheduler.delays[0]).toBe(INTERVAL_MS);
    expect(maintenance.ensureFuturePartitions).not.toHaveBeenCalled();

    // Tick 1: ensure throws → logged, lease released, still reschedules.
    await scheduler.tick();
    expect(lease.tryAcquire).toHaveBeenCalledTimes(1);
    expect(maintenance.ensureFuturePartitions).toHaveBeenCalledTimes(1);
    expect(lease.release).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(scheduler.hasPending()).toBe(true);

    // Tick 2 proceeds — proving the loop survived the failure, one run per tick.
    await scheduler.tick();
    expect(lease.tryAcquire).toHaveBeenCalledTimes(2);
    expect(maintenance.ensureFuturePartitions).toHaveBeenCalledTimes(2);
    expect(lease.release).toHaveBeenCalledTimes(2);
    expect(scheduler.hasPending()).toBe(true);
  });

  it('skips the whole tick when the lease is held elsewhere, but still reschedules', async () => {
    const maintenance = buildMaintenance();
    const lease = buildLease(false); // another replica owns the tick
    const scheduler = makeScheduler();
    const logger = buildLogger();

    startJournalMaintenanceLoop({
      maintenance,
      lease,
      retention: retention({ auditRetentionMonths: 1 }),
      logger,
      setTimeoutFn: scheduler.setTimeoutFn,
    });

    await scheduler.tick();

    expect(lease.tryAcquire).toHaveBeenCalledTimes(1);
    // Not acquired → no ensure, no drops, and release is NOT called (we never held it).
    expect(maintenance.ensureFuturePartitions).not.toHaveBeenCalled();
    expect(maintenance.listExpiredPartitions).not.toHaveBeenCalled();
    expect(maintenance.dropPartition).not.toHaveBeenCalled();
    expect(lease.release).not.toHaveBeenCalled();
    // Still reschedules.
    expect(scheduler.hasPending()).toBe(true);
  });

  it('only provisions future partitions (no drops) when auditRetentionMonths is null', async () => {
    const maintenance = buildMaintenance({
      listExpiredPartitions: vi.fn().mockResolvedValue(['journal_events_2000_01']),
    });
    const lease = buildLease(true);
    const scheduler = makeScheduler();

    startJournalMaintenanceLoop({
      maintenance,
      lease,
      retention: retention({ auditRetentionMonths: null, premakeMonths: 2 }),
      logger: buildLogger(),
      setTimeoutFn: scheduler.setTimeoutFn,
    });

    await scheduler.tick();

    expect(maintenance.ensureFuturePartitions).toHaveBeenCalledWith(2);
    // Retention is null → never even lists or drops.
    expect(maintenance.listExpiredPartitions).not.toHaveBeenCalled();
    expect(maintenance.dropPartition).not.toHaveBeenCalled();
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it('skips a backtest-bearing partition when backtestRetentionMonths is null', async () => {
    const maintenance = buildMaintenance({
      // A long-expired partition that holds backtest rows.
      listExpiredPartitions: vi.fn().mockResolvedValue(['journal_events_2000_01']),
      partitionHasBacktestRows: vi.fn().mockResolvedValue(true),
    });
    const lease = buildLease(true);
    const scheduler = makeScheduler();
    const logger = buildLogger();

    startJournalMaintenanceLoop({
      maintenance,
      lease,
      retention: retention({ auditRetentionMonths: 1, backtestRetentionMonths: null }),
      logger,
      setTimeoutFn: scheduler.setTimeoutFn,
    });

    await scheduler.tick();

    expect(maintenance.partitionHasBacktestRows).toHaveBeenCalledWith('journal_events_2000_01');
    // Exempt-via-guard: no archive, no drop.
    expect(maintenance.archivePartition).not.toHaveBeenCalled();
    expect(maintenance.dropPartition).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it('archives a partition before dropping it when archiveBeforeDrop is set', async () => {
    const archivePartition = vi.fn().mockResolvedValue('/archive/journal_events_2000_01.csv.gz');
    const dropPartition = vi.fn().mockResolvedValue(undefined);
    const maintenance = buildMaintenance({
      listExpiredPartitions: vi.fn().mockResolvedValue(['journal_events_2000_01']),
      partitionHasBacktestRows: vi.fn().mockResolvedValue(false),
      archivePartition,
      dropPartition,
    });
    const lease = buildLease(true);
    const scheduler = makeScheduler();

    startJournalMaintenanceLoop({
      maintenance,
      lease,
      retention: retention({
        auditRetentionMonths: 1,
        archiveBeforeDrop: true,
        archiveDir: '/archive',
      }),
      logger: buildLogger(),
      setTimeoutFn: scheduler.setTimeoutFn,
    });

    await scheduler.tick();

    expect(archivePartition).toHaveBeenCalledWith('journal_events_2000_01', '/archive');
    expect(dropPartition).toHaveBeenCalledWith('journal_events_2000_01');
    // Archive happens before the drop.
    expect(archivePartition.mock.invocationCallOrder[0]!).toBeLessThan(
      dropPartition.mock.invocationCallOrder[0]!,
    );
  });

  it('releases the lease in finally even when the maintenance body throws', async () => {
    const maintenance = buildMaintenance({
      ensureFuturePartitions: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const lease = buildLease(true);
    const scheduler = makeScheduler();
    const logger = buildLogger();

    startJournalMaintenanceLoop({
      maintenance,
      lease,
      retention: retention({ auditRetentionMonths: 1 }),
      logger,
      setTimeoutFn: scheduler.setTimeoutFn,
    });

    await scheduler.tick();

    expect(lease.release).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(scheduler.hasPending()).toBe(true);
  });

  it('stops scheduling further runs after stop()', async () => {
    const maintenance = buildMaintenance();
    const lease = buildLease(true);
    const scheduler = makeScheduler();

    const handle = startJournalMaintenanceLoop({
      maintenance,
      lease,
      retention: retention(),
      logger: buildLogger(),
      setTimeoutFn: scheduler.setTimeoutFn,
    });

    handle.stop();
    await scheduler.tick();

    expect(lease.tryAcquire).not.toHaveBeenCalled();
    expect(maintenance.ensureFuturePartitions).not.toHaveBeenCalled();
    expect(scheduler.hasPending()).toBe(false);
  });
});
