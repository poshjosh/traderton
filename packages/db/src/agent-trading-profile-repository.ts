import crypto from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  resolveActiveStrategy,
  SWAP_VENUES,
  type ActiveStrategy,
  type AgentRiskOverrides,
  type CreatorStrategy,
  type ExecutionDefaults,
  type RiskPosture,
  type ScanMode,
} from '@traderton/domain';
import type { Database } from './index.js';
import {
  agentTradingProfileChanges,
  type AgentTradingProfileForwardAction,
  agentTradingProfiles,
  type AgentTradingProfilePreimage,
  venueAccounts,
} from './schema/index.js';

function venueTypeFor(venue: string): 'orderbook' | 'swap' {
  return (SWAP_VENUES as readonly string[]).includes(venue) ? 'swap' : 'orderbook';
}

export type AgentTradingProfile = typeof agentTradingProfiles.$inferSelect;

export interface TradingProfileConfiguration {
  ownerId: string;
  actorId: string;
  venueAccountId: string;
  capital: string | null;
  riskPosture: RiskPosture | null;
  executionDefaults: ExecutionDefaults | null;
  scanMode?: ScanMode | null;
  creatorStrategy?: CreatorStrategy | null;
}

export interface ApplyTradingProfileChange extends TradingProfileConfiguration {
  operationId: string;
  actionId: string;
  kind: 'set' | 'clear';
}

export interface ApplyTradingProfileOperation {
  ownerId: string;
  actorId: string;
  operationId: string;
  actions: AgentTradingProfileForwardAction[];
}

export class TradingProfileOperationConflictError extends Error {
  constructor() {
    super('The operation id is already bound to a different profile action manifest');
  }
}

export class AgentTradingProfileRepository {
  private static readonly PROFILE_LOCK_CLASS = 19;

  constructor(private readonly db: Database) {}

  async getByOwnerActorVenueAccount(
    ownerId: string,
    actorId: string,
    venueAccountId: string,
  ): Promise<AgentTradingProfile | null> {
    const [profile] = await this.db.select().from(agentTradingProfiles).where(and(
      eq(agentTradingProfiles.ownerId, ownerId),
      eq(agentTradingProfiles.actorId, actorId),
      eq(agentTradingProfiles.venueAccountId, venueAccountId),
    )).limit(1);
    return profile ?? null;
  }

  async applyChange(input: ApplyTradingProfileChange): Promise<{ operationId: string; actionId: string; revision: bigint | null }> {
    const results = await this.applyOperation({
      ownerId: input.ownerId,
      actorId: input.actorId,
      operationId: input.operationId,
      actions: [{
        actionId: input.actionId,
        kind: input.kind,
        venueAccountId: input.venueAccountId,
        capital: input.capital,
        riskPosture: input.riskPosture,
        executionDefaults: input.executionDefaults,
        // Absent (undefined) = unchanged; explicit null = clear. Preserve the
        // distinction rather than coercing undefined to null.
        ...(input.scanMode === undefined ? {} : { scanMode: input.scanMode }),
        ...(input.creatorStrategy === undefined ? {} : { creatorStrategy: input.creatorStrategy }),
      }],
    });
    return { operationId: input.operationId, actionId: input.actionId, revision: results.get(input.actionId) ?? null };
  }

