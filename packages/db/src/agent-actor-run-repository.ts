import crypto from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { Database } from './index.js';
import { agentActorRuns } from './schema/index.js';

/** The resolved venue coordinates an `upsertRunning` records (ports-carry-values). */
export interface UpsertRunningParams {
  ownerId: string;
  actorId: string;
  venueAccountId: string;
  venue: string;
  venueType: string;
}

export type AgentActorRunRow = typeof agentActorRuns.$inferSelect;

/**
 * Postgres-backed repository for `agent_actor_runs` (Wave E / E1-T T5) — the
 * durable agent-actor lifecycle intent.
 *
 * `start_agent_actor` upserts `running`; `stop_agent_actor` marks `stopped`. The
 * boundary reads `listRunning()` on boot (rehydrate) and in the orphan sweep
 * (re-ensure dead actors + stop bots of non-running agents); `getByOwnerActor`
 * backs liveness checks. The write effects are naturally idempotent (upsert the
 * same running row; stop stays stopped), so the tools satisfy 005 idempotency
 * without any per-tool dedup of their own.
 */
export class AgentActorRunRepository {
  constructor(private readonly db: Database) {}

  /**
   * Upsert `desired_state='running'` keyed on (ownerId, actorId), refreshing the
   * venue coordinates + `updatedAt`. Repeated calls converge on one running row
   * (idempotent). Generates the row id on first insert; the id is stable across
   * updates (the conflict target is the (owner, actor) unique index, not the id).
   */
  async upsertRunning(params: UpsertRunningParams): Promise<void> {
    await this.db
      .insert(agentActorRuns)
      .values({
        id: crypto.randomUUID(),
        ownerId: params.ownerId,
        actorId: params.actorId,
        venueAccountId: params.venueAccountId,
        venue: params.venue,
        venueType: params.venueType,
        desiredState: 'running',
      })
      .onConflictDoUpdate({
        target: [agentActorRuns.ownerId, agentActorRuns.actorId],
        set: {
          venueAccountId: params.venueAccountId,
          venue: params.venue,
          venueType: params.venueType,
          desiredState: 'running',
          updatedAt: new Date(),
        },
      });
  }

  /**
   * Set `desired_state='stopped'` + `updatedAt=now` for an existing (ownerId,
   * actorId) row. A no-op when the row is absent (nothing to stop) — stop is
   * idempotent, and a stopped row stays stopped on a repeat call.
   */
  async markStopped(ownerId: string, actorId: string): Promise<void> {
    await this.db
      .update(agentActorRuns)
      .set({ desiredState: 'stopped', updatedAt: new Date() })
      .where(and(eq(agentActorRuns.ownerId, ownerId), eq(agentActorRuns.actorId, actorId)));
  }

  /** All rows with `desired_state='running'` — for boot rehydrate + the orphan sweep. */
  async listRunning(): Promise<AgentActorRunRow[]> {
    return this.db
      .select()
      .from(agentActorRuns)
      .where(eq(agentActorRuns.desiredState, 'running'));
  }

  /**
   * Single run row for an actor id, or null. The (owner, actor) unique index
   * means an actor id resolves to at most one row, so this is the owner-resolving
   * lookup the agent-actor stop subscriber needs (001 S3): the broadcast
   * `agent-actor:stop:{agentId}` signal carries only the agent id, and the owner
   * must recover the `ownerId` to evict its ensure cache entry. Returns the most
   * recently updated row defensively (there should only ever be one).
   */
  async getByActorId(actorId: string): Promise<AgentActorRunRow | null> {
    const [row] = await this.db
      .select()
      .from(agentActorRuns)
      .where(eq(agentActorRuns.actorId, actorId))
      .orderBy(desc(agentActorRuns.updatedAt))
      .limit(1);
    return row ?? null;
  }

  /** Single run row for (ownerId, actorId), or null — for liveness checks. */
  async getByOwnerActor(ownerId: string, actorId: string): Promise<AgentActorRunRow | null> {
    const [row] = await this.db
      .select()
      .from(agentActorRuns)
      .where(and(eq(agentActorRuns.ownerId, ownerId), eq(agentActorRuns.actorId, actorId)))
      .limit(1);
    return row ?? null;
  }
}
