// AUTHORED (Phase 9b item F2b) — the D2 subject→injection resolver.
//
// 005 carries only `ownerId` + `actor` over the boundary; the copied drive
// target (`createDriveTarget(injection)`) needs
// `venue`/`venueType`/`venueAccountId`/`ownerMode` per owned actor. This module
// maps a signed subject + the tool's payload → those injection VALUES.
//
// It is the D2 AUTHORED seam — there is NO herobids oracle: herobids resolved
// this via the deleted connection-grant / `agents` layer (decisions 11–13). It
// injects VALUES ONLY (reads db rows and derives coordinates); it authors NO
// trading behaviour. The copied drive target ALSO re-checks bot ownership — the
// ownership check here is defence in depth, not a replacement.

import type { ToolCategory } from '@traderton/domain';
import { isReadOnlyCategory } from '@traderton/domain';

/** A resolution outcome — either the injection VALUES or a typed boundary failure. */
export type SubjectResolution =
  | { ok: true; injection: ResolvedInjection }
  | { ok: false; code: 'authorization.denied' | 'precondition.not_ready'; message: string };

/** The injection VALUES the drive target needs (a subset of `DriveTargetInjection`). */
export interface ResolvedInjection {
  ownerId: string;
  actorId: string;
  ownerMode: 'paper' | 'shadow' | 'live';
  venue: string;
  venueType: 'orderbook' | 'swap';
  venueAccountId: string;
}

/** The bot row the resolver reads (the subset it needs for coordinates + ownership). */
export interface ResolverBotRecord {
  ownerId: string;
  venueAccountId: string;
  config: Record<string, unknown>;
}

/** The venue-account row the resolver reads for a per-owner default. */
export interface ResolverVenueAccountRecord {
  id: string;
  venue: string;
}

/** The db lookups the resolver depends on (injected — fakeable in unit tests). */
export interface SubjectResolverPorts {
  /** Read a bot row by id (null when absent). */
  getBotById(botId: string): Promise<ResolverBotRecord | null>;
  /** List the owner's venue accounts (for the no-bot-named default path). */
  listVenueAccountsByOwner(ownerId: string): Promise<ResolverVenueAccountRecord[]>;
  /**
   * Optional operator-configured default venue-account id for an owner. When more
   * than one account exists and no operator default is set, resolution fails
   * `precondition.not_ready` (ambiguous — refuse rather than guess).
   */
  getDefaultVenueAccountId?(ownerId: string): string | undefined;
  /**
   * Optional operator-configured default owner execution mode for the no-bot
   * path. Defaults to the safe `paper` when absent (005 conservative default).
   */
  getDefaultOwnerMode?(ownerId: string): 'paper' | 'shadow' | 'live' | undefined;
}

/** The subject the resolver maps (the signed values + the actor id used as `actorId`). */
export interface ResolverSubject {
  ownerId: string;
  actor: { type: 'agent' | 'bot' | 'user' | 'system'; id: string };
}

/**
 * Owner-scoped provisioning tools: `write-database` tools that write tables
 * directly (via `ctx.db`) and drive NO executor, so they need no injected venue
 * coordinates and — unlike bot/decision writes — must NOT require a pre-existing
 * venue account (`provision_venue_account` creates the owner's first one). Kept
 * as an explicit set (not a category) because they share the `write-database`
 * category with bot/drive tools that DO need resolution. A future tool-contract
 * flag (e.g. `drivesExecutor: false`) could replace this set.
 */
const OWNER_SCOPED_PROVISIONING_TOOLS = new Set<string>([
  'provision_venue_account',
  'deprovision_venue_account',
]);

function isOwnerScopedProvisioningTool(toolName: string): boolean {
  return OWNER_SCOPED_PROVISIONING_TOOLS.has(toolName);
}

