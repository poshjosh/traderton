import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import type { Database } from './index.js';
import { PgJournal } from './journal-pg.js';
import { openTestDb, truncate, type TestDb } from './test-helpers/integration-db.js';

const SKIP = !process.env['DATABASE_URL'];

/**
 * Proves the RANGE partitioning created by 0008_journal_partitioning.sql:
 * writes land in the correct monthly partition, and id/cursor reads span
 * partitions correctly. The migration must already be applied (the integration
 * runner applies db:migrate before these tests).
 */
describe.skipIf(SKIP)('journal_events partitioning (integration)', () => {
  let client: ReturnType<typeof postgres>;
  let db: TestDb;
  let journal: PgJournal;

  beforeAll(() => {
    const handle = openTestDb();
    db = handle.db;
    client = handle.client;
    // TestDb and Database are structurally identical (same drizzle(client, {schema}) call);
    // the cast is safe — only needed because they originate from different call sites.
    journal = new PgJournal(db as unknown as Database);
  }, 30_000);

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    // TRUNCATE on the parent cascades to every partition.
    await truncate(client, 'journal_events');
  });

  it('journal writes land in the matching month partition when one is provisioned', async () => {
    await journal.append({ type: 'partition.write', payload: { n: 1 } });

    // tableoid resolves the physical partition a row physically lives in.
    const rows = await client<{ id: string; partition: string }[]>`
      SELECT id, tableoid::regclass::text AS partition
      FROM journal_events
      WHERE type = 'partition.write'
    `;

    expect(rows).toHaveLength(1);
    const partition = rows[0]!.partition;

    // The row is written with created_at = now(). Compute the current UTC month's
    // partition name. If the migration (or the S3 maintenance job) has provisioned
    // that month, the row MUST land there (never the catch-all default). If the
    // current month is beyond the migration's pinned window AND S3 has not yet run
    // (so the monthly partition does not exist), the row correctly falls to the
    // default partition — asserting that keeps this test honest as real time passes
    // the migration's hardcoded bounds, rather than silently rotting into a
    // false failure.
    const now = new Date();
    const expectedMonth = `journal_events_${now.getUTCFullYear()}_${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const monthExists = await client<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM pg_class WHERE relname = ${expectedMonth}
      ) AS exists
    `;
    if (monthExists[0]!.exists) {
      expect(partition).toBe(expectedMonth);
    } else {
      // Month not provisioned yet (time has passed the migration window pre-S3) —
      // the default catch-all must absorb it so the insert never fails.
      expect(partition).toBe('journal_events_default');
    }
  });

  it('getById and scanAfter return rows across partitions in created_at order', async () => {
    // Insert directly (not via PgJournal, which stamps now()) so rows span two
    // distinct monthly partitions.
    const earlyId = crypto.randomUUID();
    const lateId = crypto.randomUUID();
    await client`
      INSERT INTO journal_events (id, type, payload, created_at) VALUES
        (${earlyId}, 'span.early', '{}'::jsonb, '2026-10-15 12:00:00+00'),
        (${lateId},  'span.late',  '{}'::jsonb, '2026-12-15 12:00:00+00')
    `;

    // Confirm they really landed in different partitions.
    const placement = await client<{ id: string; partition: string }[]>`
      SELECT id, tableoid::regclass::text AS partition
      FROM journal_events
      WHERE id IN (${earlyId}, ${lateId})
    `;
    const partitions = new Set(placement.map((r) => r.partition));
    expect(partitions.size).toBe(2);

    // getById reads a single row by id regardless of which partition holds it.
    const found = await journal.getById(earlyId);
    expect(found?.type).toBe('span.early');

    // scanAfter orders by (created_at, id) ascending across all partitions.
    const scanned = await journal.scanAfter({ limit: 10 });
    const spanRows = scanned.filter((r) => r.type.startsWith('span.'));
    expect(spanRows.map((r) => r.type)).toEqual(['span.early', 'span.late']);
  });
});
