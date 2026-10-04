import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type postgres from 'postgres';
import type { Database } from './index.js';

/**
 * Partition maintenance for the RANGE-partitioned `journal_events` table
 * (created by drizzle/0008_journal_partitioning.sql). drizzle's query builder
 * does not model declarative partitioning, DDL, or COPY, so this module drives
 * the raw postgres-js client directly.
 *
 * Monthly partitions are named `journal_events_YYYY_MM` with UTC month bounds
 * `FROM 'YYYY-MM-01 00:00:00+00' TO <next-month>-01 00:00:00+00`. A
 * `journal_events_default` DEFAULT partition catches out-of-range rows and is
 * NEVER touched by this module.
 *
 * These are infrastructure DDL operations: they throw on failure (matching the
 * repository/journal-pg style) rather than returning Result. Every async op is
 * awaited so errors propagate to the maintenance loop (S4), which reschedules.
 *
 * ─── SAFETY ─────────────────────────────────────────────────────────────────
 * Partition names are generated from date arithmetic, never user input. As
 * defense-in-depth, every function that interpolates a partition NAME into DDL
 * (which cannot be parameterised) first validates it against
 * `^journal_events_\d{4}_\d{2}$` and throws on mismatch — so a crafted name can
 * never reach the SQL, and the parent/default partitions can never be dropped
 * through these helpers. Row-value SQL uses parameterised bindings.
 * ────────────────────────────────────────────────────────────────────────────
 */

const PARENT_TABLE = 'journal_events';
const DEFAULT_PARTITION = 'journal_events_default';
/** A monthly partition name: `journal_events_YYYY_MM`. Excludes the default. */
const MONTHLY_PARTITION_PATTERN = /^journal_events_(\d{4})_(\d{2})$/;

type RawClient = ReturnType<typeof postgres>;

/** Bounds + name for a single monthly partition, all derived from a date. */
export interface MonthPartitionBounds {
  /** `journal_events_YYYY_MM` */
  name: string;
  /** Inclusive lower bound literal, e.g. `2026-10-01 00:00:00+00` */
  lo: string;
  /** Exclusive upper bound literal (next month), e.g. `2026-11-01 00:00:00+00` */
  hi: string;
}

/** Zero-pad a positive integer to two digits. */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Format a UTC year+month (1-based) as the partition's bound literal. */
function monthBoundLiteral(year: number, month1Based: number): string {
  return `${year}-${pad2(month1Based)}-01 00:00:00+00`;
}

/**
 * Partition name for the UTC month containing `d`.
 * Pure — unit-testable without a database.
 */
export function monthPartitionName(d: Date): string {
  return `${PARENT_TABLE}_${d.getUTCFullYear()}_${pad2(d.getUTCMonth() + 1)}`;
}

/**
 * Name + UTC month bounds for the month containing `d`.
 * The lower bound is the first instant of the month; the upper bound is the
 * first instant of the next month (exclusive). Pure — unit-testable.
 */
export function monthPartitionBounds(d: Date): MonthPartitionBounds {
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1; // 1-based
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    name: `${PARENT_TABLE}_${year}_${pad2(month)}`,
    lo: monthBoundLiteral(year, month),
    hi: monthBoundLiteral(nextYear, nextMonth),
  };
}

/**
 * Validate a partition name against the monthly pattern and throw on mismatch.
 * Returns the name so it can be used inline. Rejects the parent, the default,
 * and anything that is not exactly `journal_events_YYYY_MM`.
 */
function assertMonthlyPartitionName(name: string): string {
  if (!MONTHLY_PARTITION_PATTERN.test(name)) {
    throw new Error(
      `Refusing unsafe partition name "${name}": expected journal_events_YYYY_MM`,
    );
  }
  return name;
}

/**
 * Derive a monthly partition's bound LITERALS + exclusive upper-bound Date from
 * its name. Returns null for a non-monthly name. The literals match the format
 * `monthPartitionBounds` emits, so they can be compared against the catalog bound.
 */
