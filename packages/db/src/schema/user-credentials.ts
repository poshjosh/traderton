import { pgTable, text, timestamp, jsonb } from 'drizzle-orm/pg-core';

/**
 * User credentials — encrypted API keys/secrets per provider.
 * Owner-scoped (one owner). Secrets are encrypted at rest.
 * Decrypted just-in-time by the worker.
 */
export const userCredentials = pgTable('user_credentials', {
  id: text('id').primaryKey(),               // UUIDv7
  /** Soft owner reference (decision 10 + soft-reference rule — was users FK). */
  ownerId: text('owner_id').notNull(),
  provider: text('provider').notNull(),
  /** Display label */
  label: text('label').notNull(),
  /** Encrypted credential blob (API key, secret, passphrase) */
  encryptedData: text('encrypted_data').notNull(),
  /** Encryption metadata (algorithm, key version, etc.) */
  encryptionMeta: jsonb('encryption_meta').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
