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

### S1. Confirm the backtest-row handling
Read the backtest writers/readers (`_deferred-authoring/api-routes/backtests.ts`, the
backtesting package) and decide between "exempt via guard" (design §3) and "separate
table". Record the choice in 004. No code.

### S2. Migration (custom SQL; drizzle doesn't model partitions)
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

### S3. Partition maintenance module
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

### S4. Config + wiring
- Schema + `default.yaml` keys (design §2), with comments. `archiveDir` is operator
  config, not a secret; if an env override is added, add it to `.env.example` and
  `infra/hetzner/.env.environment.example` with comments.
- `bin.ts`: start the maintenance loop behind a Redis lease `lease:journal-maintenance`;
  stop it on shutdown (E2 step 4 handler).
- Test: "maintenance loop runs once per interval under a lease and reschedules after a
  failure".

### S5. Ops docs
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
