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

### S3. Command forwarding — DONE
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

### S4. Rehydrate + sweep respect the lease — DONE
- E1 boot rehydrate and orphan sweep call the lease-aware ensure; `remote` is a no-op
  success.
- Test: "two runtimes rehydrating the same agent start exactly one actor".

### S5. Multi-replica integration proof (real Redis + Postgres) — DONE
1. Two boundary app instances in one test process share Redis and Postgres.
2. Activate an agent through instance A, then submit a decision through instance B. It
   executes once, on A, and B's caller gets the reply.
3. Stop A without a graceful release. After the TTL, B's sweep takes over, and a new
   decision through B executes on B.

Append to `scripts/shell/tests/run-integration.sh`.

### S6. Ops docs — DONE
- 007 operational readiness: remove the "one replica only" note once S5 passes. Document
  the takeover window (≤ lease TTL + sweep interval) and that decisions in that window
  return the existing retryable timeout.
- **Implemented 2026-10-04.** Added a "## Multi-Replica Boundary (agent-actor ownership)"
  section to 007 (ownership via `lease:instance:agent:{agentId}`, 30s TTL; forwarding;
  takeover window ≤ TTL (30s) + `agentScanner.orphanSweepIntervalMs` (60000ms, verified in
  `config/default.yaml` + `bin.ts` `sweepIntervalMs`)). 007 had NO "one replica only" note
  in its body (the caveat lived in 011 E4 + this plan), so the section instead states the
  former constraint is now lifted. **Accuracy correction vs the step text:** the window
  returns the tool's existing `decision_reply_timeout`, which is NOT transport-retryable —
  the copied `submit_decision` tool ignores the top-level `retryable` field (S3 finding), so
  the caller re-submits via its own loop; there is no automatic transport retry. 005 gained
  an internal/no-wire-change + takeover-timeout note in §Deadlines, Retries, And Idempotency.
  001 recorded E4 as **Improved**. 011 Wave E E4 ticked DONE. Code/tests untouched.

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

### S3 implementation notes (how the plan text was realised)
- **Module:** `packages/boundary/src/agent-command-router.ts` with three surfaces —
  `wrapPublishToInbound` (sender), `startAgentCommandConsumer` (consumer loop), and
  `subscribeAgentActorStopSignals` (stop subscriber). Co-located unit tests in
  `agent-command-router.test.ts` (the four plan-listed cases plus local/non-decision
  pass-through + the unknown-owner retryable-reply case). Wired in `bin.ts`.
- **Exported channel/list names + envelope shape.**
  - Command list: `agent-actor:cmd:{workerId}` (`AGENT_ACTOR_CMD_LIST_PREFIX`).
  - Stop channel: `agent-actor:stop:{agentId}` / pattern `agent-actor:stop:*`
    (`AGENT_ACTOR_STOP_CHANNEL_PREFIX` / `_PATTERN`).
  - Reply key: `agent:decision:reply:{decisionId}` (`DECISION_REPLY_KEY_PREFIX`) —
    reused as-is so the copied `submit_decision` tool's BLPOP matches.
  - Envelope: `{ type, payload, injection }` where `payload` is the UNCHANGED
    decision payload (keeps `decisionId` + `_expectsReply`) and `injection` is the
    resolved `AgentDirectActorInjection` (ownerId, actorId, ownerMode, venue,
    venueType, venueAccountId) the owner rebuilds its local drive target from.
    `injection` is a TRUSTED intra-cluster value — resolved by the sending
    container and carried over the shared internal Redis; the owner rebuilds the
    drive target from it directly and does NOT re-validate it owner-side (the
    command list is not an external trust boundary).
- **Not-ready reply shape (and what it actually buys us).** The unknown-owner
  (sender) and lease-lost (consumer) refusals write
  `{ status:'rejected', code:'precondition.not_ready', message, retryable:true }`
  — the `DecisionSubmitResult` rejected variant. The tool parses it
  (`parsed.status === 'rejected'`) and returns PROMPTLY with a clear
  `precondition.not_ready` rejection instead of hanging to its 30s BLPOP timeout.
  That fast fail is the real benefit. It is **not** a transport-level retry: the
  copied `submit_decision` tool (packages/worker/src/tools/trading.ts) derives
  `retryable:true` ONLY from `capability_denied:*` codes (and only
  `rate_limit`/`max_concurrent` within those), so the top-level `retryable` field
  on this reply is IGNORED and the caller sees `retryable:false`. The field is kept
  because it is harmless and documents intent. Re-submission is driven by the
  agent's own reasoning loop and the next decision's re-ensure resolving a concrete
  owner (or taking over locally) — not by any flag the tool reads. Only written
  when `payload._expectsReply === true`. **Follow-up (OUT of S3 scope):** making
  `precondition.not_ready` genuinely transport-retryable would require a tool-parse
  change in trading.ts (that file is an extracted parity copy and untouched here).
