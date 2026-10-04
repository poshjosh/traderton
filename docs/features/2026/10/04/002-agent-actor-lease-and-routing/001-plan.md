# 001 — Agent-actor lease + owner routing (safe multi-replica boundary)

**Status:** planned. **Date:** 2026-10-04. **Repos:** traderton only.
**Depends on:** Wave E E1-T ([003-e1 plan](../001-wave-e-actor-events-and-lifecycle/003-e1-agent-scan-loop-plan.md):
`agent_actor_runs`, boot rehydrate, orphan sweep). **Not cutover-blocking:** production
runs one `boundary` container (`infra/hetzner/compose.yaml`). This plan makes running
more than one safe. Until it lands, 007 must say "one boundary replica only".

## Problem (plain terms)

Bots are protected when two Traderton containers run: each bot has a Redis lease
(`InstanceLease`, `lease:instance:{botId}`, 30s TTL, auto-renewed), so only one container
runs it. Agent actors have none:
- The lazy ensure (`agent-direct-actor-ensure.ts`) builds an actor in **whichever**
  container receives the call.
- After E1, the boot rehydrate and the orphan sweep in **every** container would restore
  the same agent.

The result would be duplicate scan loops and wakes, two risk/equity trackers for one
agent, and decisions landing on either copy.

## Design

