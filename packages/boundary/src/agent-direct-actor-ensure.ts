// Extracted from bin.ts so the agent-direct actor ensure-cache lifecycle is
// unit-testable without booting the boundary process (A1/A2 stability fixes,
// plan 001-trading-extraction-completion/A1-ensure-cache-crash-recovery).

import {
  createLogger,
  type TradingRuntime,
  type AgentActorSpec,
} from '@traderton/worker';
import type {
  ActiveStrategy,
  AgentRiskOverrides,
  ExecutionDefaults,
  RiskPosture,
  ScanMode,
} from '@traderton/domain';

const logger = createLogger('boundary-agent-direct-ensure');

/**
 * The consumer-injected agent risk context (submit_decision payload only). The
 * fields are declared in the tool's Zod schema so they survive the dispatcher's
 * `payloadParse` (bug-001 lesson) and are extracted by the subject resolver.
 */
export interface StoredTradingProfile {
  capital: string | null;
  riskPosture: RiskPosture | null;
  riskOverrides: AgentRiskOverrides;
  executionDefaults: ExecutionDefaults | null;
  /**
   * Traderton-owned scan config (E1-T T1), threaded from the profile row into
   * the actor spec. `scanMode` set (not null) ⇒ the agent runs a technical scan
   * loop over `activeStrategy.technical`. A change to either rides the profile
   * `revision` bump, so the existing reconstruct path (below) re-applies them.
   */
  scanMode: ScanMode | null;
  activeStrategy: ActiveStrategy | null;
  revision: bigint;
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
 *  - ANY of `capital` / `riskPosture` / `riskOverrides` CHANGED → stop +
 *    deregister the old actor and RECONSTRUCT fresh. Capital/posture anchor the
 *    `EquityTracker` peak (construct-time state, agent-trading-actor.ts:2953) —
 *    carrying a changed capital into a live actor would silently skew peak
 *    equity/drawdown — so a rebuild is required for those regardless. Overrides
 *    are folded into the SAME rebuild rather than hot-swapped: a single
 *    reconstruct path keeps the ordering simple and re-applies the full spec.
 *    The DailyLossTracker rehydrates from traderton's own fills, so rolling-24h
 *    loss history survives the swap (M1 semantics: a change ≈ a new session
 *    constructing a fresh tracker).
 *  - FUTURE OPTIMIZATION (not implemented — Track A is stability-first): an
 *    overrides-ONLY change could hot-swap via `updateRiskLimits`
 *    (agent-trading-actor.ts:1010) to preserve per-trade exit levels /
 *    stop-loss timers instead of rebuilding. Deliberately deferred; today all
 *    changes reconstruct.
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
/** The injection the ensure consumes (resolved venue coordinates + owner mode). */
export interface AgentDirectActorInjection {
  ownerId: string;
  actorId: string;
  ownerMode: 'paper' | 'shadow' | 'live';
  venue: string;
  venueType: 'orderbook' | 'swap';
  venueAccountId: string;
}

/**
 * The ownership outcome of an ensure call (001 S2). `local` means THIS worker
 * acquired the `agent:{agentId}` lease and constructed/started the actor here;
 * `remote` means another worker already holds the lease and owns the live actor,
 * so this worker did NOT construct. The `workerId` on a `remote` result is the
 * current lease holder's worker id, which S3 command-forwarding routes decisions
 * to (`agent-actor:cmd:{workerId}`).
 */
export type AgentDirectActorResult =
  | { owner: 'local' }
  // `workerId` is the current lease holder's id. An EMPTY STRING is the
  // "holder unknown" sentinel: the lease was acquired by a remote worker but
  // expired between our `acquire` and the follow-up `holder` read (a rare race).
  // S3 MUST treat `workerId === ''` as retryable (do NOT `RPUSH` to an empty
  // `agent-actor:cmd:` key) — a re-ensure will resolve to a concrete owner or to
  // `local` once a surviving worker takes over.
  | { owner: 'remote'; workerId: string };

/**
 * The ensure callable: construct-or-reuse the agent actor for an injection, plus
 * an `evict(ownerId, actorId)` method (Wave E / E1-T T5) that drops the cache
 * entry WITHOUT touching the actor. `stop_agent_actor` calls `evict` after it has
 * stopped + deregistered the actor so the NEXT `start_agent_actor` (or lazy
 * venue-resolving call) reconstructs fresh rather than reusing a torn-down entry.
 *
 * 001 S2: the ensure now takes the `agent:{agentId}` lease before constructing
 * and returns the resulting ownership (`local` / `remote`). `evict` ALSO releases
 * the lease — it is called by the `stop_agent_actor` flow after the actor is torn
 * down, which is exactly when this worker must relinquish ownership so a surviving
 * worker's orphan sweep can take over.
 */
export interface AgentDirectActorEnsure {
  (injection: AgentDirectActorInjection): Promise<AgentDirectActorResult>;
  /**
   * Drop the cache entry for `${ownerId}::${actorId}` AND release this worker's
   * `agent:{actorId}` lease (001 S2 — `stop_agent_actor` / evict path). Releasing
   * is best-effort and fire-and-forget: `release` only deletes the key when we
   * still hold it, so a non-owner evict is a harmless no-op. Lease release failure
   * must not block cache eviction, so errors are swallowed (logged).
   */
  evict(ownerId: string, actorId: string): void;
}

export function buildAgentDirectActorEnsure(
  runtime: TradingRuntime,
  getProfile: (ownerId: string, actorId: string, venueAccountId: string) => Promise<StoredTradingProfile | null>,
): AgentDirectActorEnsure {
  // The lease id for an agent actor (001 S2). Namespaced with `agent:` so it
  // never collides with a bot lease (bot ids are UUIDs) on the SHARED
  // `InstanceLease` instance. We only ever acquire/release/holder-check this
  // `agent:`-prefixed id on `runtime.agentLease` — never releaseAll/shutdown it
  // (that handle shares its renew timers with the bot lease; 001 S1 risk note).
  const leaseIdFor = (actorId: string): string => `agent:${actorId}`;

  interface CacheEntry {
    ensure: Promise<AgentDirectActorResult>;
    revision: bigint;
    venueAccountId: string;
  }

  // The actor registry itself is keyed by agent id. Cache at the same identity
  // boundary so a selected-binding switch cannot fast-path a stale cache entry.
  const ensureCache = new Map<string, CacheEntry>();

  const ensure = (async (injection: AgentDirectActorInjection): Promise<AgentDirectActorResult> => {
    const key = `${injection.ownerId}::${injection.actorId}`;
    const leaseId = leaseIdFor(injection.actorId);
    const profile = await getProfile(injection.ownerId, injection.actorId, injection.venueAccountId);
    if (!profile) {
      throw new Error('selected agent trading profile is missing');
    }
    const mode = profile.executionDefaults?.mode;
    if (!mode) {
      throw new Error('selected agent trading profile has no execution mode');
    }
    const existing = ensureCache.get(key);

    if (existing) {
      // Serialize behind the in-flight construction (if any) before deciding:
      // liveness is only meaningful once the construction has settled.
      const prior = await existing.ensure.catch(() => { /* failed prior construction → reconstruct below */ });
      // A prior ensure that settled as `remote` built nothing locally: do not
      // treat it as a live local actor — re-check ownership below.
      const alive = runtime.actorRegistry.get(injection.actorId)?.isRunning === true;
      // 001 S2 lease-loss detection WITHOUT modifying the copied InstanceLease:
      // its renew timer stops silently on a lost renewal (it does not signal
      // callers), so a cached entry can outlive our ownership. Before trusting a
      // cached-local actor, confirm we STILL hold the lease. If the holder is no
      // longer us (expired/stolen), evict + fall through to reconstruct — which
      // re-acquires (and may land `remote` if another worker took over).
      // A prior `remote` result is NEVER fast-pathed: ownership can change under
      // us (the foreign owner dies, its lease expires, a surviving worker's
      // orphan sweep takes over). So a remotely-owned agent re-probes via
      // acquire+holder on EVERY ensure — the cached remote entry exists only to
      // settle concurrent callers, not to short-circuit. Only a confirmed
      // local+alive+still-held entry takes the fast path below.
      if (prior?.owner === 'local' && alive) {
        const holder = await runtime.agentLease.holder(leaseId);
        if (holder === runtime.workerId) {
          if (existing.revision === profile.revision && existing.venueAccountId === injection.venueAccountId) {
            return prior;
          }
        } else {
          logger.warn(
            { ownerId: injection.ownerId, agentId: injection.actorId, holder },
            'agent-direct actor ensure lost the agent lease — evicting cached entry',
          );
        }
      }
      logger.warn(
        { ownerId: injection.ownerId, agentId: injection.actorId, revision: profile.revision.toString(), alive },
        'agent-direct actor ensure needs reconstruction — rebuilding',
      );
      // A2 re-read: concurrent callers awaiting the same stale entry resumed
      // with us — the FIRST one to resume already deleted + replaced this
      // entry with its in-flight reconstruction. If so, join it instead of
      // starting a second rebuild against a half-torn-down actor.
      const current = ensureCache.get(key);
      if (current && current !== existing) {
        return current.ensure;
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
    const ensurePromise: Promise<AgentDirectActorResult> = (async () => {
      // 001 S2: take ownership BEFORE constructing. `acquire` sets the lease with
      // SET NX (and starts the renew timer) only if no one holds it. If another
      // worker already owns this agent, acquire returns false — we construct
      // NOTHING locally and report `remote` with the holder's worker id so S3
      // command-forwarding routes decisions to the owner.
      //
      // SAFETY INVARIANT (load-bearing for lease ownership, not just actor
      // identity): the A2 single-flight cache guarantees exactly ONE in-flight
      // `ensurePromise` per `key` — concurrent callers join the SAME promise
      // above rather than entering this IIFE again. That is what prevents two
      // overlapping reconstructs on one worker from each running the
      // `acquire→false, holder===workerId → rebuild` self-owned branch and
      // racing to own the registry under one shared lease. Do not weaken the
      // single-flight ordering without re-deriving this guarantee.
      const acquired = await runtime.agentLease.acquire(leaseId);
      if (!acquired) {
        // `acquire` fails BOTH when another worker holds it AND when WE already
        // hold it (SET NX): a reconstruct (revision/venue change) runs under a
        // lease we took on the first ensure. Distinguish the two by the holder.
        const holder = await runtime.agentLease.holder(leaseId);
        if (holder !== runtime.workerId) {
          logger.info(
            { ownerId: injection.ownerId, agentId: injection.actorId, holder },
            'agent-direct actor owned by another worker — not constructing locally',
          );
          // `holder` can be null if the lease expired between acquire and this
          // read (a rare race). Report what we observed; an empty string keeps
          // the result well-typed and lets S3 treat it as "unknown owner → retry".
          return { owner: 'remote', workerId: holder ?? '' };
        }
        // We already own it (reconstruct path): fall through and rebuild. The
        // renew timer from the original acquire is still running.
      }

      // From here on we hold the `agent:{actorId}` lease. Any throw below must
      // release it so a surviving worker (or a later retry) can take over.
      try {
        // Stop + deregister the PREVIOUS actor FIRST: register uses the same
        // actorId key, so deregistering after registering the new actor would
        // evict the wrong entry. The registry stores `ExecutionActor` (no stop()
        // on the interface) — narrow to the AgentTradingActor surface the runtime
        // itself returns from constructAndRegisterAgentActor; only agent actors
        // are ever keyed by an agent-subject actorId, so the cast is sound.
        const previous = runtime.actorRegistry.get(injection.actorId);
        if (previous) {
          const agentActor = previous as unknown as Parameters<
            typeof runtime.stopAndDeregisterAgentActor
          >[0];
          await runtime.stopAndDeregisterAgentActor(agentActor);
        }

        const spec: AgentActorSpec = {
          agentId: injection.actorId,
          ownerId: injection.ownerId,
          executionMode: mode,
          venueAccountId: injection.venueAccountId,
          venue: injection.venue,
          venueType: injection.venueType,
          capital: profile.capital,
          riskPosture: profile.riskPosture,
          riskOverrides: profile.riskOverrides,
          // Traderton-owned scan config (E1-T T4): the actor starts a scan loop
          // only when scanMode is set AND activeStrategy carries a resolved
          // technical config. A profile change bumps `revision`, which forces the
          // reconstruct above, so a technical/preset change applies through the
          // existing rebuild path (hot-apply deferred to 010).
          scanMode: profile.scanMode,
          activeStrategy: profile.activeStrategy,
        };
        const actor = runtime.constructAndRegisterAgentActor(spec);
        try {
          await actor.start();
          logger.info(
            { ownerId: injection.ownerId, agentId: injection.actorId, venueAccountId: injection.venueAccountId, mode, capital: profile.capital },
            'agent-direct actor constructed + started',
          );
        } catch (err) {
          // Failed start: deregister so a later attempt constructs fresh rather
          // than reusing a half-started actor, then rethrow (the outer handler
          // releases the lease we acquired for this construction).
          await runtime.stopAndDeregisterAgentActor(actor).catch(() => { /* best-effort teardown */ });
          throw err;
        }
        return { owner: 'local' };
      } catch (err) {
        // Construction failed under our lease: release it so a surviving worker
        // (or a later retry here) can take over. Best-effort — a release failure
        // must not mask the construction error.
        await runtime.agentLease.release(leaseId).catch(() => { /* best-effort lease release */ });
        throw err;
      }
    })();

    // Stash the IN-FLIGHT promise (with the spec it was built from) so
    // concurrent invocations await the same construction.
    ensureCache.set(key, {
      ensure: ensurePromise,
      revision: profile.revision,
      venueAccountId: injection.venueAccountId,
    });

    try {
      return await ensurePromise;
    } catch (err) {
      // Do NOT cache failures — evict so the next invocation retries
      // construction (e.g. after the operator provisions the credential).
      ensureCache.delete(key);
      throw err;
    }
  }) as AgentDirectActorEnsure;

  // E1-T T5: drop the cache entry WITHOUT touching the actor. `stop_agent_actor`
  // calls this after it has stopped + deregistered the actor, so the NEXT ensure
  // (an explicit start, or a later lazy venue-resolving call) reconstructs fresh
  // instead of reusing a cache entry whose actor is already torn down.
  //
  // 001 S2: evict ALSO releases the `agent:{actorId}` lease. `stop_agent_actor`
  // (and the orphan-sweep stop path) is exactly where this worker relinquishes
  // ownership, so a surviving worker's sweep can take over. `release` only
  // deletes the key when WE still hold it, so a non-owner evict is a harmless
  // no-op. Fire-and-forget: a lease-release failure must not block cache
  // eviction (nor can `evict` be async — the type is `void`), so we attach a
  // catch to log and swallow.
  ensure.evict = (ownerId: string, actorId: string): void => {
    ensureCache.delete(`${ownerId}::${actorId}`);
    void runtime.agentLease.release(leaseIdFor(actorId)).catch((err: unknown) => {
      logger.warn({ err, ownerId, agentId: actorId }, 'agent-direct actor evict: lease release failed (ignored)');
    });
  };

  return ensure;
}
