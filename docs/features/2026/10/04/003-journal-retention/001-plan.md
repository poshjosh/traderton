# 001 — `journal_events` retention + partitioning (audit-log growth)

**Status:** planned. **Date:** 2026-10-04. **Repos:** traderton only.
**Depends on:** nothing. Best done **before real data exists** (greenfield cutover, per
CANONICAL-STATE §2.0), when converting the table is a cheap drop-and-recreate.
**Not cutover-blocking.** Replaces 010 B13's "better later" with a plan.
**Related:** Wave E notifications have their own table and pruning
([E3 plan](../001-wave-e-actor-events-and-lifecycle/002-e3-consumer-event-channel-plan.md)),
so they add nothing to this table.

## Where the data lives

Traderton's own Postgres, table `journal_events`
(`packages/db/src/schema/journal-events.ts`; created in `drizzle/0000_init_trading_schema.sql`).
- **Contents:** an append-only trading audit log of decisions, risk rejections, orders,
  fills, reconciliation, strategy errors, stream disconnects and backtest-run events
  (`backtest_run_id`).
- **Writers:** `PgJournal.append/appendBatch` (engine, actors).
- **Readers:**
  - `query` → `get_owner_bot_journal`
  - `loadAgentJournalEvents` → `get_agent_journal_events` → herobids agent evaluation
  - `scanAfter` / `getByIds` / `getById` → herobids AlertDispatcher
  - `queryByTypes` / `queryByTypePrefix` → analytics
  - backtest views (by `backtest_run_id`)
- **Today:** nothing deletes rows, and growth is proportional to trading activity.
  Indexes exist on `actor_id`, `type`, `created_at` and `backtest_run_id`.

## Goal

Bounded, operator-controlled growth that doesn't touch trading correctness, with cheap
removal of old data.

## Design

1. **Monthly range partitions on `created_at`.** Dropping or detaching a whole month is
   instant and lock-light, unlike a large `DELETE`. Postgres requires the partition key in
   the primary key, so the PK becomes `(id, created_at)`. `id` stays UUIDv7 and unique in
   practice. `getById` / `getByIds` keep working: they filter on `id`, and the index on
   `id` stays.
2. **Retention policy as operator config** (`config/default.yaml` + schema, commented):
   ```yaml
   journal:
     retention:
       auditRetentionMonths: null   # null = keep forever (default until the policy is decided)
       archiveBeforeDrop: false     # export a partition before dropping it
       archiveDir: null             # local dir mounted for backups (see infra backups)
       premakeMonths: 3             # partitions created ahead of time
       maintenanceIntervalMs: 86400000
   ```
   With the default `null` nothing is ever dropped. Shipping the mechanism doesn't wait on
   the policy decision.
3. **Backtest rows are exempt.** Rows with `backtest_run_id IS NOT NULL` belong to a
   backtest run's results. They live in the same partitions, so a drop would delete them.
   The plan therefore keeps the default retention `null`. When retention is enabled, the
   maintenance job refuses to drop a partition that contains backtest rows unless
   `backtestRetentionMonths` (separate key, default null) also allows it. Alternative,
   decided at S1: route backtest events to their own table. Flagged as a residual question.
4. **Maintenance job** (in `bin.ts`, single-flight via a Redis lease so multiple replicas
   are safe):
   - Daily, create the next `premakeMonths` partitions.
   - If retention is set, detach partitions older than the cutoff, optionally archive
     them with `COPY … TO` into `archiveDir` as gzip, then drop.
   - Reschedules on failure.
   - A default partition catches out-of-range rows, so an insert never fails if the
     job lags.

## Steps

### S1. Confirm the backtest-row handling — DONE
Read the backtest writers/readers (`_deferred-authoring/api-routes/backtests.ts`, the
backtesting package) and decide between "exempt via guard" (design §3) and "separate
table". Record the choice in 004. No code.

