// Agent-actor lifecycle operations (Wave E / E1-T T5) — the boundary-side glue
// shared by the consumer-only `start_agent_actor` / `stop_agent_actor` tools, the
// boot rehydrate, and the orphan sweep. Built ONCE in bin.ts over the runtime +
// the ensure + the agent-run repo + the bot repo, so each caller gets the same
// cascade/ensure semantics and the tools never touch the runtime or db directly.
//
// Keeping the stop + cascade + ensure here (not inline in bin.ts) makes them
// unit-testable with fakes and keeps bin.ts a thin composition root.

import type { AgentActorRunRepository } from '@traderton/db';
import type { TradingRuntime } from '@traderton/worker';
import type { AgentDirectActorEnsure, AgentDirectActorInjection } from './agent-direct-actor-ensure.js';

/** Minimal logger surface (matches `createLogger` output used in the boundary). */
interface OpsLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/** The bot-lifecycle surface the cascade needs — a subset of `BotRepository`. */
export interface CascadeBotRepo {
  getBotsByCreator(creatorType: string, creatorId: string): Promise<Array<{ id: string; status: string }>>;
  markBotStopped(botId: string): Promise<void>;
}

/** Stored run coordinates (text venueType) narrowed to the ensure's injection shape. */
export interface StoredRunCoords {
  ownerId: string;
  actorId: string;
  venueAccountId: string;
  venue: string;
  venueType: string;
}

export interface AgentActorLifecycleOpsDeps {
  runtime: TradingRuntime;
  ensure: AgentDirectActorEnsure;
  runRepo: AgentActorRunRepository;
  botRepo: CascadeBotRepo;
  /** Stop one in-process bot actor + release its lease (runtime.runtime.stopInstanceDirect). */
  stopInstanceDirect(botId: string): Promise<void>;
  logger: OpsLogger;
}

/**
 * Narrow a stored `venue_type` text value to the ensure's `'orderbook' | 'swap'`
 * union. Agent-run rows are only ever written by `upsertRunning` with the
 * resolver's already-narrowed value, so an unexpected value is a data defect;
 * default to 'orderbook' (the safe non-swap path) rather than throw, so a single
 * malformed row never crashes the whole rehydrate/sweep. An unexpected value is
 * logged for observability (it signals an out-of-band write or a schema drift).
 */
function narrowVenueType(venueType: string, logger: OpsLogger, context: { ownerId: string; actorId: string }): 'orderbook' | 'swap' {
  if (venueType === 'swap') return 'swap';
  if (venueType !== 'orderbook') {
    logger.warn({ venueType, ...context }, 'agent_actor_runs: unexpected venue_type — defaulting to orderbook');
  }
  return 'orderbook';
}

/** The reusable agent-actor lifecycle operations. */
export interface AgentActorLifecycleOps {
  /** Upsert `desired_state='running'` with the given resolved coordinates. */
  recordRunning(coords: StoredRunCoords): Promise<void>;
  /** Re-ensure an agent actor from stored coordinates (rehydrate + sweep). */
  ensureFromRun(coords: StoredRunCoords): Promise<void>;
  /** Is the agent's actor alive (registered + running) in this process? */
  isActorAlive(actorId: string): boolean;
  /** Stop + deregister the agent's actor (best-effort) and evict the ensure cache. */
  stopAndEvictActor(ownerId: string, actorId: string): Promise<void>;
  /**
   * Cascade-stop the agent's RUNNING bots: markBotStopped + stopInstanceDirect per
   * bot (best-effort, per-bot). Returns the ids of the bots that were stopped.
   */
  cascadeStopBots(agentId: string): Promise<string[]>;
  /**
   * The full `stop_agent_actor` effect: mark the run stopped, stop + deregister +
   * evict the actor, then cascade-stop the agent's running bots. Returns the
   * stopped bot ids. Idempotent (stop stays stopped; cascade is safe to repeat).
   */
  stopAgent(ownerId: string, actorId: string): Promise<{ stoppedBots: string[] }>;
}