function monthBoundsFromName(name: string): { loDate: Date; upper: Date } | null {
  const match = MONTHLY_PARTITION_PATTERN.exec(name);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]); // 1-based
  if (month < 1 || month > 12) return null;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    // Inclusive lower bound = first instant of the month, in UTC.
    loDate: new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0)),
    // Exclusive upper bound = first instant of the following month, in UTC.
    upper: new Date(Date.UTC(nextYear, nextMonth - 1, 1, 0, 0, 0, 0)),
  };
}

/**
 * Parse the `lo`/`hi` bounds out of a Postgres partition-bound expression
 * (`pg_get_expr(relpartbound, ...)`), which for a RANGE partition reads
 * `FOR VALUES FROM ('<lo>') TO ('<hi>')`. Returns the parsed instants (Dates), or
 * null for the DEFAULT partition ("DEFAULT") or any expression that is not a
 * concrete range or whose literals do not parse as valid timestamps. Comparing
 * instants (not strings) is TZ-rendering agnostic.
 */
function parseCatalogRange(bound: string): { lo: Date; hi: Date } | null {
  const m = /FOR VALUES FROM \('([^']+)'\) TO \('([^']+)'\)/.exec(bound);
  if (!m) return null;
  const lo = new Date(m[1]!.trim());
  const hi = new Date(m[2]!.trim());
  if (Number.isNaN(lo.getTime()) || Number.isNaN(hi.getTime())) return null;
  return { lo, hi };
}

/**
 * Partition maintenance operations over the raw postgres-js client.
 *
 * Construct from a `Database` via {@link JournalPartitionMaintenance.fromDatabase}
 * (reaches `$client` with the same sanctioned cast the repo uses in index.ts),
 * or pass the raw client directly in tests.
 */
export class JournalPartitionMaintenance {
  constructor(private readonly client: RawClient) {}

  /**
   * Build from a drizzle `Database`, reaching the underlying postgres-js client.
   * Mirrors the sanctioned `$client` cast used by `closeDatabase` in index.ts.
   */
  static fromDatabase(db: Database): JournalPartitionMaintenance {
    const client = (db as Database & { $client: RawClient }).$client;
    return new JournalPartitionMaintenance(client);
  }

  /**
   * Ensure the current UTC month's partition plus the next `months` monthly
   * partitions exist. Idempotent via `CREATE TABLE IF NOT EXISTS`. Returns the
   * names ensured (current month first).
   */
  async ensureFuturePartitions(months: number): Promise<string[]> {
    if (!Number.isInteger(months) || months < 0) {
      throw new Error(`ensureFuturePartitions: months must be a non-negative integer, got ${months}`);
    }
    const now = new Date();
    const baseYear = now.getUTCFullYear();
    const baseMonth = now.getUTCMonth(); // 0-based
    const ensured: string[] = [];
    for (let offset = 0; offset <= months; offset++) {
      // First instant of (current month + offset), normalised in UTC.
      const monthStart = new Date(Date.UTC(baseYear, baseMonth + offset, 1, 0, 0, 0, 0));
      const bounds = monthPartitionBounds(monthStart);
      // Name + bounds are derived from date arithmetic only; the literals are
      // formatted explicitly. Validate defensively before interpolating.
      assertMonthlyPartitionName(bounds.name);
      await this.client.unsafe(
        `CREATE TABLE IF NOT EXISTS ${bounds.name} PARTITION OF ${PARENT_TABLE} ` +
          `FOR VALUES FROM ('${bounds.lo}') TO ('${bounds.hi}')`,
      );
      ensured.push(bounds.name);
    }
    return ensured;
  }