**Decision (2026-10-04): exempt-via-guard** (design §3), NOT a separate table. Backtest
rows stay in `journal_events` keyed by the nullable `backtest_run_id`; the S3 maintenance
job guards against dropping a partition containing backtest rows unless
`backtestRetentionMonths` (default `null`) allows it. Verified in source: the only
backtest reader is `PgJournal.query({ backtestRunId })` via `GET /backtests/:runId/journal`
(in `packages/worker/src/_deferred-authoring/api-routes/backtests.ts`); `getById` /
`getByIds` / `scanAfter` are id/cursor reads spanning all rows. Reasoning recorded in
[004-decision-log.md](../../../../initial/004-decision-log.md) ("Why backtest journal rows
are exempt-via-guard, not a separate table").

### S2. Migration (custom SQL; drizzle doesn't model partitions) — DONE
- `drizzle-kit generate --custom` → `000N_journal_partitioning.sql`:
  - rename the old table
  - create a partitioned `journal_events` (same columns, PK `(id, created_at)`)
  - create the current + next `premakeMonths` partitions and a DEFAULT partition
  - recreate the indexes on the parent
  - copy rows (greenfield: none expected)
  - drop the old table
- Update `journal-events.ts`: PK to `(id, created_at)`, plus a comment that the table is
  partitioned by a custom migration, so drizzle must not regenerate it. Run
  `drizzle-kit generate` afterwards and confirm it produces **no** diff for
  `journal_events`.
- Integration test (real Postgres):
  - "journal writes land in the current month's partition"
  - "getById and scanAfter return rows across partitions in order"

#### S2 implementation notes (2026-10-04)

**Files changed**
- `packages/db/src/schema/journal-events.ts` — PK changed from `id.primaryKey()`
  to a composite `primaryKey({ columns: [id, createdAt] })` (imported `primaryKey`
  from `drizzle-orm/pg-core`); `id` is now `.notNull()` only. Added a prominent
  block comment: the table is RANGE-partitioned via the custom migration, drizzle
  cannot model partitions, and `drizzle-kit generate` must never regenerate it.
- `packages/db/drizzle/0008_journal_partitioning.sql` — the custom migration (see
  SQL summary below).
- `packages/db/drizzle/meta/0008_snapshot.json` + `meta/_journal.json` — generated
  by drizzle-kit; the snapshot records the composite PK so generate is a no-op.
- `packages/db/src/journal-partitioning.integration.test.ts` — new gated
  integration tests.
- `scripts/shell/tests/run-integration.sh` — appended the new test file (with a
  descriptive comment) to the `--no-file-parallelism` vitest list.

**Exact drizzle-kit invocation / how the no-diff state was achieved**
- Ran `pnpm --filter @traderton/db exec drizzle-kit generate --name journal_partitioning`
  AFTER editing the schema to the composite PK. drizzle-kit 0.31 has no
  empty-custom-file flag that also writes a snapshot for a schema change; a plain
  `generate` was the correct tool here because the schema change (composite PK)
  is exactly what must be captured in the snapshot. It produced
  `0008_journal_partitioning.sql` (a one-line `ADD CONSTRAINT … PRIMARY KEY`),
  its `0008_snapshot.json` (composite PK modelled), and the `_journal.json` entry.
- I then **replaced the generated SQL body** with the hand-authored partitioning
  SQL, keeping the generated snapshot + journal entry untouched. Because the
  snapshot already reflects the composite PK, a subsequent
  `pnpm --filter @traderton/db exec drizzle-kit generate` prints
  **"No schema changes, nothing to migrate"** — verified. The `idx_journal_events_id`
  index is intentionally NOT in the schema/snapshot; drizzle only drops indexes it
  tracks, so its presence does not produce a diff.

**Migration SQL summary (statement order)**
1. `ALTER TABLE journal_events RENAME TO journal_events_legacy`
2. `CREATE TABLE journal_events (… , CONSTRAINT journal_events_id_created_at_pk PRIMARY KEY (id, created_at)) PARTITION BY RANGE (created_at)`
3. four monthly partitions (UTC bounds):
   - `journal_events_2026_10` [2026-10-01, 2026-11-01)
   - `journal_events_2026_11` [2026-11-01, 2026-12-01)
   - `journal_events_2026_12` [2026-12-01, 2027-01-01)
   - `journal_events_2027_01` [2027-01-01, 2027-02-01)
4. `journal_events_default` DEFAULT partition
5. `INSERT INTO journal_events … SELECT … FROM journal_events_legacy` (greenfield: 0 rows)
6. `DROP TABLE journal_events_legacy`
7. recreate the four parent indexes + add `idx_journal_events_id` on `(id)`

**Index-ordering gotcha (resolved):** Postgres index names are schema-global and
the `RENAME TO journal_events_legacy` carries the original `idx_journal_events_*`
names with it. Recreating them on the new parent before dropping the legacy table
fails with `relation "idx_journal_events_actor_id" already exists`. Fix: index
(re)creation runs AFTER `DROP TABLE journal_events_legacy` (step 7), which frees
the names. Row copy (step 5) happens before the drop, so no data is lost.

**Added index:** `idx_journal_events_id` — a plain btree on `(id)`. The old
single-column PK's implicit unique index is gone (a partitioned table cannot have
a unique index on `id` alone without the partition key), so this keeps
`getById` / `getByIds` indexed. It is a non-unique btree; `id` stays unique in
practice via `crypto.randomUUID()`.

