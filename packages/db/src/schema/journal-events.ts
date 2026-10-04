import { pgTable, text, timestamp, jsonb, index, primaryKey } from 'drizzle-orm/pg-core';

/**
 * Journal events — append-only audit log.
 * Every significant event: decisions, risk rejections, order updates,
 * fills, balance changes, reconciliation events, credential access.
 * venueAccountId is NOT added here — it lives in the event payload for relevant types.
 *
 * ─── PARTITIONED TABLE — READ BEFORE REGENERATING ───────────────────────────
 * `journal_events` is PARTITIONED BY RANGE (created_at) in Postgres, created by
 * the CUSTOM migration `drizzle/0008_journal_partitioning.sql`. drizzle-kit
 * CANNOT model declarative partitioning: it only sees a plain table with a
 * composite PK `(id, created_at)`. The custom migration is the SOLE source of
 * truth for this table's physical shape (RANGE partitioning, monthly + default
 * partitions, parent-level indexes).
 *
 * The composite PK below is declared ONLY so `drizzle-kit generate` sees the
 * same PK the custom migration already created and produces NO diff for this
 * table. DO NOT let `drizzle-kit generate` regenerate or ALTER `journal_events`
 * — if a diff ever appears for it, reconcile toward "no change", never apply a
 * generated ALTER that would try to recreate the PK or drop the partitioning.
 * ────────────────────────────────────────────────────────────────────────────
 */
export const journalEvents = pgTable('journal_events', {
  id: text('id').notNull(),                  // UUID (crypto.randomUUID, v4); unique in practice
  // tradingInstanceId REMOVED — journal events are actor-scoped
  /** Actor type: agent | bot | user | system (nullable — some system events have no actor) */
  actorType: text('actor_type'),
  /** Stable identifier of the actor (nullable — null for system events) */
  actorId: text('actor_id'),
  /** Optional backtest run scope — null for live events */
  backtestRunId: text('backtest_run_id'),
  /** Event type, e.g. "decision.created", "order.filled", "risk.breach" */
  type: text('type').notNull(),
  /** Structured event payload (contains venueAccountId where relevant) */
  payload: jsonb('payload').notNull().$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Composite PK includes the partition key (created_at) — required by Postgres
  // for a RANGE-partitioned table. See the partitioning note above.
  primaryKey({ columns: [t.id, t.createdAt] }),
  index('idx_journal_events_actor_id').on(t.actorId),
  index('idx_journal_events_type').on(t.type),
  index('idx_journal_events_created_at').on(t.createdAt),
  index('idx_journal_events_backtest_run_id').on(t.backtestRunId),
]);
