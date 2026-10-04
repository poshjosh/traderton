import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';

/**
 * Consumer notifications — the Traderton→consumer outbox (Wave E / E3).
 *
 * Transient delivery records: Traderton writes a row from a composition-level
 * actor callback (scan completed, agent wake, forwarded journal event, bot/agent
 * status), a herobids relay (or any external MCP consumer) polls them cursor-wise
 * via `scan_consumer_notifications` and republishes to its own message types.
 * Rows are pruned after `notifications.retentionDays`, so this is NOT durable
 * history.
 *
 * Deliberately SEPARATE from `journal_events` (the append-only trading audit log,
 * human-approved 2026-10-04): the audit log must stay free of transient delivery
 * noise, the journal views return every type for an actor, and the two have
 * different retention. See 002-e3-consumer-event-channel-plan.md.
 */
export const consumerNotifications = pgTable('consumer_notifications', {
  id: text('id').primaryKey(),               // UUIDv7
  /** Event type: scan_completed | agent_wake | journal_event | bot_status | agent_status */
  type: text('type').notNull(),
  /** Herobids user id (soft owner) — lets the relay publish user bot status with no lookup */
  ownerId: text('owner_id').notNull(),
  /** The agent to notify; for a bot this is its creatorId when creatorType='agent', else null */
  agentId: text('agent_id'),
  /** The bot the event concerns (null for agent-native events) */
  botId: text('bot_id'),
  /** Structured, additive-only event payload (shape per type; see the vocabulary table) */
  payload: jsonb('payload').notNull().$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // (created_at, id) is the stable cursor pair for the ascending scan.
  index('idx_consumer_notifications_created_at_id').on(t.createdAt, t.id),
  index('idx_consumer_notifications_agent_id').on(t.agentId),
]);
