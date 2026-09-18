// Extracted from bin.ts so the agent-direct actor ensure-cache lifecycle is
// unit-testable without booting the boundary process (A1/A2 stability fixes,
// plan 001-trading-extraction-completion/A1-ensure-cache-crash-recovery).

import {
  createLogger,
  type TradingRuntime,
  type AgentActorSpec,
} from '@traderton/worker';

const logger = createLogger('boundary-agent-direct-ensure');

/**
 * The consumer-injected agent risk context (submit_decision payload only). The
 * fields are declared in the tool's Zod schema so they survive the dispatcher's
 * `payloadParse` (bug-001 lesson) and are extracted by the subject resolver.
 */
export interface AgentRiskSpec {
  capital?: string;
  riskPosture?: Record<string, unknown>;
  riskOverrides?: Record<string, number | undefined>;
}

/**
 * Build the lazy agent-direct actor ensure for the boundary (M2 GAP FIX —
 * item-C `constructAndRegisterAgentActor` had NO production caller: the M1
 * consumer (herobids' in-process AgentSessionManager) was deleted by herobids
 * L3d-5, and the M2 boundary never registered an agent actor, so EVERY
 * `submit_decision` for an agent subject failed `instance_not_running`
 * ("No execution context — ensure the actor is active and running").
 *
 * The boundary is now the lifecycle driver item D deferred to the consumer:
 * on the first `submit_decision` for a `(ownerId, actorId, venueAccountId)`
 * tuple it constructs + registers + STARTS the `AgentTradingActor` (start is
 * required — the second intake guard at decision-intake.ts:121 is only
 * reachable after a successful start). Cached per tuple.
 *
 * Cache policy for consumer-injected risk values:
 *  - `capital`/`riskPosture` CHANGED → stop + deregister the old actor and
 *    RECONSTRUCT fresh: these anchor the `EquityTracker` peak (construct-time
 *    state, agent-trading-actor.ts:2953) — carrying a changed capital into a
 *    live actor would silently skew peak equity/drawdown. The DailyLossTracker
 *    rehydrates from traderton's own fills, so rolling-24h loss history
 *    survives the swap. This matches M1 semantics (a capital change ≈ a new
 *    session constructing a fresh tracker).
 *  - Only `riskOverrides` CHANGED → hot-swap via `updateRiskLimits` (M1
 *    parity: herobids' adjust path hot-swapped limits to preserve per-trade
 *    exit levels / stop-loss timers, agent-trading-actor.ts:1010).
 *  - Never key the cache on the VALUES — one actor per capital edit would fork
 *    actors and never converge.
 *
 * INJECTED values only (ports-carry-values, 000/004): the venue coordinates +
 * owner mode come from the D2 injection; capital/riskPosture/riskOverrides come
 * from the consumer's submit_decision payload (the boundary process cannot read
 * the consumer's `agents` table — locked: no `agents`-table dependency, 017 §4 /
 * 019 §1). Absent values → operator defaults (graceful; backward compatible).
 * `paper`/`shadow` start without credentials; `shadow`/`live` can throw
 * `CredentialResolutionError` from the venue adapter factory — surfaced to the
 * dispatcher's catch, which (as of bug 001) logs internally and returns
 * `precondition.not_ready`.
 */
