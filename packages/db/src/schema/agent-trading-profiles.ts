import { bigint, index, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { AgentRiskOverrides, ExecutionDefaults, RiskPosture } from '@traderton/domain';

/** Traderton-owned enforcement configuration for one agent and venue account. */
export const agentTradingProfiles = pgTable('agent_trading_profiles', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  actorId: text('actor_id').notNull(),
  venueAccountId: text('venue_account_id').notNull(),
  capital: text('capital'),
  riskPosture: jsonb('risk_posture').$type<RiskPosture>(),
  riskOverrides: jsonb('risk_overrides').$type<AgentRiskOverrides>().notNull().default({}),
  executionDefaults: jsonb('execution_defaults').$type<ExecutionDefaults>(),
  revision: bigint('revision', { mode: 'bigint' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('uq_agent_trading_profiles_owner_actor_venue').on(t.ownerId, t.actorId, t.venueAccountId),
  index('idx_agent_trading_profiles_owner_venue').on(t.ownerId, t.venueAccountId),
]);

export interface AgentTradingProfilePreimage {
  id: string;
  ownerId: string;
  actorId: string;
  venueAccountId: string;
  capital: string | null;
  riskPosture: RiskPosture | null;
  riskOverrides: AgentRiskOverrides;
  executionDefaults: ExecutionDefaults | null;
  revision: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentTradingProfileForwardAction {
  actionId: string;
  kind: 'set' | 'clear';
  venueAccountId: string;
  capital: string | null;
  riskPosture: RiskPosture | null;
  executionDefaults: ExecutionDefaults | null;
}

/** Durable preimages for reversible cross-service profile changes. */
export const agentTradingProfileChanges = pgTable('agent_trading_profile_changes', {
  operationId: text('operation_id').notNull(),
  actionId: text('action_id').notNull(),
  ownerId: text('owner_id').notNull(),
  actorId: text('actor_id').notNull(),
  venueAccountId: text('venue_account_id').notNull(),
  /** The profile before the operation, or null when the operation created it. */
  preimage: jsonb('preimage').$type<AgentTradingProfilePreimage | null>(),
  /** Validated desired state retained so the signed actor can resume this operation. */
  forwardAction: jsonb('forward_action').$type<AgentTradingProfileForwardAction>().notNull(),
  /** Revision written by a set action; null means the action cleared the profile. */
  appliedRevision: bigint('applied_revision', { mode: 'bigint' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.operationId, t.actionId] })]);