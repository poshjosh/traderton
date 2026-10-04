import { describe, it, expect } from 'vitest';
import {
  JournalPartitionMaintenance,
  monthPartitionName,
  monthPartitionBounds,
  monthStartFromPartitionName,
} from './journal-partition-maintenance.js';

describe('monthPartitionName', () => {
  it('names the partition after the UTC month containing the date', () => {
    expect(monthPartitionName(new Date('2026-10-15T12:00:00Z'))).toBe('journal_events_2026_10');
  });

  it('zero-pads single-digit months', () => {
    expect(monthPartitionName(new Date('2026-01-01T00:00:00Z'))).toBe('journal_events_2026_01');
  });

  it('uses the UTC month, not the local month, at a boundary instant', () => {
    // 2026-11-01T00:00:00Z is November in UTC regardless of local timezone.
    expect(monthPartitionName(new Date('2026-11-01T00:00:00Z'))).toBe('journal_events_2026_11');
  });
});

describe('monthPartitionBounds', () => {
  it('spans the first instant of the month to the first instant of the next', () => {
    const bounds = monthPartitionBounds(new Date('2026-10-15T12:00:00Z'));
    expect(bounds).toEqual({
      name: 'journal_events_2026_10',
      lo: '2026-10-01 00:00:00+00',
      hi: '2026-11-01 00:00:00+00',
    });
  });

  it('rolls the upper bound into the next year for December', () => {
    const bounds = monthPartitionBounds(new Date('2026-12-20T00:00:00Z'));
    expect(bounds).toEqual({
      name: 'journal_events_2026_12',
      lo: '2026-12-01 00:00:00+00',
      hi: '2027-01-01 00:00:00+00',
    });
  });
});

describe('monthStartFromPartitionName', () => {
  it('returns the first UTC instant of the partition month', () => {
    expect(monthStartFromPartitionName('journal_events_2026_10')?.toISOString()).toBe(
      '2026-10-01T00:00:00.000Z',
    );
  });

  it('returns null for the default partition', () => {
    expect(monthStartFromPartitionName('journal_events_default')).toBeNull();
  });

  it('returns null for a non-monthly name', () => {
    expect(monthStartFromPartitionName('journal_events_2026_13')).toBeNull();
    expect(monthStartFromPartitionName('not_a_partition')).toBeNull();
  });
});

describe('partition name validation', () => {
  // The DB-touching methods validate the name before building any SQL, so a bad
  // name is rejected synchronously (the promise rejects) without a connection.
  const maintenance = new JournalPartitionMaintenance(
    undefined as unknown as ConstructorParameters<typeof JournalPartitionMaintenance>[0],
  );

  it('rejects dropping the parent table', async () => {
    await expect(maintenance.dropPartition('journal_events')).rejects.toThrow(/unsafe partition name/);
  });

  it('rejects dropping the default partition', async () => {
    await expect(maintenance.dropPartition('journal_events_default')).rejects.toThrow(/unsafe partition name/);
  });

  it('rejects an injection attempt in the name', async () => {
    await expect(
      maintenance.dropPartition('journal_events_2026_10; DROP TABLE journal_events'),
    ).rejects.toThrow(/unsafe partition name/);
  });

  it('rejects a non-monthly name for partitionHasBacktestRows', async () => {
    await expect(maintenance.partitionHasBacktestRows('journal_events_default')).rejects.toThrow(
      /unsafe partition name/,
    );
  });

  it('rejects a non-monthly name for archivePartition', async () => {
    await expect(maintenance.archivePartition('not_a_partition', '/tmp')).rejects.toThrow(
      /unsafe partition name/,
    );
  });
});
