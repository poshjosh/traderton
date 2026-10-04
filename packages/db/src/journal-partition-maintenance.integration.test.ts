import crypto from 'node:crypto';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { JournalPartitionMaintenance } from './journal-partition-maintenance.js';
import { openTestDb, truncate } from './test-helpers/integration-db.js';

const SKIP = !process.env['DATABASE_URL'];

/**
 * Exercises the 003 S3 partition maintenance module against real Postgres.
 * The migration (0008_journal_partitioning.sql) must already be applied; the
 * integration runner applies db:migrate first. These suites share the
 * `journal_events` table, so the runner uses --no-file-parallelism.
 */
describe.skipIf(SKIP)('journal partition maintenance (integration)', () => {
  let client: ReturnType<typeof postgres>;
  let maintenance: JournalPartitionMaintenance;

  beforeAll(() => {
    const handle = openTestDb();
    client = handle.client;
    maintenance = new JournalPartitionMaintenance(client);
  }, 30_000);

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    // TRUNCATE on the parent cascades to every partition.
    await truncate(client, 'journal_events');
  });

  /** Ensure a specific monthly partition exists (bounds derived from the date). */
  async function ensureMonth(year: number, month1Based: number): Promise<string> {
    const name = `journal_events_${year}_${String(month1Based).padStart(2, '0')}`;
    const lo = `${year}-${String(month1Based).padStart(2, '0')}-01 00:00:00+00`;
    const nextYear = month1Based === 12 ? year + 1 : year;
    const nextMonth = month1Based === 12 ? 1 : month1Based + 1;
    const hi = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01 00:00:00+00`;
    await client.unsafe(
      `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF journal_events FOR VALUES FROM ('${lo}') TO ('${hi}')`,
    );
    return name;
  }

  it('creates missing future partitions idempotently', async () => {
    const first = await maintenance.ensureFuturePartitions(2);
    expect(first).toHaveLength(3); // current month + 2 ahead

    // Snapshot the set of monthly partitions after the first call.
    const countMonthly = async (): Promise<number> => {
      const rows = await client<{ n: number }[]>`
        SELECT count(*)::int AS n
        FROM pg_inherits
        JOIN pg_class child ON child.oid = pg_inherits.inhrelid
        JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
        WHERE parent.relname = 'journal_events'
          AND child.relname ~ '^journal_events_[0-9]{4}_[0-9]{2}$'
      `;
      return rows[0]!.n;
    };
    const afterFirst = await countMonthly();

    // Second call must create nothing new and must not error.
    const second = await maintenance.ensureFuturePartitions(2);
    expect(second).toEqual(first);
    expect(await countMonthly()).toBe(afterFirst);
  });

  it('lists only partitions entirely older than the cutoff', async () => {
    // Three distinct months. Cutoff sits inside the middle month.
    const sep = await ensureMonth(2025, 9); // [2025-09-01, 2025-10-01)
    const oct = await ensureMonth(2025, 10); // [2025-10-01, 2025-11-01)
    const nov = await ensureMonth(2025, 11); // [2025-11-01, 2025-12-01)

    // Cutoff mid-October: September is entirely older (upper bound 2025-10-01 <= cutoff);
    // October only partially older (upper bound 2025-11-01 > cutoff) → excluded;
    // November entirely newer → excluded.
    const cutoff = new Date('2025-10-15T00:00:00Z');
    const expired = await maintenance.listExpiredPartitions(cutoff);

    expect(expired).toContain(sep);
    expect(expired).not.toContain(oct);
    expect(expired).not.toContain(nov);
    expect(expired).not.toContain('journal_events_default');

    // Edge: a cutoff exactly on October's upper bound makes October entirely older too.
    const boundaryCutoff = new Date('2025-11-01T00:00:00Z');
    const expiredAtBoundary = await maintenance.listExpiredPartitions(boundaryCutoff);
    expect(expiredAtBoundary).toContain(sep);
    expect(expiredAtBoundary).toContain(oct);
    expect(expiredAtBoundary).not.toContain(nov);
    expect(expiredAtBoundary).not.toContain('journal_events_default');
  });

  it('does not drop a partition containing backtest rows when backtest retention is unset', async () => {
    const name = await ensureMonth(2025, 9);
    // A backtest row (backtest_run_id set) in an old partition.
    await client`
      INSERT INTO journal_events (id, type, payload, backtest_run_id, created_at)
      VALUES (${crypto.randomUUID()}, 'backtest.event', '{}'::jsonb, ${crypto.randomUUID()}, '2025-09-15 12:00:00+00')
    `;

    // The guard: the S4 job would consult this and skip the drop (default
    // backtestRetentionMonths = null → backtest rows are never dropped).
    expect(await maintenance.partitionHasBacktestRows(name)).toBe(true);

    // A sibling month with only live rows reports false.
    const liveOnly = await ensureMonth(2025, 8);
    await client`
      INSERT INTO journal_events (id, type, payload, created_at)
      VALUES (${crypto.randomUUID()}, 'order.filled', '{}'::jsonb, '2025-08-15 12:00:00+00')
    `;
    expect(await maintenance.partitionHasBacktestRows(liveOnly)).toBe(false);
  });

  it('archives then drops an expired partition', async () => {
    const name = await ensureMonth(2025, 9);
    await client`
      INSERT INTO journal_events (id, type, payload, created_at)
      VALUES (${crypto.randomUUID()}, 'order.filled', '{"qty":1}'::jsonb, '2025-09-10 09:00:00+00')
    `;

    const dir = await mkdtemp(path.join(tmpdir(), 'journal-archive-'));
    try {
      const filePath = await maintenance.archivePartition(name, dir);
      expect(filePath).toBe(path.join(dir, `${name}.csv.gz`));

      // The gzip file exists and is non-empty.
      const info = await stat(filePath);
      expect(info.size).toBeGreaterThan(0);

      // Decompressing it yields the exported row's CSV content.
      const decompressed = await gunzipFile(filePath);
      expect(decompressed).toContain('order.filled');

      // Drop detaches + removes the partition relation.
      await maintenance.dropPartition(name);
      const stillThere = await client<{ exists: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = ${name}) AS exists
      `;
      expect(stillThere[0]!.exists).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** Read a gzip file and return its decompressed UTF-8 contents. */
async function gunzipFile(filePath: string): Promise<string> {
  const compressed = await readFile(filePath);
  return await new Promise<string>((resolve, reject) => {
    const gunzip = createGunzip();
    const chunks: Buffer[] = [];
    gunzip.on('data', (chunk: Buffer) => chunks.push(chunk));
    gunzip.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    gunzip.on('error', reject);
    gunzip.end(compressed);
  });
}