**Verification run:** `pnpm --filter @traderton/db build`, `pnpm lint`, and
`pnpm exec vitest run packages/db/src` (unit) all pass; the two new integration
tests skip without `DATABASE_URL`. Proven **live** against a throwaway
`postgres:16`: `pnpm --filter @traderton/db db:migrate` applied 0000→0008
cleanly, `\d+ journal_events` showed RANGE partitioning + composite PK + 5
partitions + all indexes, and both new integration tests passed (run with
`--no-file-parallelism` alongside `journal-pg.integration.test.ts` — all 7 green;
they share the `journal_events` table so parallel file execution clobbers state,
which is exactly why the runner uses `--no-file-parallelism`).

### S3. Partition maintenance module — DONE
- `packages/db/src/journal-partition-maintenance.ts`:
  - `ensureFuturePartitions(months)`
  - `listExpiredPartitions(cutoff)`
  - `archivePartition(name, dir)`
  - `dropPartition(name)`
  - All SQL is parameterised; partition names are generated from dates only.
- Tests (integration):
  - "creates missing future partitions idempotently"
  - "lists only partitions entirely older than the cutoff"
  - "does not drop a partition containing backtest rows when backtest retention is unset"
  - "archives then drops an expired partition"

#### S3 implementation notes (2026-10-04)

**Files changed**
- `packages/db/src/journal-partition-maintenance.ts` — new module (see shape below).
- `packages/db/src/index.ts` — exports `JournalPartitionMaintenance`,
  `monthPartitionName`, `monthPartitionBounds`, and the `MonthPartitionBounds` type.
- `packages/db/src/journal-partition-maintenance.test.ts` — pure unit tests
  (naming/bounds + name-validation rejection; no DB, runs under `pnpm test`).
- `packages/db/src/journal-partition-maintenance.integration.test.ts` — new
  `DATABASE_URL`-gated integration tests (the four plan scenarios).
- `scripts/shell/tests/run-integration.sh` — appended the new integration file to
  the `--no-file-parallelism` vitest list with a descriptive comment.