  async applyOperation(input: ApplyTradingProfileOperation): Promise<Map<string, bigint | null>> {
    return this.db.transaction(async (tx) => {
      const actionIds = new Set<string>();
      const venueAccountIds = new Set<string>();
      for (const action of input.actions) {
        if (actionIds.has(action.actionId) || venueAccountIds.has(action.venueAccountId)) {
          throw new Error('Each profile operation action and venue account must be unique');
        }
        actionIds.add(action.actionId);
        venueAccountIds.add(action.venueAccountId);
      }
      for (const venueAccountId of [...venueAccountIds].sort()) {
        const lockKey = `${input.ownerId}:${input.actorId}:${venueAccountId}`;
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${AgentTradingProfileRepository.PROFILE_LOCK_CLASS}, hashtext(${lockKey}))`);
      }

      const existingChanges = await tx.select().from(agentTradingProfileChanges).where(and(
        eq(agentTradingProfileChanges.operationId, input.operationId),
        eq(agentTradingProfileChanges.ownerId, input.ownerId),
        eq(agentTradingProfileChanges.actorId, input.actorId),
      ));
      if (existingChanges.length > 0) {
        if (!sameManifest(existingChanges.map((change) => change.forwardAction), input.actions)) {
          throw new TradingProfileOperationConflictError();
        }
        return this.currentRevisions(tx, input.ownerId, input.actorId, input.actions);
      }

      const revisions = new Map<string, bigint | null>();
      for (const action of input.actions) {
        const profile = await this.findIn(tx, input.ownerId, input.actorId, action.venueAccountId);
        const revision = await this.applyAction(tx, input.ownerId, input.actorId, action, profile);
        await tx.insert(agentTradingProfileChanges).values({
          operationId: input.operationId,
          actionId: action.actionId,
          ownerId: input.ownerId,
          actorId: input.actorId,
          venueAccountId: action.venueAccountId,
          preimage: profile ? serializePreimage(profile) : null,
          // Drop keys whose value is `undefined` ("unchanged") before persisting:
          // jsonb would drop them on write anyway, and keeping them in memory
          // would make a replayed manifest (read back from jsonb without the key)
          // compare unequal and raise a spurious operation conflict.
          forwardAction: stripUndefined(action),
          appliedRevision: revision,
        });
        revisions.set(action.actionId, revision);
      }
      return revisions;
    });
  }

  async resumeOperation(ownerId: string, actorId: string, operationId: string): Promise<Map<string, bigint | null>> {
    const changes = await this.db.select().from(agentTradingProfileChanges).where(and(
      eq(agentTradingProfileChanges.operationId, operationId),
      eq(agentTradingProfileChanges.ownerId, ownerId),
      eq(agentTradingProfileChanges.actorId, actorId),
    ));
    if (changes.length === 0) return new Map();
    return this.applyOperation({ ownerId, actorId, operationId, actions: changes.map((change) => change.forwardAction) });
  }

  private async applyAction(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    ownerId: string,
    actorId: string,
    action: AgentTradingProfileForwardAction,
    profile: AgentTradingProfile | null,
  ): Promise<bigint | null> {
    if (action.kind === 'clear') {
        await tx.delete(agentTradingProfiles).where(and(
          eq(agentTradingProfiles.ownerId, ownerId),
          eq(agentTradingProfiles.actorId, actorId),
          eq(agentTradingProfiles.venueAccountId, action.venueAccountId),
        ));
      return null;
    }

    const revision = (profile?.revision ?? 0n) + 1n;
    const now = new Date();
    // Absent (undefined) scan fields on a set action mean "unchanged": preserve
    // the stored creator inputs. An explicit null means "clear". Only a `clear`
    // action removes the profile row entirely.
    const scanMode = action.scanMode === undefined ? (profile?.scanMode ?? null) : action.scanMode;
    const creatorStrategy = action.creatorStrategy === undefined
      ? (profile?.creatorStrategy ?? null)
      : action.creatorStrategy;
    const activeStrategy = await this.deriveActiveStrategy(tx, ownerId, action, profile, now);
    if (profile) {
      await tx.update(agentTradingProfiles).set({
        capital: action.capital,
        riskPosture: action.riskPosture,
        executionDefaults: action.executionDefaults,
        scanMode,
        creatorStrategy,
        activeStrategy,
        revision,
        updatedAt: now,
      }).where(eq(agentTradingProfiles.id, profile.id));
    } else {
      await tx.insert(agentTradingProfiles).values({
        id: crypto.randomUUID(),
        ownerId,
        actorId,
        venueAccountId: action.venueAccountId,
        capital: action.capital,
        riskPosture: action.riskPosture,
        riskOverrides: {},
        executionDefaults: action.executionDefaults,
        scanMode,
        creatorStrategy,
        activeStrategy,
        revision,
        createdAt: now,
        updatedAt: now,
      });
    }
    return revision;
  }

  /**
   * Derive `activeStrategy` per the 004 ownership rule. First set, or a changed
   * `creatorStrategy` (compared by canonical JSON to the stored value), resolves
   * a fresh active strategy with `source:'creator'`. An absent `creatorStrategy`
   * (key omitted — a resend while saving capital, or an old caller) leaves the
   * stored active strategy untouched. An explicit null clears it. A `clear`
   * action removes the whole profile row (handled before this is reached).
   */
  private async deriveActiveStrategy(
    tx: Pick<Database, 'select'>,
    ownerId: string,
    action: AgentTradingProfileForwardAction,
    profile: AgentTradingProfile | null,
    now: Date,
  ): Promise<ActiveStrategy | null> {
    // Absent creator input (key omitted) → unchanged: keep whatever the actor
    // already runs.
    if (action.creatorStrategy === undefined) return profile?.activeStrategy ?? null;
    // Explicit null → clear the resolved active strategy.
    if (action.creatorStrategy === null) return null;

    const unchanged = profile != null
      && canonicalJson(profile.creatorStrategy ?? null) === canonicalJson(action.creatorStrategy);
    if (unchanged) return profile.activeStrategy ?? null;

    const [venueAccount] = await tx.select({ venue: venueAccounts.venue }).from(venueAccounts).where(and(
      eq(venueAccounts.id, action.venueAccountId),
      eq(venueAccounts.ownerId, ownerId),
    )).limit(1);
    if (!venueAccount) {
      throw new Error(`Venue account ${action.venueAccountId} not found for owner ${ownerId} while resolving active strategy`);
    }
    return resolveActiveStrategy(
      action.creatorStrategy,
      { venue: venueAccount.venue, venueType: venueTypeFor(venueAccount.venue) },
      now.toISOString(),
    );
  }

  async replaceRiskOverrides(params: {
    ownerId: string;
    actorId: string;
    venueAccountId: string;
    riskOverrides: AgentRiskOverrides;
  }): Promise<AgentTradingProfile | null> {
    return this.db.transaction(async (tx) => {
      const lockKey = `${params.ownerId}:${params.actorId}:${params.venueAccountId}`;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${AgentTradingProfileRepository.PROFILE_LOCK_CLASS}, hashtext(${lockKey}))`);
      const profile = await this.findIn(tx, params.ownerId, params.actorId, params.venueAccountId);
      if (!profile) return null;
      const revision = profile.revision + 1n;
      const [updated] = await tx.update(agentTradingProfiles).set({
        riskOverrides: params.riskOverrides,
        revision,
        updatedAt: new Date(),
      }).where(eq(agentTradingProfiles.id, profile.id)).returning();
      return updated ?? null;
    });
  }

  async finalizeChange(ownerId: string, actorId: string, operationId: string): Promise<void> {
    await this.db.delete(agentTradingProfileChanges).where(and(
      eq(agentTradingProfileChanges.operationId, operationId),
      eq(agentTradingProfileChanges.ownerId, ownerId),
      eq(agentTradingProfileChanges.actorId, actorId),
    ));
  }

  async rollbackChange(ownerId: string, actorId: string, operationId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const changes = await tx.select().from(agentTradingProfileChanges)
        .where(and(
          eq(agentTradingProfileChanges.operationId, operationId),
          eq(agentTradingProfileChanges.ownerId, ownerId),
          eq(agentTradingProfileChanges.actorId, actorId),
        ));
      for (const change of changes.sort((left, right) => left.venueAccountId.localeCompare(right.venueAccountId))) {
        const lockKey = `${change.ownerId}:${change.actorId}:${change.venueAccountId}`;
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${AgentTradingProfileRepository.PROFILE_LOCK_CLASS}, hashtext(${lockKey}))`);
        const current = await this.findIn(tx, change.ownerId, change.actorId, change.venueAccountId);
        const canRestore = change.appliedRevision === null
          ? current === null
          : current?.revision === change.appliedRevision;
        if (!canRestore) continue;
        if (change.preimage) {
          const preimage = deserializePreimage(change.preimage);
          await tx.insert(agentTradingProfiles).values(preimage).onConflictDoUpdate({
            target: [agentTradingProfiles.ownerId, agentTradingProfiles.actorId, agentTradingProfiles.venueAccountId],
            set: preimage,
          });
        } else {
          await tx.delete(agentTradingProfiles).where(and(
            eq(agentTradingProfiles.ownerId, change.ownerId),
            eq(agentTradingProfiles.actorId, change.actorId),
            eq(agentTradingProfiles.venueAccountId, change.venueAccountId),
          ));
        }
      }
      await tx.delete(agentTradingProfileChanges).where(and(
        eq(agentTradingProfileChanges.operationId, operationId),
        eq(agentTradingProfileChanges.ownerId, ownerId),
        eq(agentTradingProfileChanges.actorId, actorId),
      ));
    });
  }

  private async findIn(db: Pick<Database, 'select'>, ownerId: string, actorId: string, venueAccountId: string): Promise<AgentTradingProfile | null> {
    const [profile] = await db.select().from(agentTradingProfiles).where(and(
      eq(agentTradingProfiles.ownerId, ownerId),
      eq(agentTradingProfiles.actorId, actorId),
      eq(agentTradingProfiles.venueAccountId, venueAccountId),
    )).limit(1);
    return profile ?? null;
  }

  private async currentRevisions(
    tx: Pick<Database, 'select'>,
    ownerId: string,
    actorId: string,
    actions: AgentTradingProfileForwardAction[],
  ): Promise<Map<string, bigint | null>> {
    const revisions = new Map<string, bigint | null>();
    for (const action of actions) {
      const profile = await this.findIn(tx, ownerId, actorId, action.venueAccountId);
      revisions.set(action.actionId, profile?.revision ?? null);
    }
    return revisions;
  }
}

function sameManifest(
  existing: AgentTradingProfileForwardAction[],
  requested: AgentTradingProfileForwardAction[],
): boolean {
  if (existing.length !== requested.length) return false;
  const byActionId = new Map(existing.map((action) => [action.actionId, action]));
  // Strip `undefined` ("unchanged") keys on both sides: a persisted manifest is
  // read back from jsonb without them, so an in-memory requested action that
  // still carries `undefined` must be normalised to compare equal on replay.
  return requested.every((action) =>
    canonicalJson(stripUndefined(byActionId.get(action.actionId))) === canonicalJson(stripUndefined(action)));
}

/**
 * Return a shallow copy of a forward action with any `undefined`-valued keys
 * removed. jsonb drops them on write; stripping them in memory keeps replay
 * comparisons and persisted rows consistent.
 */
function stripUndefined(action: AgentTradingProfileForwardAction): AgentTradingProfileForwardAction;
function stripUndefined(action: AgentTradingProfileForwardAction | undefined): AgentTradingProfileForwardAction | undefined;
function stripUndefined(action: AgentTradingProfileForwardAction | undefined): AgentTradingProfileForwardAction | undefined {
  if (!action) return action;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(action)) {
    if (value !== undefined) result[key] = value;
  }
  return result as unknown as AgentTradingProfileForwardAction;
}

/**
 * Order-insensitive JSON serialization for manifest comparison. Postgres jsonb
 * canonicalizes object key order on write, so a raw JSON.stringify round-trip
 * would never match the requested action. Sort keys recursively so replayed
 * manifests compare equal regardless of storage key order.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${canonicalJson(val)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function serializePreimage(profile: AgentTradingProfile): AgentTradingProfilePreimage {
  return {
    ...profile,
    revision: profile.revision.toString(),
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  };
}

function deserializePreimage(preimage: AgentTradingProfilePreimage): AgentTradingProfile {
  return {
    ...preimage,
    revision: BigInt(preimage.revision),
    createdAt: new Date(preimage.createdAt),
    updatedAt: new Date(preimage.updatedAt),
  };
}