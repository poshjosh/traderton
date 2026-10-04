-- CUSTOM MIGRATION — journal_events RANGE partitioning (plan 003 S2).
--
-- drizzle-kit cannot model declarative partitioning; it only sees a plain table
-- with a composite PK (id, created_at). This hand-authored migration is the SOLE
-- source of truth for the physical shape of journal_events. The accompanying
-- 0008_snapshot.json records the composite PK so `drizzle-kit generate` produces
-- NO further diff for this table. See packages/db/src/schema/journal-events.ts.
--
-- Converts journal_events into a RANGE-partitioned table on created_at:
--   1. rename the existing table to journal_events_legacy
--   2. create a partitioned journal_events (PK (id, created_at), PARTITION BY RANGE)
--   3. create current-month + premakeMonths(3) monthly partitions (UTC bounds)
--   4. create a DEFAULT partition so out-of-range inserts never fail
--   5. copy rows from the legacy table (greenfield: none expected)
--   6. drop the legacy table — this also drops its indexes, freeing the global
--      index names so the parent can reuse them
--   7. recreate all four indexes on the parent (propagated to partitions) plus a
--      plain btree on (id) so getById/getByIds stay indexed (the single-column
--      PK's implicit unique index is gone — a partitioned table cannot have a
--      unique index on id alone without the partition key)
--
-- Index creation runs AFTER dropping the legacy table because Postgres index
-- names are schema-global: the legacy table (renamed, not re-indexed) still owns
-- idx_journal_events_* until it is dropped, so recreating them earlier collides.
--
-- Month bounds are literal 2026-10..2027-01 — a migration is a point-in-time
-- artifact; the S3 maintenance job creates future partitions going forward.
ALTER TABLE "journal_events" RENAME TO "journal_events_legacy";--> statement-breakpoint
CREATE TABLE "journal_events" (
	"id" text NOT NULL,
	"actor_type" text,
	"actor_id" text,
	"backtest_run_id" text,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_events_id_created_at_pk" PRIMARY KEY("id","created_at")
) PARTITION BY RANGE ("created_at");--> statement-breakpoint
CREATE TABLE "journal_events_2026_10" PARTITION OF "journal_events" FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');--> statement-breakpoint
CREATE TABLE "journal_events_2026_11" PARTITION OF "journal_events" FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');--> statement-breakpoint
CREATE TABLE "journal_events_2026_12" PARTITION OF "journal_events" FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');--> statement-breakpoint
CREATE TABLE "journal_events_2027_01" PARTITION OF "journal_events" FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2027-02-01 00:00:00+00');--> statement-breakpoint
CREATE TABLE "journal_events_default" PARTITION OF "journal_events" DEFAULT;--> statement-breakpoint
INSERT INTO "journal_events" ("id", "actor_type", "actor_id", "backtest_run_id", "type", "payload", "created_at")
	SELECT "id", "actor_type", "actor_id", "backtest_run_id", "type", "payload", "created_at" FROM "journal_events_legacy";--> statement-breakpoint
DROP TABLE "journal_events_legacy";--> statement-breakpoint
CREATE INDEX "idx_journal_events_actor_id" ON "journal_events" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "idx_journal_events_type" ON "journal_events" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_journal_events_created_at" ON "journal_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_journal_events_backtest_run_id" ON "journal_events" USING btree ("backtest_run_id");--> statement-breakpoint
CREATE INDEX "idx_journal_events_id" ON "journal_events" USING btree ("id");