- **Lease-guard agentId source.** The consumer reads the agent id from
  `envelope.injection.actorId` (the decision payload does not carry it — the drive
  target stamps `deps.actorId` from the injection), then checks
  `lease.holder('agent:'+agentId) === workerId` before executing.
- **DEVIATION (minor, additive): new repo read `AgentActorRunRepository.getByActorId`.**
  The plan's stop-subscriber text ("stop the agent actor … if owned here") did not
  spell out owner resolution. The broadcast `agent-actor:stop:{agentId}` carries only
  the agent id, but the existing stop path (`agentActorLifecycleOps.stopAndEvictActor`
  → `ensure.evict`) needs the `ownerId` for the ensure cache key `${ownerId}::${actorId}`.
  Added a focused `getByActorId(actorId)` lookup (the `(ownerId, actorId)` unique index
  guarantees ≤1 row for a given owner+actor; a lone-`actorId` read returns the single
  such row, ordered defensively by most-recent `updatedAt`) so bin.ts resolves `ownerId`
  from the durable run row; no row ⇒ no-op. No schema change. This is a read-only,
  backward-compatible addition.
- **Consumer teardown.** `startAgentCommandConsumer` returns a `stop()` that latches a
  flag and quits its dedicated BLPOP connection; both it and the dedicated
  `agent-actor:stop:*` subscriber connection are torn down via the boundary shutdown's
  `stopBackgroundLoops` hook (alongside the existing prune/sweep loops). `quit()` is a
  declared member of the `AgentCommandConsumerRedis` interface (teardown genuinely
  depends on it to unblock the in-flight BLPOP), so `stop()` calls it directly with a
  best-effort `.catch()` rather than through a structural cast.

### S4 implementation notes (how the plan text was realised)
- **The `remote` no-op success already held after S2** — the lease acquire inside
  `buildAgentDirectActorEnsure` is the sole single-actor guarantee, and both callers
  (`rehydrateAgentActors` and `agentActorLifecycleOps.ensureFromRun`) already awaited and
  discarded the result. S4 makes that contract LEGIBLE and OBSERVABLE without changing the
  single-actor behavior:
  - Doc comments on `rehydrateAgentActors`, `ensureFromRun`, and the orphan sweep's
    `reEnsureAgent` port + pass-2 loop state that a `remote` ensure result is a deliberate
    no-op success (the owning worker runs the actor; a worker that lost the acquire race
    must not construct a duplicate).
  - **Minor, genuinely-S4 observability change (threaded result).** `ensureFromRun` now
    returns `AgentDirectActorResult` (was `Promise<void>`), and `rehydrateAgentActors`'
    `ensureAgent` port is now typed to return it too. Rehydrate counts only `local`
    constructions in its returned total and logs `remote` outcomes as skips
    (`constructedLocally` / `skippedRemote`). This surfaces "constructed here vs owned
    elsewhere" for boot observability. No single-actor behavior changed — the lease
    acquire was and remains the guarantee.
  - **bin.ts:** the rehydrate `ensureAgent` wrapper passes the result through unchanged;
    the orphan sweep's `reEnsureAgent` wrapper explicitly `await`s + discards the result
    (its port stays `Promise<void>` — the sweep only needs the ensure to have run).
- **Headline test:** `agent-actor-rehydrate-lease.test.ts` wires the REAL S2 ensure + REAL
  rehydrate over two fake runtimes (two "containers") sharing ONE in-memory lease holder
  `Map` (mirrors `makeFakeLease` from `agent-direct-actor-ensure.test.ts`). Case
  "two runtimes rehydrating the same agent start exactly one actor" runs both rehydrates
  concurrently and asserts exactly one construct across both registries, one alive actor
  (XOR), and the lease held by exactly the constructing worker. A second case covers the
  sequential late-boot ordering (A owns → B no-ops `remote`). Also added a rehydrate unit
  case: a `remote` result counts as a no-op success (0 local, no error log, info skip log).
- **Honored S1 rule:** the test only ever touches `agent:{agentId}` ids on the shared
  lease; it never `releaseAll`/`shutdown`s it.
- **Verification:** `pnpm lint` (repo-wide tsc) clean; `@traderton/boundary` `tsc --build`
  clean; full boundary vitest suite 196 passed / 32 skipped (integration), including the 2
  new lease tests. Not git-committed.

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

