import { pgTable, text, timestamp, jsonb, index, foreignKey } from 'drizzle-orm/pg-core';
import { userCredentials } from './user-credentials.js';
import type { VenueProfile } from '@traderton/domain';

/**
 * Venue accounts — user's authenticated sessions on venues.
 * Each represents one wallet or exchange subaccount.
 */
export const venueAccounts = pgTable('venue_accounts', {
  id: text('id').primaryKey(),               // UUIDv7
  // Soft reference to the owner (decision 10 + soft-reference rule): Traderton does not
  // own user identity; ownerId is an opaque, boundary-validated owner id (was users FK).
  ownerId: text('owner_id').notNull(),
  venue: text('venue').notNull(),            // e.g. "hyperliquid"
  /** Display label, e.g. "My Hyperliquid Main" */
  label: text('label').notNull(),
  /** Venue-specific identifier (subaccount ID, wallet address, etc.) */
  venueAccountRef: text('venue_account_ref'),
  /** Reference to credentials row — ON DELETE RESTRICT prevents dangling references */
  credentialId: text('credential_id'),
  /** Cached result of probe() — instruments, execution modes, auth status. */
  venueProfile: jsonb('venue_profile').$type<VenueProfile>(),
  /** Timestamp of last successful reconciliation pass (cursor) */
  lastReconciledAt: timestamp('last_reconciled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_venue_accounts_owner_id').on(t.ownerId),
  index('idx_venue_accounts_credential_id').on(t.credentialId),
  foreignKey({ columns: [t.credentialId], foreignColumns: [userCredentials.id] }).onDelete('restrict'),
]);
