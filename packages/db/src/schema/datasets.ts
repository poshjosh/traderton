import { pgTable, text, timestamp, integer, index, jsonb } from 'drizzle-orm/pg-core';

/**
 * Datasets — OHLCV or custom market data uploaded or fetched by an owner.
 * Metadata stored in Postgres; raw data stored on local filesystem (v1).
 */
export const datasets = pgTable('datasets', {
  id: text('id').primaryKey(),
  /** Soft owner reference (decision 10 + soft-reference rule — was users FK, onDelete cascade). */
  ownerId: text('owner_id').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  venue: text('venue'),
  symbol: text('symbol'),
  /** OHLCV interval: 1m, 5m, 15m, 1h, 4h, 1d, etc. */
  interval: text('interval'),
  from: timestamp('from', { withTimezone: true }),
  to: timestamp('to', { withTimezone: true }),
  /** Local filesystem path to the raw data file (v1). Null until data is written. */
  filePath: text('file_path'),
  rowCount: integer('row_count'),
  /** ready | pending | failed */
  status: text('status').notNull().default('pending'),
  /** Optional metadata (format, source URL, etc.) */
  meta: jsonb('meta').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_datasets_owner_id').on(t.ownerId),
  index('idx_datasets_status').on(t.status),
]);
