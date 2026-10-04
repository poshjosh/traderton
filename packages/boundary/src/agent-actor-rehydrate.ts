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
   * and constructs + starts the actor) with the stored coordinates.
   */
  ensureAgent(run: RehydrateAgentRun): Promise<void>;
  logger: RehydrateLogger;
}

/**
 * Rehydrate every running agent actor on boot. Returns the count successfully
 * (re-)ensured. Never throws: a per-agent failure is logged and skipped so one
 * bad agent cannot block boot; the orphan sweep retries it later.
 */
export async function rehydrateAgentActors(deps: RehydrateAgentActorsDeps): Promise<number> {
  const runs = await deps.listRunning();
  let ensured = 0;
  for (const run of runs) {
    try {
      await deps.ensureAgent(run);
      ensured++;
    } catch (err) {
      // Log + continue — do NOT crash boot on one agent's failure (e.g. a missing
      // credential). The orphan sweep will retry this agent.
      deps.logger.error(
        { err, ownerId: run.ownerId, actorId: run.actorId },
        'agent rehydrate: failed to ensure running agent actor on boot; leaving for orphan sweep',
      );
    }
  }
  if (ensured > 0) {
    deps.logger.info({ ensured, total: runs.length }, 'agent rehydrate: ensured running agent actors on boot');
  }
  return ensured;
}