### S3 — Command forwarding
- [HIGH, ADDRESSED] The not-ready reply's top-level `retryable:true` is IGNORED by the
  copied `submit_decision` tool (it derives retryability only from `capability_denied:*`
  codes). Corrected all comments + the S3 notes to state the real behavior (fast-fail is
  the benefit; re-submission is driven by the agent's next decision / re-ensure, not a
  retry flag). Making `precondition.not_ready` transport-retryable needs a tool-parse
  change — OUT of S3 scope (follow-up).
- [MEDIUM, ADDRESSED] `stop()` quit-via-cast replaced with a declared `quit()` on
  `AgentCommandConsumerRedis`.
- [LOW, ADDRESSED] Corrected stale "tool retries" wording in the test narration.
- [LOW] The `agent-actor:stop:*` PUBLISHER is not part of S3 (the plan assigns it to a
  non-owner `stop_agent_actor` write path, a later step). S3 ships only the subscriber,
  so the stop path is dormant until a publisher exists.
- [LOW] `getByActorId` has no integration-test coverage yet (its repo integration test is
  in the always-skipped suite). Worth a case when S5's real-Redis/Postgres proof lands.

### S4 — Rehydrate + sweep respect the lease
- [MEDIUM, ADDRESSED] Sweep pass-2 previously logged "re-ensured … actor" unconditionally
  even on a non-owner replica. Threaded `AgentDirectActorResult` through the sweep's
  `reEnsureAgent` port so it logs local-vs-remote honestly (remote = no-op success);
  added a test asserting the remote-skip log. Rehydrate/sweep observability now symmetric.
- [MEDIUM] The concurrent `Promise.all` rehydrate test does not exercise TRUE interleaving
  (the fake `acquire` is synchronous, so the SET-NX race resolves by call order). It still
  faithfully models Redis SET-NX atomicity and the XOR/single-construct invariants. True
  cross-replica interleaving over real Redis is proven by S5 (next). Left as-is.
- [LOW] Test-local `injectionFor` duplicates the production venueType narrowing (mirrors
  `ensureFromRun`'s `injectionFor`); a future narrowing-rule change must be mirrored.

### S5 — Multi-replica integration proof
- New gated integration test `packages/boundary/src/agent-actor-multi-replica.integration.test.ts`
  (DATABASE_URL/REDIS_URL `skipIf`); appended to `run-integration.sh`. CASE 1 (B→A forward,
  A executes, B's caller gets the reply), CASE 1b (sender envelope-contract assertion on
  A's command list — added to lock the sender contract, CodeReviewer MEDIUM), CASE 2
  (A dies via `agentLease.shutdown()` + `del` lease key → B's sweep takes over → local on B).
  Original CASE 1 + CASE 2 verified LIVE by the implementer (2 passed). CASE 1b compiles +
  skips cleanly; it will run live under the final `run-five.sh` (tt-integration).
- [MEDIUM, ADDRESSED] Reply-writer attribution was proven by construction; CASE 1b now
  asserts the raw forwarded envelope (unchanged payload + resolved injection) and that the
  sender writes NO reply, locking the sender contract against drift.
- [LOW] CASE 2 does not exercise forwarding TO B after takeover (both ensures are local
  post-takeover) — the forward path is covered by CASE 1. Optional future case.
- [LOW] Test gives the S3 sender its own tracked Redis connection (the runtime does not
  expose its internal connection); functionally identical on one Redis server.

### S6 — Ops docs
- 007: new "Multi-Replica Boundary (agent-actor ownership)" section + takeover-window
  subsection (≤ 30s TTL + `agentScanner.orphanSweepIntervalMs` 60s; window returns the
  existing `decision_reply_timeout`, no automatic transport retry — accurate per S3).
- 005: remote-owner routing documented as internal/no-wire-change; takeover timeout framed
  as the existing contract, no new failure code.
- 001 parity ledger: lease + forwarding recorded as **Improved**; the stale E1-T
  "no lease yet / one-replica" note updated to point forward to E4 (CodeReviewer MEDIUM #1).
- 011: Wave E E4 ticked DONE; "one replica only" caveat lifted.
- [MEDIUM, ADDRESSED] Fixed the operator-facing contradictions in the E Wave 000-overview
  ("Single boundary replica assumed" bullet + risk-table row) that were falsified by E4.
- [LOW, ADDRESSED] Tightened "same handle the bot lease uses" wording in 001 to "shares the
  bot lease's Redis connection + prefix (agent: namespace never collides with UUID bot ids)".
- [LOW] 003-e1 plan's historical "safe only with one boundary replica" note left as-is (it
  already points to 002 and is a superseded planning note, not an operator doc).
