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

### S3. Partition maintenance module — PENDING
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

### S4. Config + wiring — PENDING
- Schema + `default.yaml` keys (design §2), with comments. `archiveDir` is operator
  config, not a secret; if an env override is added, add it to `.env.example` and
  `infra/hetzner/.env.environment.example` with comments.
- `bin.ts`: start the maintenance loop behind a Redis lease `lease:journal-maintenance`;
  stop it on shutdown (E2 step 4 handler).
- Test: "maintenance loop runs once per interval under a lease and reschedules after a
  failure".

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