**Module shape** — a `JournalPartitionMaintenance` class holding the raw
postgres-js client (DDL/COPY are not modelled by drizzle's query builder). It is
constructed either directly from the raw client (tests) or via
`JournalPartitionMaintenance.fromDatabase(db)`, which reaches `$client` with the
same sanctioned cast `closeDatabase` uses in `index.ts` — no new `any`/`@ts-ignore`.
A class (not a function module) was chosen to match the repo's repository style and
to carry the client once. Two pure helpers (`monthPartitionName`,
`monthPartitionBounds`) are exported standalone so the naming/bounds logic has
DB-free unit tests. Public methods: `ensureFuturePartitions(months)`,
`listExpiredPartitions(cutoff)`, `partitionHasBacktestRows(name)`,
`archivePartition(name, dir)`, `dropPartition(name)`. These are infra DDL ops and
throw on failure (matching `journal-pg.ts`/repositories); every async op is awaited
so errors propagate to the S4 loop rather than being swallowed.

**COPY/archive approach chosen + why** — `archivePartition` uses
`COPY (SELECT * FROM <partition>) TO STDOUT WITH CSV` obtained as a Node `Readable`
via postgres-js `.unsafe(sql).readable()`, piped through `node:zlib` `createGzip()`
into `path.join(dir, name + '.csv.gz')` with `stream/promises.pipeline`. `COPY … TO
PROGRAM 'gzip > …'` was rejected because `TO PROGRAM` requires a server-side
superuser (and runs on the DB host, not where `archiveDir` is mounted); streaming
`TO STDOUT` through the client needs no elevated role and writes the file on the
process that owns the archive directory. `dir` is created with `fs.mkdir recursive`.

**Name-validation guard** — a single `^journal_events_\d{4}_\d{2}$` regex
(`assertMonthlyPartitionName`) runs before any partition NAME is interpolated into
SQL (names can't be bind parameters for relations/DDL). It throws on anything that
is not exactly a monthly partition, so the parent `journal_events` and
`journal_events_default` can never be archived/dropped through these helpers, and a
crafted name (e.g. a `; DROP TABLE …` suffix) is rejected synchronously before SQL
is built. Row-value SQL (`backtest_run_id IS NOT NULL`, catalog lookups) uses the
parameterised tagged-template form or needs no bound values.

**How partition bounds are derived** — names and bounds come from UTC date
arithmetic only. `ensureFuturePartitions` computes the current UTC month + the next
`months` months, formatting explicit `'YYYY-MM-01 00:00:00+00'` literals, and uses
`CREATE TABLE IF NOT EXISTS … PARTITION OF …` for idempotency.
`listExpiredPartitions` enumerates the parent's children via
`pg_inherits`/`pg_class` + `pg_get_expr(relpartbound, …)`, derives each monthly
partition's exclusive upper bound deterministically from its name (S2 fixed the
scheme), cross-checks that the catalog bound is a concrete `FOR VALUES FROM …` range
(so the `DEFAULT` partition is doubly excluded), and lists a partition only when its
upper bound `<=` cutoff (whole month strictly older). Partitions whose names don't
match the monthly pattern are skipped — never the default.

**Verification** — `pnpm --filter @traderton/db build`, `pnpm lint`, and
`pnpm --filter @traderton/db test` all pass; the 10 pure unit tests pass and the 4
new integration tests skip without `DATABASE_URL`. Proven **live** against a
throwaway `postgres:16` (migrations 0000→0008 applied, then the two journal
partition integration files run with `--no-file-parallelism`): all 6 green (4 new
S3 + 2 existing S2). The idempotency test's second `ensureFuturePartitions` call
emits a harmless `relation already exists, skipping` NOTICE — exactly the
`IF NOT EXISTS` path, and partitions survive `TRUNCATE` (only rows are wiped).

**Deviations** — none material. The guard mechanism (`partitionHasBacktestRows`) is
implemented per S1's exempt-via-guard decision; the config keys that drive it
(`backtestRetentionMonths`, retention cutoff) remain S4.

### S4. Config + wiring — DONE
- Schema + `default.yaml` keys (design §2), with comments. `archiveDir` is operator
  config, not a secret; if an env override is added, add it to `.env.example` and
  `infra/hetzner/.env.environment.example` with comments.
- `bin.ts`: start the maintenance loop behind a Redis lease `lease:journal-maintenance`;
  stop it on shutdown (E2 step 4 handler).
- Test: "maintenance loop runs once per interval under a lease and reschedules after a
  failure".

#### S4 implementation notes (2026-10-04)

**Files changed**
- `packages/domain/src/config/schema.ts` — new top-level `journal.retention`
  block in `AppConfigSchema` (inserted after `agentScanner`, before the closing
  `}).superRefine`), each key JSDoc'd. Keys + Zod validation + defaults:
  `auditRetentionMonths` (int ≥1 | null, default null), `backtestRetentionMonths`
  (int ≥1 | null, default null), `archiveBeforeDrop` (bool, default false),
  `archiveDir` (string | null, default null), `premakeMonths` (int ≥0, default 3),
  `maintenanceIntervalMs` (int ≥1, default 86_400_000). Added a `superRefine`
  check: `archiveBeforeDrop === true` ⇒ `archiveDir` must be non-null/non-empty
  (issue path `['journal','retention','archiveDir']`); existing refine checks
  left intact. Exported `JournalConfig = AppConfig['journal']` next to
  `AgentScannerConfig`.
- `config/default.yaml` — `journal.retention` block near `agentScanner:` /
  `notifications:`, one inline `#` comment per key, keep-everything defaults.
- `packages/boundary/src/journal-maintenance.ts` — NEW self-rescheduling loop,
  same shape as `consumer-notification-prune.ts` / `agent-scan-prune.ts`
  (injected `setTimeoutFn` seam, `stopped` latch, `scheduleNext`/`run`,
  reschedule-on-failure, first run after the interval). Injects a
  `JournalPartitionMaintenancePort` (structural over `JournalPartitionMaintenance`),
  a `JournalMaintenanceLease` (`tryAcquire`/`release`), the retention config,
  logger, and the `setTimeoutFn` seam. Each tick: acquire lease → if not acquired
  skip + reschedule (no body, no release) → else `ensureFuturePartitions` always,
  then (only when `auditRetentionMonths` non-null) `listExpiredPartitions(cutoff)`
  and per-partition backtest-guard → archive-if-configured → drop, releasing the
  lease in a `finally`. Per-partition failures log + continue; a top-level throw
  reschedules.
- `packages/db/src/journal-partition-maintenance.ts` + `index.ts` — added a pure,
  exported helper `monthStartFromPartitionName(name): Date | null` (first UTC
  instant of a `journal_events_YYYY_MM` month, null otherwise) so the S4 loop can
  compare a backtest-bearing partition's month against the backtest cutoff. Unit
  tested in `journal-partition-maintenance.test.ts`.
- `packages/boundary/src/bin.ts` — wired the loop near the other `start*Loop`
  wiring: `JournalPartitionMaintenance.fromDatabase(db)` + a DEDICATED
  `InstanceLease` (own worker id `journal-maint-${runtime.workerId}`, NOT the
  runtime's agent/bot lease handle). The lease port binds
  `acquire('journal-maintenance')`/`release('journal-maintenance')`. Started with
  `appConfig.journal.retention`. Added `journalMaintenance.stop()` +
  `journalMaintenanceLease.shutdown()` to the `registerBoundaryShutdown`
  `stopBackgroundLoops` array.
- `packages/worker/src/index.ts` — re-exported `InstanceLease` (it was not on the
  package's public surface). Re-export only; no behaviour authored.
- Tests: `packages/boundary/src/journal-maintenance.test.ts` (7 cases, plain
  `pnpm test`, fakes + injected `setTimeoutFn` + fake lease + fake maintenance);
  `schema.test.ts` journal-defaults + override + archive-refine + bounds cases;
  `journal-partition-maintenance.test.ts` `monthStartFromPartitionName` cases.

**Lease approach** — chose to re-export + reuse the existing `InstanceLease`
(SET NX EX + DEL-if-owner Lua, with a renew timer) rather than hand-roll an
inline lease in bin.ts, per the plan's stated preference ("prefer importing
InstanceLease if available"). It was not previously exported from
`@traderton/worker`, so S4 adds the re-export. A DEDICATED instance (its own
worker id + `renewTimers` map) is constructed — the runtime's agent/bot lease
handle is NOT reused (S1 forbids it). `acquire(id)` starts a renew timer;
`release(id)` stops it, so the acquire→run→release-in-finally per tick leaves no
timer leaked. `InstanceLease.release` is a no-op when another replica owns the
key (DEL-if-owner), so a skipped tick (tryAcquire false) correctly does NOT call
release in the loop.

**Lease KEY (minor deviation):** `InstanceLease` prefixes ids with
`lease:instance:`, so the effective Redis key is
`lease:instance:journal-maintenance`, not the plan's literal
`lease:journal-maintenance`. Reusing the shared lease primitive (and its proven
atomic acquire/renew/release) was judged more valuable than matching the exact
key string; it is still a single dedicated single-flight key. Flagged here so S5
ops docs reference the actual key.

**Month arithmetic for the cutoffs** — the audit cutoff is the first UTC instant
of `(current UTC month − auditRetentionMonths)` via
`new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - N, 1))` (JS Date
normalises the negative/overflowing month), passed straight to
`listExpiredPartitions` (which already lists partitions whose exclusive upper
bound ≤ cutoff). The backtest cutoff is computed the same way from
`backtestRetentionMonths`; a backtest-bearing partition is droppable only when
`backtestRetentionMonths` is set AND its month-start (from
`monthStartFromPartitionName`) is strictly before the backtest cutoff — otherwise
it is skipped (exempt-via-guard, S1).

**Env-override decision — NONE.** `archiveDir` stays yaml-only operator config in
`config/default.yaml`, matching `docs/best-practices/configuration.md` (operator
config in default.yaml, validated at startup via Zod). No `JOURNAL_ARCHIVE_DIR`
env override was added, so no `.env.example` / `infra/hetzner/.env.environment.example`
twins were touched (nothing to document).

**Verification** — `pnpm build`, `pnpm lint`, and `pnpm test` (full unit suite:
2935 passed, 92 integration skipped, 0 failures) all pass. The S4 loop is
unit-tested with fakes; it drives the S3 `JournalPartitionMaintenance` whose
DB-touching behaviour was proven live in S3.

### S5. Ops docs — PENDING
007: the retention knobs, how archives relate to the existing Hetzner backup jobs
(`infra/hetzner/backup*.sh`), and how to restore an archived month (`COPY FROM` into a
re-attached partition).

## Verification
`pnpm build && pnpm lint && pnpm test`; `scripts/shell/tests/run-integration.sh`;
`drizzle-kit generate` produces no diff after S2.

## Docs on completion
010 B13 → Done (link this plan + commit). 004: the retention-mechanism decision and the
backtest-row choice. 007 updated.

## Open (product/compliance; does not block implementation)
- **How long must trading audit events be kept?** This only sets `auditRetentionMonths`.
  The default `null` keeps everything until decided.
- **Must dropped months be archived, or just deleted?** This sets `archiveBeforeDrop`.

### S2 — Outstanding Issues
- [MEDIUM] `id` uniqueness is no longer DB-enforced (the composite PK `(id, created_at)`
  only guarantees the pair; `idx_journal_events_id` is non-unique — a partitioned table
  cannot have a unique index on `id` alone without the partition key). Rests on
  `crypto.randomUUID()` ("unique in practice"); a collision is astronomically unlikely and
  `getById`/`getByIds` would at worst return the colliding pair. No clean partitioned-table
  fix; accepted per the plan's design (§1 "id stays UUIDv7 and unique in practice").
- [LOW, ADDRESSED] Schema comment said "UUIDv7" but `crypto.randomUUID()` is v4 — corrected
  to avoid a false time-ordered invariant. `scanAfter` orders by `created_at` first (id only
  as tie-break), so ordering is unaffected.
- [LOW, ADDRESSED] The "writes land in the month partition" test was pinned to the migration's
  2026-10..2027-02 window; reworked to compute the current UTC month's partition and accept
  the default partition when that month is not yet provisioned (pre-S3), so it does not rot
  into a false failure as real time passes the migration bounds.
- [LOW] Integration test uses `db as unknown as Database` (explained, test-confined).

### S3 — Outstanding Issues
- [MEDIUM, ADDRESSED] `listExpiredPartitions` catalog cross-check was weak (only checked
  "is a range"). Now parses the catalog `FROM/TO` and compares INSTANTS (not strings, to be
  TZ-render agnostic) against the name-derived bounds; a name/bound mismatch is refused (not
  treated as expired) so a mis-labelled partition can never be dropped.
- [MEDIUM, ADDRESSED] `archivePartition` now unlinks a partial `.csv.gz` on a mid-stream COPY
  failure (best-effort), so `archiveDir` never holds a misleading truncated archive before the
  S4 drop guard.
- [LOW, ADDRESSED] `dropPartition` comment corrected (plain `DROP TABLE` takes ACCESS
  EXCLUSIVE on the child + brief parent catalog lock; not a concurrent detach) + a note that
  the archive COPY occupies a pool connection until it drains.

### S4 — Outstanding Issues
- [LOW, ADDRESSED] `JournalRetentionConfig` is now derived from `JournalConfig['retention']`
  (imported from `@traderton/domain`) instead of a hand-maintained duplicate, so a future
  schema key cannot drift from what the loop reads. Required exporting `JournalConfig` from
  the domain `config/index.ts` allowlist (it was defined in schema.ts but not re-exported).
- [LOW, ADDRESSED] Test fake builder no longer uses `as never` (now `satisfies`-style typed
  return).
- [LOW] Lease Redis key is `lease:instance:journal-maintenance` (InstanceLease prefixes the
  id), not the plan's literal `lease:journal-maintenance`. Reused the proven lease primitive;
  S5 ops docs must document the real key.
- NOTE: `packages/domain/src/config/presets.test.ts` + `agent-strategy.parity.test.ts` show
  9+1 failures when vitest is run DIRECTLY on the domain package (ENOENT on
  `config/strategy-presets/*.yaml` — a cwd/path-resolution artifact of the direct run).
  Confirmed PRE-EXISTING on clean HEAD (da783e5), unrelated to S4; the proper test harness
  (`scripts/shell/tests/run-all-tests.sh`) resolves the preset path correctly.