  /**
   * List the names of monthly partitions whose ENTIRE range is strictly older
   * than `cutoff` (upper bound <= cutoff, so the whole month precedes it).
   * Never includes `journal_events_default`, and never a partition whose name
   * does not match the monthly pattern. The month is derived deterministically
   * from the name (S2 fixed the naming scheme) and cross-checked against the
   * catalog bound.
   */
  async listExpiredPartitions(cutoff: Date): Promise<string[]> {
    const rows = await this.client<{ name: string; bound: string }[]>`
      SELECT child.relname AS name,
             pg_get_expr(child.relpartbound, child.oid) AS bound
      FROM pg_inherits
      JOIN pg_class child ON child.oid = pg_inherits.inhrelid
      JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
      WHERE parent.relname = ${PARENT_TABLE}
    `;
    const expired: string[] = [];
    for (const row of rows) {
      if (row.name === DEFAULT_PARTITION) continue;
      const bounds = monthBoundsFromName(row.name);
      if (!bounds) continue; // not a monthly partition — skip (never default)
      // REAL cross-check (this function gates a destructive DROP, so the catalog
      // bound must actually agree with the name — not merely be "a range"). The
      // DEFAULT partition reports "DEFAULT" (no FROM/TO) and is excluded here too.
      // A name whose catalog range disagrees with the name-derived range is a
      // data defect (should be impossible post-S2); refuse to treat it as expired
      // rather than risk dropping a mis-labelled partition.
      const catalog = parseCatalogRange(row.bound);
      if (!catalog) continue;
      // Compare as instants, not strings: Postgres renders a timestamptz bound in
      // the server's TimeZone (e.g. `+00` vs `+00:00`, or a non-UTC offset), so a
      // literal string compare would spuriously reject a correct partition. Equal
      // instants mean the catalog range agrees with the name-derived range.
      if (
        catalog.lo.getTime() !== bounds.loDate.getTime()
        || catalog.hi.getTime() !== bounds.upper.getTime()
      ) {
        continue; // name/bound mismatch — do not consider it for dropping
      }
      // Entire month is older than the cutoff iff its exclusive upper bound
      // (first instant of the next month) is <= cutoff.
      if (bounds.upper.getTime() <= cutoff.getTime()) {
        expired.push(row.name);
      }
    }
    return expired;
  }

  /**
   * True if the named partition holds any row with `backtest_run_id IS NOT NULL`.
   * The name is validated against the monthly pattern before interpolation
   * (the partition relation cannot be a bind parameter); the row predicate needs
   * no bound values.
   */
  async partitionHasBacktestRows(name: string): Promise<boolean> {
    assertMonthlyPartitionName(name);
    const rows = await this.client.unsafe<{ present: boolean }[]>(
      `SELECT EXISTS (SELECT 1 FROM ${name} WHERE backtest_run_id IS NOT NULL) AS present`,
    );
    return rows[0]?.present ?? false;
  }

  /**
   * Export the partition to `path.join(dir, name + '.csv.gz')` and return the
   * written file path. Uses `COPY (SELECT * FROM <partition>) TO STDOUT WITH CSV`
   * streamed through the postgres-js client (no server-side superuser, unlike
   * `COPY ... TO PROGRAM`), piped through node:zlib gzip into the file. Creates
   * `dir` if missing.
   */
  async archivePartition(name: string, dir: string): Promise<string> {
    assertMonthlyPartitionName(name);
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${name}.csv.gz`);
    // The COPY stream occupies a pool connection until it drains — fine for the
    // sequential S4 maintenance job, relevant only if maintenance ever runs
    // alongside other DB work on a size-1 pool.
    try {
      // `.readable()` yields a Node Readable streaming the COPY TO STDOUT output.
      const source = await this.client
        .unsafe(`COPY (SELECT * FROM ${name}) TO STDOUT WITH CSV`)
        .readable();
      await pipeline(source, createGzip(), createWriteStream(filePath));
    } catch (err) {
      // A mid-stream COPY failure leaves a partial/corrupt .csv.gz. Remove it so
      // the archiveDir never holds a misleading truncated archive (the S4 drop
      // guard must not treat a partial archive as a successful one). Best-effort.
      await rm(filePath, { force: true }).catch(() => { /* ignore cleanup failure */ });
      throw err;
    }
    return filePath;
  }

  /**
   * Drop the named monthly partition. `DROP TABLE` on a RANGE-partition child
   * removes it; it takes an ACCESS EXCLUSIVE lock on the child and a brief
   * catalog lock on the parent (NOT a concurrent detach — if truly lock-light
   * removal is ever needed, S4 would `ALTER TABLE … DETACH PARTITION CONCURRENTLY`
   * first). The name is validated first so the parent and default partitions can
   * never be dropped here.
   */
  async dropPartition(name: string): Promise<void> {
    assertMonthlyPartitionName(name);
    await this.client.unsafe(`DROP TABLE ${name}`);
  }
}
