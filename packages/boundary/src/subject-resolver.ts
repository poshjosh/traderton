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
   *
   * A4: async — the boundary composition root implements the policy as a db
   * read (the owner's oldest account), so the port must await.
   */
  getDefaultVenueAccountId?(ownerId: string): Promise<string | undefined>;
  /**
   * Optional operator-configured default owner execution mode for the no-bot
   * path. Defaults to the safe `paper` when absent (005 conservative default).
   *
   * A4: wired by the boundary composition root from the operator knob
   * `execution.defaultOwnerMode` (static — no per-agent source exists; B1's
   * trading profile becomes the per-agent mode later, with this as fallback).
   */
  getDefaultOwnerMode?(ownerId: string): 'paper' | 'shadow' | 'live' | undefined;
}

/** The subject the resolver maps (the signed values + the actor id used as `actorId`). */
export interface ResolverSubject {
  ownerId: string;
  actor: { type: 'agent' | 'bot' | 'user' | 'system'; id: string };
}

/** Extract a `botId` string from a validated tool payload, if the tool names one. */
function botIdOf(payload: unknown): string | undefined {
  if (payload && typeof payload === 'object') {
    const value = (payload as Record<string, unknown>)['botId'];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

/** Extract a `venueAccountId` string from a validated tool payload, if the tool names one. */
function venueAccountIdOf(payload: unknown): string | undefined {
  if (payload && typeof payload === 'object') {
    const value = (payload as Record<string, unknown>)['venueAccountId'];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

/** Read the requested execution mode from a create-bot payload (`config.execution.mode`), if valid. */
function requestedModeOf(payload: unknown): 'paper' | 'shadow' | 'live' | undefined {
  if (payload && typeof payload === 'object') {
    const config = (payload as Record<string, unknown>)['config'];
    if (config && typeof config === 'object') {
      const execution = (config as Record<string, unknown>)['execution'];
      if (execution && typeof execution === 'object') {
        const mode = (execution as Record<string, unknown>)['mode'];
        if (mode === 'paper' || mode === 'shadow' || mode === 'live') return mode;
      }
    }
  }
  return undefined;
}

/**
 * Resolve `ownerMode` for the no-bot-named path (create_bot / submit_decision).
 *
 * `ownerMode` is consumed ONLY as the ceiling for the mode-escalation guard
 * (`checkModeEscalation` in drive-target). It does NOT drive real execution or
 * live-readiness — those key off the persisted `config.execution.mode`. So this
 * only decides "what mode is this actor allowed to CEILING at", nothing more.
 *
 * WHY actor-type matters (copy-faithful to herobids):
 *   - In the source system, the mode-escalation ceiling was AGENT-ONLY — it
 *     exists so an agent cannot create/adjust a bot beyond the agent's OWN
 *     configured mode (see mode-rank.ts docstring; herobids applied it solely in
 *     the agent-message-broker path). The USER bot-create route (pre-boundary
 *     apps/api/src/routes/bots.ts) applied NO mode-rank at all — the user's
 *     chosen paper/shadow/live was authoritative, with `live` separately gated
 *     by the plan-entitlement check (`checkLiveEnabled`), which herobids STILL
 *     performs on its side before ever calling the boundary.
 *   - The migration routed user-direct creates through this resolver, which
 *     defaulted ownerMode to 'paper' (getDefaultOwnerMode is unset for this
 *     consumer) — spuriously imposing an agent-only ceiling on users and
 *     rejecting a valid user `shadow` bot. This restores the original semantics.
 *
 * Therefore:
 *   - `agent` → ceiling = the agent's own mode (via getDefaultOwnerMode; unset
 *     today → falls back to the safe 'paper' until the separate agent-mode
 *     wiring lands). The agent guard is preserved exactly.
 *   - `user`/`system`/`bot` → the actor is authoritative; the ceiling is the
 *     requested mode itself, so checkModeEscalation passes trivially (read
 *     defensively — missing/invalid falls back to the safe 'paper'). This does
 *     NOT let a user self-authorize `live`: `live` remains gated upstream by
 *     herobids' `checkLiveEnabled` before the boundary is called.
 */
function resolveNoBotOwnerMode(
  subject: ResolverSubject,
  payload: unknown,
  ports: SubjectResolverPorts,
): 'paper' | 'shadow' | 'live' {
  if (subject.actor.type === 'agent') {
    return ports.getDefaultOwnerMode?.(subject.ownerId) ?? 'paper';
  }
  return requestedModeOf(payload) ?? 'paper';
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
 * Resolve a signed subject + the tool's payload into the injection VALUES the
 * drive target needs (D2). Three paths:
 *
 *  - **Skip venue resolution** (`skipVenueResolution === true`): the caller has
 *    determined this tool drives no executor and needs no venue coordinates —
 *    read-only tools AND owner-scoped writes that touch tables/agent-state
 *    directly (e.g. `provision_venue_account`, `deprovision_venue_account`,
 *    `adjust_risk_limits`, the watch tools). Short-circuit to a minimal injection
 *    (ownerId + actorId; empty venue coords, never consumed). Critically this is
 *    what lets `provision_venue_account` run at all — it CREATES the owner's
 *    first venue account, so requiring an existing one would deadlock. The caller
 *    (see `bin.ts`) computes the flag from `isReadOnlyCategory(category) ||
 *    tool.ownerScopedNoVenue`, keeping this function port-only + registry-free.
 *  - **Bot-scoped tool** (payload names a `botId` — e.g. `stop_bot`, `start_bot`,
 *    `adjust_bot_config`): read the bot row, validate `bot.ownerId ===
 *    subject.ownerId` (ownership; mismatch → `authorization.denied`), and derive
 *    `venueAccountId` (the bot column) + `venue`/`venueType`/`ownerMode` (bot
 *    config). Missing bot → `precondition.not_ready`.
 *  - **No bot named** (e.g. `create_bot`, `submit_decision`): if the payload
 *    carries an explicit `venueAccountId` (the consumer resolved connection→
 *    account on its side), honour it deterministically — validate it belongs to
 *    the owner (mismatch/absent from the owner's accounts → `authorization.denied`),
 *    then derive `venue`/`venueType`/`ownerMode` from it. Otherwise fall back to
 *    the per-owner default (exactly one account, or an operator-configured
 *    default); derive `venue`/`venueAccountId` from it, `venueType` from the
 *    venue, `ownerMode` from operator config or the safe `paper` default. No
 *    account → `precondition.not_ready`.
 */
export async function resolveSubjectInjection(
  subject: ResolverSubject,
  skipVenueResolution: boolean,
  payload: unknown,
  ports: SubjectResolverPorts,
): Promise<SubjectResolution> {
  // Tools that drive no executor need no venue coordinates. The caller computes
  // this flag (read-only category OR the tool's `ownerScopedNoVenue`); here we
  // simply honour it. Requiring a venue account for such a tool would wrongly
  // fail `precondition.not_ready` (and would deadlock `provision_venue_account`,
  // which creates the owner's FIRST account). Short-circuit to a minimal
  // injection — venue fields empty, never consumed. Authors no trading behaviour.
  if (skipVenueResolution) {
    const requestedVenueAccountId = venueAccountIdOf(payload);
    const account = requestedVenueAccountId
      ? (await ports.listVenueAccountsByOwner(subject.ownerId)).find((candidate) => candidate.id === requestedVenueAccountId)
      : undefined;
    if (requestedVenueAccountId && !account) {
      return { ok: false, code: 'authorization.denied', message: 'venue account not owned by subject' };
    }
    return {
      ok: true,
      injection: {
        ownerId: subject.ownerId,
        actorId: subject.actor.id,
        ownerMode: 'paper',
        venue: account?.venue ?? '',
        venueType: 'orderbook',
        venueAccountId: account?.id ?? '',
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

  // No bot named (e.g. create_bot, submit_decision). The consumer owns the
  // concrete connection→account mapping and passes the chosen account id as a
  // per-operation payload arg (`venueAccountId`); the whole subject+payload is
  // HMAC-signed, so payload placement is integrity-safe. When present we honour
  // it deterministically (validating ownership against the owner's accounts —
  // defence in depth). When absent we keep the historical per-owner default
  // resolution (single account, else operator default, else ambiguous).
  // The consumer-injected agent risk context (capital/riskPosture/riskOverrides)
  // rides the same validated payload — attached to whichever injection this
  // path returns so the agent-direct actor ensure can consume it.
  const accounts = await ports.listVenueAccountsByOwner(subject.ownerId);
  const requestedVenueAccountId = venueAccountIdOf(payload);

  if (requestedVenueAccountId) {
    const requested = accounts.find((a) => a.id === requestedVenueAccountId);
    if (!requested) {
      return {
        ok: false,
        code: 'authorization.denied',
        message: 'venue account not owned by subject',
      };
    }
    const ownerMode = resolveNoBotOwnerMode(subject, payload, ports);
    return {
      ok: true,
      injection: {
        ownerId: subject.ownerId,
        actorId: subject.actor.id,
        ownerMode,
        venue: requested.venue,
        venueType: venueTypeFor(requested.venue),
        venueAccountId: requested.id,
      },
    };
  }

  if (accounts.length === 0) {
    return { ok: false, code: 'precondition.not_ready', message: 'no venue account for owner' };
  }

  let account: ResolverVenueAccountRecord | undefined;
  if (accounts.length === 1) {
    account = accounts[0];
  } else {
    const defaultId = await ports.getDefaultVenueAccountId?.(subject.ownerId);
    account = defaultId ? accounts.find((a) => a.id === defaultId) : undefined;
  }
  if (!account) {
    return {
      ok: false,
      code: 'precondition.not_ready',
      message: 'no default venue account for owner (ambiguous)',
    };
  }

  const ownerMode = resolveNoBotOwnerMode(subject, payload, ports);
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