1. **One owner per agent actor, via the existing lease.** Lease id `agent:{agentId}` on the
   same `InstanceLease` (prefix `lease:instance:` + `agent:` namespace; bot ids are
   UUIDs, so they can't collide). `instance-lease.ts` is a copied file and stays
   unchanged. The holder value is the container's `workerId`, which `createTradingRuntime`
   already generates. Expose it as `TradingRuntime.workerId`.
2. **The ensure takes the lease before constructing.**
   - Acquired → construct, start, keep renewing, as today.
   - Held by another worker → do **not** construct; mark the context `remoteOwner =
     holderWorkerId`.
   - Release on `stop_agent_actor`, on actor crash, and on graceful shutdown (E2 step 4).
3. **Owner routing for actor-bound commands.** The only command that needs the live actor
   is `submit_decision` (drive `DECISION_SUBMIT` → `runtime.submitDecision`).
   - **Read tools** read Postgres and are fine on any container.
   - **`start_agent_actor` / `stop_agent_actor` / profile changes** act through run state
     plus the lease. A stop on a non-owner sets `desiredState='stopped'` and publishes
     `agent-actor:stop:{agentId}`. The owner stops on that signal; same pattern as E0's
     `bot:stop:*`.
   - **Decisions on a non-owner.** The drive target pushes the unchanged `DECISION_SUBMIT`
     envelope onto `agent-actor:cmd:{ownerWorkerId}` (Redis list). The owner's command
     consumer pops it and runs `runtime.submitDecision` locally.
   - **Replies need no new plumbing.** The copied `submit_decision` tool already waits
     (BLPOP) on `agent:decision:reply:{id}` in shared Redis, and the owner writes the reply
     there exactly as the local path does.
   - Idempotency is unchanged: `boundary_invocations` dedup happens before dispatch, in
     Postgres.
4. **Takeover when an owner dies.** Its lease expires after 30s. The E1 orphan sweep on a
   surviving container re-ensures every `desiredState='running'` agent with no live lease,
   and whoever wins the lease runs it. A decision forwarded to a dead owner times out at
   the tool's existing deadline. That returns the existing retryable timeout; the retry
   lands after takeover.

## Steps

### S1. Expose identity + lease on the runtime — DONE
- `TradingRuntime` gains `workerId` and `agentLease` (an `InstanceLease` sharing the
  runtime's Redis connection and `workerId`).
- Test: "exposes the runtime's worker id".

### S2. Lease-aware ensure — DONE
- `agent-direct-actor-ensure.ts`:
  - Acquire `agent:{agentId}` before constructing.
  - If held elsewhere, return `{ owner: 'remote', workerId }`; otherwise
    `{ owner: 'local' }`.
  - Release on reconstruct failure and on stop.
  - Evict the cache entry on lease loss (a failed renewal).
- Tests:
  - "constructs only after acquiring the agent lease"
  - "does not construct when another worker holds the lease"
  - "releases the lease when construction fails"

### S3. Command forwarding — PENDING
- `packages/boundary/src/agent-command-router.ts`:
  - **Sender:** wraps the drive target. For `DECISION_SUBMIT`, if the ensure said
    `remote`, `RPUSH agent-actor:cmd:{workerId}` with the envelope.
  - **Consumer:** a blocking pop loop per container on its own list, with a dedicated
    Redis connection. It runs the drive target locally, reschedules on failure, and
    stops on shutdown.
  - **Guard:** the consumer checks that it still holds the agent's lease before
    executing. If not, it writes a retryable `precondition.not_ready` reply rather than
    executing.
- Stop signal: `agent-actor:stop:*` subscriber (same shape as `bot-stop-subscriber.ts`).
- Tests:
  - "forwards a decision for a remotely owned agent to the owner's command list"
  - "owner executes a forwarded decision and replies on the tool's reply key"
  - "refuses a forwarded decision after losing the lease"
  - "stops a remotely owned agent actor on the stop signal"

### S4. Rehydrate + sweep respect the lease — PENDING
- E1 boot rehydrate and orphan sweep call the lease-aware ensure; `remote` is a no-op
  success.
- Test: "two runtimes rehydrating the same agent start exactly one actor".

### S5. Multi-replica integration proof (real Redis + Postgres) — PENDING
1. Two boundary app instances in one test process share Redis and Postgres.
2. Activate an agent through instance A, then submit a decision through instance B. It
   executes once, on A, and B's caller gets the reply.
3. Stop A without a graceful release. After the TTL, B's sweep takes over, and a new
   decision through B executes on B.

Append to `scripts/shell/tests/run-integration.sh`.

### S6. Ops docs — PENDING
- 007 operational readiness: remove the "one replica only" note once S5 passes. Document
  the takeover window (≤ lease TTL + sweep interval) and that decisions in that window
  return the existing retryable timeout.

## Verification
`pnpm build && pnpm lint && pnpm test`; package-level type-check of new tests;
`scripts/shell/tests/run-integration.sh`.

## Docs on completion
001: record the lease + forwarding as **Improved** (the source ran one worker per agent
in-process; Traderton adds multi-replica safety). 005: the `remote owner` behaviour is
internal, with no wire change; note the takeover-window timeout semantics. 011 Wave E E4
ticked.

## Risks
- **Takeover resets in-memory actor state** (equity peak, circuit breaker). This is the
  same as today's restart/rebuild semantics: daily loss rehydrates from fills. Documented,
  not new.
- **Split-brain if Redis loses a lease mid-flight.** The consumer's
  lease-still-held check before executing bounds this. Each container's actors stop
  their renew timer and self-stop on renewal failure (verify `InstanceLease` renewal-failure
  handling; add a callback in the ensure if the copied lease does not signal it).
- **Ordering:** two decisions for one agent through different containers serialize on
  the owner's command list, but not relative to the owner's own direct calls. That's the
  same guarantee as two concurrent calls on one container today.

### S2 implementation notes (how the plan text was realised)
- **Lease-loss detection without touching `InstanceLease`.** As the plan's split-brain
  risk anticipated, the copied `InstanceLease` stops its renew timer silently on a lost
  renewal and does not signal callers. Rather than add a callback into the copied file
  (kept unchanged per S1), S2 detects loss lazily on the cache-hit path: before trusting
  a cached `local`+alive entry, the ensure re-checks `agentLease.holder('agent:'+actorId)
  === runtime.workerId`. If we no longer hold it, the cache entry is evicted and the
  ensure falls through to reconstruct — which re-acquires (and may legitimately land
  `remote` if another worker took over). This is the "add a callback in the ensure if the
  copied lease does not signal it" option, implemented as a holder re-check (cheaper, no
  extra timer, no mutation of the shared lease). The S3 consumer's lease-still-held check
  before executing a forwarded decision remains the authoritative split-brain guard.
- **Self-owned reconstruct.** `acquire` uses `SET NX`, so it returns `false` BOTH when a
  remote worker holds the lease AND when THIS worker already holds it (the revision/venue
  reconstruct path runs under the lease taken on the first ensure). The ensure
  distinguishes the two by comparing `holder(...)` to `runtime.workerId`: a foreign holder
  ⇒ return `{ owner: 'remote', workerId }` and construct nothing; our own holder ⇒ proceed
  to rebuild (the original renew timer keeps running). This was implicit in "acquired →
  construct … as today" but is called out here because it is the one non-obvious branch.
- **`evict` also releases the lease.** The plan says "release on `stop_agent_actor`". The
  boundary's stop path (`agent-actor-lifecycle-ops.ts`) already calls `ensure.evict(...)`
  after stopping+deregistering the actor, so S2 folds the `agent:{actorId}` release into
  `evict` (best-effort, fire-and-forget; `release` is a no-op when we are not the holder).
  No new call site is needed in the stop flow.
- **Return type.** `AgentDirectActorEnsure` now returns `Promise<AgentDirectActorResult>`
  (`{ owner: 'local' } | { owner: 'remote'; workerId }`). Existing in-repo callers
  (`bin.ts` context factory, `agent-actor-lifecycle-ops.ts` `ensureFromRun`) `await` and
  discard the result, so the change is non-breaking for them; S3 is the first consumer of
  the `remote` branch.

## Outstanding Issues

Non-critical review findings carried forward (grouped by step). None are blocking.

### S1 — Expose identity + lease on the runtime
- [MEDIUM, ADDRESSED] `agentLease` is the same `InstanceLease` instance as the bot lease
  (shared `renewTimers`). A later whole-handle teardown would tear down bot-lease
  renewal timers. Mitigated by a doc note on the interface field instructing S2/S3 to
  acquire/release only `agent:{agentId}` ids on this handle. S2/S3 must honour it.
- [LOW] Interface field ordering: `workerId`/`agentLease` sit between `shutdown()` and
  `runtime`. Cosmetic only.
- [LOW] Optional test tightening: assert `agentLease instanceof InstanceLease` rather
  than only `toBeDefined()`.

### S2 — Lease-aware ensure
- [MEDIUM, ADDRESSED] Remote cache entries never fast-path (re-probe each call); added a
  clarifying comment + a takeover test ("re-ensure after a remote result stays remote,
  then takes over once the foreign lease expires").
- [MEDIUM, ADDRESSED] Single-flight is now load-bearing for lease ownership (prevents a
  double-acquire split). Added a safety-invariant comment in the acquire block + a test
  ("acquires the lease exactly once under concurrent ensures for the same agent").
- [LOW, ADDRESSED] `workerId: ''` unknown-owner sentinel documented on
  `AgentDirectActorResult` for S3; non-owner `evict` no-op test added.
