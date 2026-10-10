import { pgTable, text, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Preset-assessment request bookkeeping (004 "Preset assessment becomes
 * data-only and free"). Traderton-owned, minus every billing column from the
 * herobids source (`market_assessment_requests`). Tracks request status and
 * cooldown bookkeeping per (owner, agent, identity) so a fresh artifact is
 * returned as-is (cache) and a recompute is gated by the per-(agent, identity)
 * cooldown.
 *
 * No `agents`/`users`/`billing_*` FKs — Traderton has no such tables; `agentId`
 * and `ownerId` are soft text references (same convention as `bots` /
 * `consumer_notifications`).
 */
export const marketAssessmentRequests = pgTable('market_assessment_requests', {
  id: text('id').primaryKey(),

  // ── Requester (soft references — no FK) ──
  ownerId: text('owner_id').notNull(),
  agentId: text('agent_id').notNull(),

  // ── Canonical identity columns (authoritative for lookups) ──
  instrumentKind: text('instrument_kind').notNull(),
  venueFamily: text('venue_family').notNull(),
  styleTier: text('style_tier').notNull(),
  symbol: text('symbol'),
  network: text('network'),
  address: text('address'),

  // ── Identity snapshot (audit-only JSON) ──
  identitySnapshot: jsonb('identity_snapshot').notNull().default(sql`'{}'::jsonb`),

  // ── Idempotency & lineage ──
  /** Caller-supplied replay key (plain replay, no billing meaning). */
  idempotencyKey: text('idempotency_key'),
  /** Deterministic key: hash of (agentId, identity, idempotencyKey). */
  requestGroupKey: text('request_group_key').notNull(),

  // ── Lifecycle status ──
  /** in_progress | cache_hit | assessment_completed | provider_failed | cooldown_blocked | identity_unresolved */
  status: text('status').notNull(),

  // ── Linked resources ──
  assessmentArtifactId: text('assessment_artifact_id'),

  // ── Failure ──
  failureCode: text('failure_code'),
  failureMessage: text('failure_message'),

  // ── Timestamps ──
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_market_assessment_requests_identity_lookup')
    .on(t.instrumentKind, t.venueFamily, t.styleTier, t.symbol, t.network, t.address),
  index('idx_market_assessment_requests_agent_requested')
    .on(t.agentId, t.requestedAt),
  uniqueIndex('uq_market_assessment_requests_group_attempt')
    .on(t.requestGroupKey),
  uniqueIndex('uq_market_assessment_requests_group_in_progress')
    .on(t.requestGroupKey)
    .where(sql`${t.status} = 'in_progress'`),
]);

/**
 * Agent strategy-change audit trail (004). The review screen's source: each row
 * records the agent's decision (from → to strategy) and its reason.
 */
export const agentStrategyChanges = pgTable('agent_strategy_changes', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  actorId: text('actor_id').notNull(),
  /** The active strategy before the change (jsonb), or null when none. */
  fromStrategy: jsonb('from_strategy').$type<Record<string, unknown> | null>(),
  /** The active strategy after the change (jsonb). */
  toStrategy: jsonb('to_strategy').$type<Record<string, unknown>>().notNull(),
  /** The assessment artifact that authorised the change. */
  artifactId: text('artifact_id').notNull(),
  /** The agent's stated reason (required — shown on the review screen). */
  reason: text('reason').notNull(),
  /** prepared | applying | applied | failed */
  state: text('state').notNull().default('prepared'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
}, (t) => [
  index('idx_agent_strategy_changes_actor').on(t.actorId, t.createdAt),
  index('idx_agent_strategy_changes_owner').on(t.ownerId, t.createdAt),
]);