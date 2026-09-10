import { pgTable, text, timestamp, jsonb, uniqueIndex, index } from 'drizzle-orm/pg-core';

/**
 * Boundary invocations — the M2 REST idempotency store (005 §Deadlines, Retries,
 * And Idempotency). Each side-effecting tool invocation is persisted before its
 * side effect so a retry with the same key yields one persisted invocation and
 * one downstream effect.
 *
 * COPY-ADAPT (decision D1): the table shape mirrors herobids'
 * `blueprint_instantiation_requests` (idempotencyKey + requestHash +
 * responsePayload jsonb + a unique index on the caller/key). Re-keyed to the 005
 * four-tuple `(consumer_id, owner_id, tool_name, idempotency_key)`.
 *
 * AUTHORED deltas (005 adds these; herobids has no in-flight oracle — it is a
 * synchronous replay-or-conflict store):
 *  - the four-tuple key (herobids keys on `(userId, idempotencyKey)`),
 *  - the `state` transitional column (`in_progress` | `terminal`),
 *  - `requestId` / `correlationId`,
 *  - `terminalResponse` (null until terminal),
 *  - `expiresAt` from a caller-supplied retention window (never hard-coded).
 *
 * `terminalResponse` is typed `Record<string, unknown>` to keep `@traderton/db`
 * free of any dependency on `@traderton/boundary` (dependency direction is
 * boundary → db, never the reverse). It stores the mapped `TradertonToolResultV1`.
 */
export const boundaryInvocations = pgTable('boundary_invocations', {
  id: text('id').primaryKey(), // crypto.randomUUID()
  // The 005 four-tuple idempotency key.
  consumerId: text('consumer_id').notNull(),
  ownerId: text('owner_id').notNull(),
  toolName: text('tool_name').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  /** Deterministic SHA-256 request fingerprint (copy-adapted from herobids). */
  requestFingerprint: text('request_fingerprint').notNull(),
  requestId: text('request_id').notNull(),
  correlationId: text('correlation_id').notNull(),
  /** Transitional state: 'in_progress' until the invocation reaches a terminal outcome. */
  state: text('state').notNull().default('in_progress'),
  /** The mapped terminal result (TradertonToolResultV1); null until terminal. */
  terminalResponse: jsonb('terminal_response').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  /** Retention expiry — set by the repo from the caller-supplied retention window. */
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => [
  uniqueIndex('uq_boundary_invocations_key').on(t.consumerId, t.ownerId, t.toolName, t.idempotencyKey),
  index('idx_boundary_invocations_request_id').on(t.requestId),
]);