export function buildAgentActorLifecycleOps(deps: AgentActorLifecycleOpsDeps): AgentActorLifecycleOps {
  const injectionFor = (coords: StoredRunCoords): AgentDirectActorInjection => ({
    ownerId: coords.ownerId,
    actorId: coords.actorId,
    // The ensure derives the real execution mode from the agent's profile; this
    // placeholder is never used to build the spec (it only satisfies the
    // injection shape). See buildAgentDirectActorEnsure.
    ownerMode: 'paper',
    venue: coords.venue,
    venueType: narrowVenueType(coords.venueType, deps.logger, { ownerId: coords.ownerId, actorId: coords.actorId }),
    venueAccountId: coords.venueAccountId,
  });

  const recordRunning: AgentActorLifecycleOps['recordRunning'] = async (coords) => {
    await deps.runRepo.upsertRunning({
      ownerId: coords.ownerId,
      actorId: coords.actorId,
      venueAccountId: coords.venueAccountId,
      venue: coords.venue,
      venueType: coords.venueType,
    });
  };

  const ensureFromRun: AgentActorLifecycleOps['ensureFromRun'] = async (coords) => {
    await deps.ensure(injectionFor(coords));
  };

  const isActorAlive: AgentActorLifecycleOps['isActorAlive'] = (actorId) =>
    deps.runtime.actorRegistry.get(actorId)?.isRunning === true;

  const stopAndEvictActor: AgentActorLifecycleOps['stopAndEvictActor'] = async (ownerId, actorId) => {
    const actor = deps.runtime.actorRegistry.get(actorId);
    if (actor) {
      // The registry stores ExecutionActor; narrow to the AgentTradingActor the
      // runtime's stop API expects. Only agent actors are keyed by an agent id,
      // so the cast is sound (same idiom as agent-direct-actor-ensure.ts).
      const agentActor = actor as unknown as Parameters<typeof deps.runtime.stopAndDeregisterAgentActor>[0];
      try {
        await deps.runtime.stopAndDeregisterAgentActor(agentActor);
      } catch (err) {
        // Best-effort: log + continue so a stop that half-fails still evicts the
        // cache + cascades (stop is idempotent).
        deps.logger.warn({ err, ownerId, actorId }, 'stop_agent_actor: failed to stop/deregister actor; continuing');
      }
    }
    // Evict regardless: a later start must reconstruct fresh, not reuse a
    // torn-down (or already-absent) cache entry.
    deps.ensure.evict(ownerId, actorId);
  };

  const cascadeStopBots: AgentActorLifecycleOps['cascadeStopBots'] = async (agentId) => {
    const stopped: string[] = [];
    const bots = await deps.botRepo.getBotsByCreator('agent', agentId);
    for (const bot of bots) {
      if (bot.status !== 'running') continue;
      try {
        await deps.botRepo.markBotStopped(bot.id);
        await deps.stopInstanceDirect(bot.id);
        stopped.push(bot.id);
      } catch (err) {
        // Best-effort per-bot: log + continue so one bad bot never blocks the rest.
        deps.logger.error({ err, botId: bot.id, agentId }, 'stop_agent_actor cascade: failed to stop bot; continuing');
      }
    }
    return stopped;
  };

  const stopAgent: AgentActorLifecycleOps['stopAgent'] = async (ownerId, actorId) => {
    // 1. Durable intent first so a crash mid-stop leaves the row stopped.
    await deps.runRepo.markStopped(ownerId, actorId);
    // 2. Stop + deregister the actor and evict the ensure cache.
    await stopAndEvictActor(ownerId, actorId);
    // 3. Cascade-stop the agent's running bots.
    const stoppedBots = await cascadeStopBots(actorId);
    return { stoppedBots };
  };

  return {
    recordRunning,
    ensureFromRun,
    isActorAlive,
    stopAndEvictActor,
    cascadeStopBots,
    stopAgent,
  };
}
