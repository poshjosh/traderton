// Extracted from bin.ts (A4) so the resolver-ports wiring — the D2 subject
// resolver's db VALUE lookups — is unit-testable without booting the boundary
// process (mirrors the A1 extraction of the agent-direct actor ensure).

import { and, asc, eq } from 'drizzle-orm';
import type { AppConfig } from '@traderton/domain';
import type { Database } from '@traderton/db';
import { venueAccounts } from '@traderton/db';
import type {
  SubjectResolverPorts,
  ResolverBotRecord,
  ResolverVenueAccountRecord,
} from './subject-resolver.js';

/** The db-repo surface the ports need (narrow — fakeable in tests). */
export interface ResolverPortsDeps {
  db: Database;
  appConfig: Pick<AppConfig, 'execution'>;
  // Structurally the BotRepository — narrowed to the one method the ports use.
  getBotById(botId: string): Promise<ResolverBotRecord | null>;
}

/**
 * Build the subject resolver's db ports (A4 wiring).
 *
 * - `getDefaultOwnerMode`: the static operator knob `execution.defaultOwnerMode`
 *   (AppConfig). Traderton has no agents table (locked — 017 §4), so this is a
 *   per-PROCESS default, not per-agent; B1's trading profile becomes the
 *   per-agent mode source later and this degrades to the fallback. Honest to
 *   the port's docstring: operator-configured default for the no-bot path.
 * - `getDefaultVenueAccountId`: the owner's OLDEST venue account by `created_at`
 *   (id as deterministic tiebreak). The verified `venue_accounts` schema has NO
 *   explicit default column, so oldest-account is the policy — deterministic
 *   and stable across calls without authoring operator state. A future
 *   `is_default` column would supersede this (follow-up, not added now).
 */
export function buildResolverPorts(deps: ResolverPortsDeps): SubjectResolverPorts {
  const { db, appConfig } = deps;
  return {
    getBotById: async (botId): Promise<ResolverBotRecord | null> => {
      const bot = await deps.getBotById(botId);
      if (!bot) return null;
      return { ownerId: bot.ownerId, venueAccountId: bot.venueAccountId, config: bot.config };
    },
    listVenueAccountsByOwner: async (ownerId): Promise<ResolverVenueAccountRecord[]> => {
      const rows = await db
        .select({ id: venueAccounts.id, venue: venueAccounts.venue })
        .from(venueAccounts)
        .where(and(eq(venueAccounts.ownerId, ownerId)));
      return rows.map((r) => ({ id: r.id, venue: r.venue }));
    },
    getDefaultOwnerMode: (): 'paper' | 'shadow' | 'live' => appConfig.execution.defaultOwnerMode,
    getDefaultVenueAccountId: async (ownerId): Promise<string | undefined> => {
      // Policy: the owner's oldest account (created_at ASC, id tiebreak). No
      // is_default column exists (verified schema) — do not guess beyond a
      // deterministic pick. Follow-up candidate: an explicit `is_default`
      // column would supersede this heuristic.
      const [oldest] = await db
        .select({ id: venueAccounts.id })
        .from(venueAccounts)
        .where(eq(venueAccounts.ownerId, ownerId))
        .orderBy(asc(venueAccounts.createdAt), asc(venueAccounts.id))
        .limit(1);
      return oldest?.id;
    },
  };
}
