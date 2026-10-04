// The boundary's agent-actor rehydrate-on-boot step (Wave E / E1-T T5). After
// `runtime.start()`, for every `agent_actor_runs` row with
// `desired_state='running'` we call the SAME ensure the lazy venue-resolving path
// uses, with the row's stored venue coordinates — reconstructing + starting the
// actor so it survives a Traderton restart. Extracted from bin.ts so it is
// unit-testable without booting the process (mirrors build-boundary-runtime.ts /
// agent-orphan-sweep.ts).
//
// Failures are logged PER AGENT and do NOT crash boot — a single credential-less
// or misconfigured agent must not block every other agent's rehydrate. The
// orphan sweep retries the ones that failed here (both go through the one ensure
// entry point, so E4 can make them lease-aware together).
//
// 001 S4 (lease-aware rehydrate): the ensure now takes the `agent:{agentId}`
// lease before constructing (001 S2), so a `remote` result is a DELIBERATE
// no-op success — another worker already holds the lease and runs the live
// actor, and THIS worker (having lost the acquire race) must NOT construct a
// duplicate. The single-actor-per-agent guarantee comes entirely from that
// lease acquire; rehydrate only has to NOT treat `remote` as a failure. The
// returned count is of agents (re-)constructed LOCALLY — `remote` outcomes are
// logged as skips for observability but excluded from the count.

import type { AgentDirectActorResult } from './agent-direct-actor-ensure.js';

/** One durable agent-run row to rehydrate (the subset the ensure needs). */
export interface RehydrateAgentRun {
  ownerId: string;
  actorId: string;
  venueAccountId: string;
  venue: string;
  venueType: string;
}

/** Minimal logger surface (matches `createLogger` output used in the boundary). */
interface RehydrateLogger {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface RehydrateAgentActorsDeps {
  /** All `desired_state='running'` rows (`AgentActorRunRepository.listRunning`). */
  listRunning(): Promise<RehydrateAgentRun[]>;
  /**
   * Re-ensure one agent through the single ensure entry point. The caller wraps
   * the real ensure (which reads the profile for the execution mode + scan config
   * and constructs + starts the actor) with the stored coordinates. Returns the
   * ensure's ownership outcome: `local` ⇒ this worker constructed the actor;
   * `remote` ⇒ another worker owns the lease and runs it (a no-op success here).
   */
  ensureAgent(run: RehydrateAgentRun): Promise<AgentDirectActorResult>;
  logger: RehydrateLogger;
}

/**
 * Rehydrate every running agent actor on boot. Returns the count constructed
 * LOCALLY on this worker. Never throws: a per-agent failure is logged and
 * skipped so one bad agent cannot block boot; the orphan sweep retries it later.
 *
 * 001 S4: a `remote` ensure result is a no-op success, NOT a failure — another
 * worker holds the `agent:{agentId}` lease and runs the actor, so this worker
 * deliberately constructs nothing (the lease acquire in the ensure is the sole
 * single-actor guarantee). Remote outcomes are logged as skips and excluded from
 * the returned local count.
 */
export async function rehydrateAgentActors(deps: RehydrateAgentActorsDeps): Promise<number> {
  const runs = await deps.listRunning();
  let constructedLocally = 0;
  let skippedRemote = 0;
  for (const run of runs) {
    try {
      const result = await deps.ensureAgent(run);
      if (result.owner === 'local') {
        constructedLocally++;
      } else {
        // 001 S4 no-op success: another worker owns the lease + runs the actor.
        // Not an error — just skip (do not construct a duplicate here).
        skippedRemote++;
        deps.logger.info(
          { ownerId: run.ownerId, actorId: run.actorId, ownerWorkerId: result.workerId },
          'agent rehydrate: running agent owned by another worker — skipping local construction',
        );
      }
    } catch (err) {
      // Log + continue — do NOT crash boot on one agent's failure (e.g. a missing
      // credential). The orphan sweep will retry this agent.
      deps.logger.error(
        { err, ownerId: run.ownerId, actorId: run.actorId },
        'agent rehydrate: failed to ensure running agent actor on boot; leaving for orphan sweep',
      );
    }
  }
  if (constructedLocally > 0 || skippedRemote > 0) {
    deps.logger.info(
      { constructedLocally, skippedRemote, total: runs.length },
      'agent rehydrate: ensured running agent actors on boot',
    );
  }
  return constructedLocally;
}