export function buildAgentDirectActorEnsure(
  runtime: TradingRuntime,
): (injection: {
  ownerId: string;
  actorId: string;
  ownerMode: 'paper' | 'shadow' | 'live';
  venue: string;
  venueType: 'orderbook' | 'swap';
  venueAccountId: string;
  agentRiskSpec?: AgentRiskSpec;
}) => Promise<void> {
  interface CacheEntry {
    ensure: Promise<void>;
    capital: string | undefined;
    riskPostureKey: string;
    riskOverridesKey: string;
  }

  // Keyed by ownerId+actorId+venueAccountId: a re-point of the SAME agent to a
  // DIFFERENT venue account must construct a fresh actor (the venueAccountId is
  // injected into the actor's adapter, not looked up at call time).
  const ensureCache = new Map<string, CacheEntry>();

  const postureKey = (posture: Record<string, unknown> | undefined): string =>
    JSON.stringify(posture ?? null);
  const overridesKey = (overrides: Record<string, number | undefined> | undefined): string =>
    JSON.stringify(overrides ?? null);

  return async (injection) => {
    const key = `${injection.ownerId}::${injection.actorId}::${injection.venueAccountId}`;
    const risk = injection.agentRiskSpec ?? {};
    const existing = ensureCache.get(key);

    if (existing) {
      // Serialize behind the in-flight construction (if any) before deciding:
      // liveness is only meaningful once the construction has settled.
      await existing.ensure.catch(() => { /* failed prior construction → reconstruct below */ });
      const capitalChanged = (risk.capital ?? undefined) !== existing.capital;
      const postureChanged = postureKey(risk.riskPosture) !== existing.riskPostureKey;
      const overridesChanged = overridesKey(risk.riskOverrides) !== existing.riskOverridesKey;
      const alive = runtime.actorRegistry.get(injection.actorId)?.isRunning === true;
      if (!capitalChanged && !postureChanged && !overridesChanged && alive) {
        return; // fast path — same spec, actor alive
      }
      logger.warn(
        { ownerId: injection.ownerId, agentId: injection.actorId, capitalChanged, postureChanged, overridesChanged, alive },
        'agent-direct actor ensure needs reconstruction — rebuilding',
      );
      // A2 re-read: concurrent callers awaiting the same stale entry resumed
      // with us — the FIRST one to resume already deleted + replaced this
      // entry with its in-flight reconstruction. If so, join it instead of
      // starting a second rebuild against a half-torn-down actor.
      const current = ensureCache.get(key);
      if (current && current !== existing) {
        await current.ensure;
        return;
      }
      ensureCache.delete(key);
    }

    // A2 single-flight (cache-entry ordering only — no mutex machinery): the
    // delete above and the `ensureCache.set` below happen in ONE synchronous
    // block, and the IIFO body defers its first teardown await until after
    // that set. A concurrent invocation can therefore never observe a missing
    // cache entry mid-teardown: it always finds this in-flight entry and
    // awaits the SAME stop→construct→start sequence. On failure the catch
    // below evicts, so the next attempt retries fresh.
    const ensure: Promise<void> = (async () => {
      // Stop + deregister the PREVIOUS actor FIRST: register uses the same
      // actorId key, so deregistering after registering the new actor would
      // evict the wrong entry. The registry stores `ExecutionActor` (no stop()
      // on the interface) — narrow to the AgentTradingActor surface the runtime
      // itself returns from constructAndRegisterAgentActor; only agent actors
      // are ever keyed by an agent-subject actorId, so the cast is sound.
      const previous = runtime.actorRegistry.get(injection.actorId);
      if (previous && previous.isRunning) {
        const agentActor = previous as unknown as Parameters<
          typeof runtime.stopAndDeregisterAgentActor
        >[0];
        await runtime.stopAndDeregisterAgentActor(agentActor).catch(() => { /* best-effort teardown */ });
      }

      const spec: AgentActorSpec = {
        agentId: injection.actorId,
        executionMode: injection.ownerMode,
        venueAccountId: injection.venueAccountId,
        venue: injection.venue,
        venueType: injection.venueType,
        capital: risk.capital ?? null,
        riskPosture: (risk.riskPosture ?? null) as AgentActorSpec['riskPosture'],
        riskOverrides: (risk.riskOverrides ?? {}) as AgentActorSpec['riskOverrides'],
      };
      const actor = runtime.constructAndRegisterAgentActor(spec);
      try {
        await actor.start();
        logger.info(
          { ownerId: injection.ownerId, agentId: injection.actorId, venueAccountId: injection.venueAccountId, mode: injection.ownerMode, capital: risk.capital ?? null },
          'agent-direct actor constructed + started',
        );
      } catch (err) {
        // Failed start: deregister so a later attempt constructs fresh rather
        // than reusing a half-started actor, then rethrow.
        await runtime.stopAndDeregisterAgentActor(actor).catch(() => { /* best-effort teardown */ });
        throw err;
      }
    })();

    // Stash the IN-FLIGHT promise (with the spec it was built from) so
    // concurrent invocations await the same construction.
    ensureCache.set(key, {
      ensure,
      capital: risk.capital ?? undefined,
      riskPostureKey: postureKey(risk.riskPosture),
      riskOverridesKey: overridesKey(risk.riskOverrides),
    });

    try {
      await ensure;
    } catch (err) {
      // Do NOT cache failures — evict so the next invocation retries
      // construction (e.g. after the operator provisions the credential).
      ensureCache.delete(key);
      throw err;
    }
  };
}
