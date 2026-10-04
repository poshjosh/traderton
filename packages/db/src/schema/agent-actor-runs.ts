import { pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Agent-actor runs — the persisted lifecycle intent for an agent-direct actor
 * (Wave E / E1-T T5).
 *
 * `start_agent_actor` upserts `desired_state='running'` with the resolved venue
 * coordinates; `stop_agent_actor` sets `desired_state='stopped'`. The boundary
 * reads `running` rows on boot (rehydrate) and in the periodic orphan sweep
 * (re-ensure dead-but-running actors; stop bots whose creator agent is no longer
 * running). This is the DURABLE lifecycle record the actor registry (in-process,
 * ephemeral) does not provide — it survives a Traderton restart.
 *
 * Soft references only (no FK): `owner_id` is the herobids user id (platform,
 * not a Traderton table) and `actor_id` is the agent id (also platform). Keyed
 * uniquely on `(owner_id, actor_id)` — one run row per agent per owner, upserted
 * on conflict.
 *
 * One-replica assumption (E1): agent actors have no lease yet (that is E4). The
 * rehydrate + sweep both go through the single ensure entry point so E4 can make
 * them lease-aware without touching this table's shape.
 */
export const agentActorRuns = pgTable('agent_actor_runs', {
  id: text('id').primaryKey(),               // UUIDv7 (crypto.randomUUID)
  /** Herobids user id (soft owner) — part of the lifecycle key + rehydrate coords. */
  ownerId: text('owner_id').notNull(),
  /** The agent id (soft reference; agents are platform-owned, not a Traderton table). */
  actorId: text('actor_id').notNull(),
  /** INJECTED resolved venue-account the actor runs against — needed to rebuild the spec. */
  venueAccountId: text('venue_account_id').notNull(),
  /** Resolved venue name (e.g. hyperliquid, jupiter). */
  venue: text('venue').notNull(),
  /** Resolved venue type: orderbook | swap. */
  venueType: text('venue_type').notNull(),
  /** Lifecycle intent: 'running' (start_agent_actor) | 'stopped' (stop_agent_actor). */
  desiredState: text('desired_state').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // One run row per (owner, actor) — the upsert conflict target.
  uniqueIndex('uq_agent_actor_runs_owner_actor').on(t.ownerId, t.actorId),
]);