/** Extract a `botId` string from a validated tool payload, if the tool names one. */
function botIdOf(payload: unknown): string | undefined {
  if (payload && typeof payload === 'object') {
    const value = (payload as Record<string, unknown>)['botId'];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

/** Derive `venueType` from a venue name (orderbook by default; swap venues are jupiter/1inch). */
function venueTypeFor(venue: string, configVenueType?: unknown): 'orderbook' | 'swap' {
  if (configVenueType === 'swap' || configVenueType === 'orderbook') {
    return configVenueType;
  }
  return venue === 'jupiter' || venue === '1inch' ? 'swap' : 'orderbook';
}

/** Read the bot's `venue` / `venueType` / execution `mode` from its persisted config. */
function coordsFromBotConfig(config: Record<string, unknown>): {
  venue?: string;
  venueType?: unknown;
  ownerMode?: 'paper' | 'shadow' | 'live';
} {
  const venue = typeof config['venue'] === 'string' ? (config['venue'] as string) : undefined;
  const venueType = config['venueType'];
  const execution = config['execution'];
  let ownerMode: 'paper' | 'shadow' | 'live' | undefined;
  if (execution && typeof execution === 'object') {
    const mode = (execution as Record<string, unknown>)['mode'];
    if (mode === 'paper' || mode === 'shadow' || mode === 'live') ownerMode = mode;
  }
  return { venue, venueType, ownerMode };
}

/**
 * Resolve a signed subject + the tool's category/payload into the injection
 * VALUES the drive target needs (D2). Two paths:
 *
 *  - **Bot-scoped tool** (payload names a `botId` — e.g. `stop_bot`, `start_bot`,
 *    `adjust_bot_config`): read the bot row, validate `bot.ownerId ===
 *    subject.ownerId` (ownership; mismatch → `authorization.denied`), and derive
 *    `venueAccountId` (the bot column) + `venue`/`venueType`/`ownerMode` (bot
 *    config). Missing bot → `precondition.not_ready`.
 *  - **No bot named** (e.g. `create_bot`, `submit_decision`): resolve a per-owner
 *    default venue account (exactly one, or an operator-configured default);
 *    derive `venue`/`venueAccountId` from it, `venueType` from the venue,
 *    `ownerMode` from operator config or the safe `paper` default. No account →
 *    `precondition.not_ready`.
 *
 * `category` is only used to keep the bot-vs-no-bot decision aligned with the
 * payload shape; the payload's `botId` is the actual discriminator.
 */
export async function resolveSubjectInjection(
  subject: ResolverSubject,
  toolCategory: ToolCategory,
  toolName: string,
  payload: unknown,
  ports: SubjectResolverPorts,
): Promise<SubjectResolution> {
  // Read-only tools drive nothing: the copied drive target is never invoked for
  // a read, so the venue coordinates in ResolvedInjection are unused. A pure
  // market read (e.g. check_regime, score_candidate) names no bot and needs no
  // venue account — requiring one here would wrongly fail `precondition.not_ready`
  // for owners without an account. So read-only categories short-circuit to a
  // minimal injection (ownerId + actorId only). This is the read-tool seam; it
  // authors no trading behaviour (venue fields left empty, never consumed).
  if (isReadOnlyCategory(toolCategory)) {
    return {
      ok: true,
      injection: {
        ownerId: subject.ownerId,
        actorId: subject.actor.id,
        ownerMode: 'paper',
        venue: '',
        venueType: 'orderbook',
        venueAccountId: '',
      },
    };
  }

  // Owner-scoped provisioning tools (provision_venue_account /
  // deprovision_venue_account) are the same shape as read-only tools for
  // resolution purposes: they write tables directly via `ctx.db` and NEVER drive
  // the executor (`createDriveTarget` is not invoked), so they need no venue
  // coordinates. Critically, `provision_venue_account` CREATES an owner's first
  // venue account — requiring an existing one here would be a chicken-and-egg
  // deadlock (no account → can't resolve → can't create the account). So these
  // short-circuit to the minimal injection (ownerId + actorId), exactly like the
  // read-tool seam. This authors no trading behaviour (venue fields empty, never
  // consumed). See CANONICAL-STATE L3-P1/L3-P1b.
  if (isOwnerScopedProvisioningTool(toolName)) {
    return {
      ok: true,
      injection: {
        ownerId: subject.ownerId,
        actorId: subject.actor.id,
        ownerMode: 'paper',
        venue: '',
        venueType: 'orderbook',
        venueAccountId: '',
      },
    };
  }

  // Side-effecting tools: the payload's `botId` is the actual discriminator.
  const botId = botIdOf(payload);

  if (botId) {
    const bot = await ports.getBotById(botId);
    if (!bot) {
      return { ok: false, code: 'precondition.not_ready', message: `bot not found: ${botId}` };
    }
    if (bot.ownerId !== subject.ownerId) {
      return { ok: false, code: 'authorization.denied', message: 'bot not owned by subject' };
    }
    const coords = coordsFromBotConfig(bot.config);
    if (!coords.venue) {
      return {
        ok: false,
        code: 'precondition.not_ready',
        message: `bot ${botId} has no venue in config`,
      };
    }
    return {
      ok: true,
      injection: {
        ownerId: subject.ownerId,
        actorId: subject.actor.id,
        ownerMode: coords.ownerMode ?? 'paper',
        venue: coords.venue,
        venueType: venueTypeFor(coords.venue, coords.venueType),
        venueAccountId: bot.venueAccountId,
      },
    };
  }

  // No bot named → resolve a per-owner default venue account.
  const accounts = await ports.listVenueAccountsByOwner(subject.ownerId);
  if (accounts.length === 0) {
    return { ok: false, code: 'precondition.not_ready', message: 'no venue account for owner' };
  }

  let account: ResolverVenueAccountRecord | undefined;
  if (accounts.length === 1) {
    account = accounts[0];
  } else {
    const defaultId = ports.getDefaultVenueAccountId?.(subject.ownerId);
    account = defaultId ? accounts.find((a) => a.id === defaultId) : undefined;
  }
  if (!account) {
    return {
      ok: false,
      code: 'precondition.not_ready',
      message: 'no default venue account for owner (ambiguous)',
    };
  }

  const ownerMode = ports.getDefaultOwnerMode?.(subject.ownerId) ?? 'paper';
  return {
    ok: true,
    injection: {
      ownerId: subject.ownerId,
      actorId: subject.actor.id,
      ownerMode,
      venue: account.venue,
      venueType: venueTypeFor(account.venue),
      venueAccountId: account.id,
    },
  };
}
