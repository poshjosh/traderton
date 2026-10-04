// The boundary's agent-actor orphan sweep (Wave E / E1-T T5). A self-rescheduling
// setTimeout loop (same shape as consumer-notification-prune.ts / agent-scan-prune.ts)
// that reconciles the in-process actor registry + the running bots against the
// durable `agent_actor_runs` liveness table. Extracted from bin.ts so it is
// unit-testable without booting the process.
//
// Each tick does two best-effort passes (liveness = `agent_actor_runs`):
//
// 001 S4: the pass-2 re-ensure is lease-aware. `reEnsureAgent` returns the
// ensure's ownership outcome so the sweep can log local-vs-remote honestly — a
// `remote` result means a surviving/other worker already owns the agent lease
// and runs the actor, so this replica constructed nothing (a no-op success, not
// a failure, and not a local re-ensure).
//   1. Stop running bots whose creator agent is NOT running (run state `stopped`
//      or absent) — the Traderton replacement for the removed source
//      `listRunningBotsForInactiveAgents` (which joined the dropped platform
//      `agents` table). Per-bot failures log + continue.
//   2. Re-ensure `running` agents whose actor is not alive in THIS process (dead
//      after a crash, or never rehydrated) — through the SAME single ensure entry
//      point boot-rehydrate uses, so E4 can make both lease-aware later.
// A thrown pass is logged (never swallowed) and the loop still reschedules
// (AGENTS rule: every async loop reschedules itself on failure). setTimeout
// self-reschedule (not setInterval) so a slow tick can't overlap the next.

import type { AgentDirectActorResult } from './agent-direct-actor-ensure.js';

/** One durable agent-run row the sweep reconciles (the subset it reads). */
export interface AgentRunRecord {
  ownerId: string;
  actorId: string;
  venueAccountId: string;
  venue: string;
  venueType: string;
}

/** The ports the sweep depends on — all injected, so a fake drives it in tests. */
export interface AgentOrphanSweepPorts {
  /** All `desired_state='running'` rows (the liveness source). */
  listRunningAgentRuns(): Promise<AgentRunRecord[]>;
  /** Every RUNNING agent-created bot: its id + creator agent id. */
  listRunningAgentBots(): Promise<Array<{ id: string; creatorId: string }>>;
  /** True when the agent's actor is alive (registered + running) in this process. */
  isActorAlive(actorId: string): boolean;
  /**
   * Re-ensure a running agent whose actor is dead — through the single ensure
   * entry point. 001 S4: the ensure is lease-aware. If another worker already
   * owns the `agent:{agentId}` lease (e.g. it took over after this one's actor
   * died), the ensure constructs nothing and resolves as a `remote` no-op
   * success. The sweep treats any non-throwing re-ensure as handled; the lease
   * acquire inside the ensure is what guarantees exactly one live actor across
   * replicas, so the sweep never needs to construct a duplicate itself.
   *
   * Returns the ownership outcome so the sweep can log local-vs-remote honestly
   * (a `remote` result is a no-op success — the actor runs on another replica).
   */
  reEnsureAgent(run: AgentRunRecord): Promise<AgentDirectActorResult>;
  /** Stop a bot: mark its row stopped + stop the in-process actor. Best-effort. */
  stopBot(botId: string): Promise<void>;
}

/** Minimal logger surface (matches `createLogger` output used in the boundary). */
interface SweepLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/** The `setTimeout` seam — injected so tests drive the loop with a fake clock. */
type SetTimeoutFn = (handler: () => void, ms: number) => { unref?: () => void };

export interface AgentOrphanSweepDeps {
  ports: AgentOrphanSweepPorts;
  /** How often the sweep runs (ms). Operator config `agentScanner.orphanSweepIntervalMs`. */
  sweepIntervalMs: number;
  logger: SweepLogger;
  /** Injected `setTimeout` for deterministic tests; defaults to the global. */
  setTimeoutFn?: SetTimeoutFn;
}

/**
 * Run one orphan-sweep tick (exported for direct unit testing). Both passes are
 * best-effort: a per-item failure is logged and the sweep moves on, so one bad
 * bot or agent never stalls the reconcile. Throws only if a top-level listing
 * query itself throws — the loop's `run` wrapper catches that and reschedules.
 */
export async function runAgentOrphanSweep(
  ports: AgentOrphanSweepPorts,
  logger: SweepLogger,
): Promise<void> {
  const runs = await ports.listRunningAgentRuns();
  const runningActorIds = new Set(runs.map((r) => r.actorId));

  // Pass 1 — stop running bots whose creator agent is not running.
  const runningBots = await ports.listRunningAgentBots();
  for (const bot of runningBots) {
    if (runningActorIds.has(bot.creatorId)) continue;
    try {
      await ports.stopBot(bot.id);
      logger.info({ botId: bot.id, creatorId: bot.creatorId }, 'orphan sweep: stopped bot of non-running agent');
    } catch (err) {
      // Best-effort: log + continue so one bad bot never stalls the sweep.
      logger.error({ err, botId: bot.id, creatorId: bot.creatorId }, 'orphan sweep: failed to stop orphaned bot; continuing');
    }
  }

  // Pass 2 — re-ensure running agents whose actor is dead in this process. The
  // re-ensure is lease-aware (001 S4): it reconstructs here only if THIS worker
  // wins the agent lease; if another worker already owns it, the ensure is a
  // `remote` no-op success and no duplicate actor is created.
  for (const run of runs) {
    if (ports.isActorAlive(run.actorId)) continue;
    try {
      const result = await ports.reEnsureAgent(run);
      if (result.owner === 'local') {
        logger.info({ ownerId: run.ownerId, actorId: run.actorId }, 'orphan sweep: re-ensured dead running agent actor locally');
      } else {
        // 001 S4 no-op success: another replica owns the lease + runs the actor.
        logger.info(
          { ownerId: run.ownerId, actorId: run.actorId, ownerWorkerId: result.workerId },
          'orphan sweep: dead running agent now owned by another worker — skipping local re-ensure',
        );
      }
    } catch (err) {
      // Best-effort: log + continue; the next sweep retries this agent.
      logger.warn({ err, ownerId: run.ownerId, actorId: run.actorId }, 'orphan sweep: failed to re-ensure agent actor; will retry next sweep');
    }
  }
}

/**
 * Start the self-rescheduling orphan-sweep loop and return a stop handle. The
 * first tick runs after `sweepIntervalMs` (not immediately) so boundary start-up
 * stays unblocked; each tick schedules the next on completion whether it
 * succeeded OR threw.
 */
export function startAgentOrphanSweep(deps: AgentOrphanSweepDeps): { stop: () => void } {
  const schedule = deps.setTimeoutFn ?? ((handler, ms) => setTimeout(handler, ms));
  let stopped = false;

  const scheduleNext = (): void => {
    if (stopped) return;
    // House convention (prune loops): do not unref; shutdown stops it explicitly
    // via the returned stop handle and the `stopped` latch no-ops any pending run.
    schedule(() => void run(), deps.sweepIntervalMs);
  };

  const run = async (): Promise<void> => {
    if (stopped) return;
    try {
      await runAgentOrphanSweep(deps.ports, deps.logger);
    } catch (err) {
      // Log and keep going — a failed sweep (e.g. a listing query threw) must not
      // stall the loop.
      deps.logger.error({ err }, 'agent orphan sweep failed; rescheduling');
    } finally {
      scheduleNext();
    }
  };

  scheduleNext();

  return {
    stop: () => {
      stopped = true;
    },
  };
}
