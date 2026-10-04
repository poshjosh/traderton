# 002 — E3: Traderton → consumer event channel

**Status:** E3-T PENDING (T1 DONE, T2 DONE, T3 PENDING, T4 PENDING, T5 PENDING);
E3-H GATED (herobids, awaiting human go).
**Depends on:** E2 step 2 (loader stamps `creatorType`/`creatorId`
on bot configs). **Repos:** traderton (E3-T), then herobids (E3-H, gated on human go).
**Source behaviour:** `git -C ../herobids show 45271d28^:apps/worker/src/index.ts`. Agent
actor callbacks ~L1320–1345: `emitTechnicalScanCompleted`, `emitAgentWake`,
`emitJournalEvent`, crash → `sessionManager.handleRuntimeFailure`. Bot `onHalted`
~L2192–2240: `emitInstanceStatus(creator, { status:'stopped',
reason:'bot_halted_error_limit', managedBots })` + `publishBotStatus(user)`. Bot
`onJournalEvent` ~L2244. Crash / start-failed: `publishBotStatus(user, 'crashed')`.

## Goal

Restore every event the in-process actors used to push to herobids. Traderton writes
notifications to a **dedicated outbox table**. A herobids relay polls them and republishes
the **existing** herobids message types, so no herobids consumer changes.

## Why a dedicated table, not `journal_events` (human-approved 2026-10-04)

`journal_events` is the trading audit log. `PgJournal.loadAgentJournalEvents` (behind
`get_agent_journal_events` → herobids agent evaluation) and the owner journal views return
**every** type for an actor. So notification rows would show up there as duplicate noise.
Notifications are also transient delivery records that can be pruned after a few days;
audit events are not. Separate table, separate retention. Audit-log growth itself is
handled by [003-journal-retention](../003-journal-retention/001-plan.md).

## Event vocabulary (Traderton-owned; add to 005)

Each row: `id` (UUIDv7), `type`, `ownerId`, `agentId | null` (the agent to notify),
`botId | null`, `payload jsonb`, `createdAt`. For a bot, `agentId` is its `creatorId` when
`creatorType==='agent'`.

| Type | Emitted from (composition wiring) | Payload | Herobids republish |
|---|---|---|---|
| `scan_completed` | agent `onTechnicalScanComplete` | `scan: TechnicalScanState` (signals capped, step T3) | `eventPublisher.emitTechnicalScanCompleted(agentId, scan)` |
| `agent_wake` | agent `emitAgentWake` | `wake: AgentWakePayload` | `eventPublisher.emitAgentWake(agentId, wake)` |
| `journal_event` | agent + bot `onJournalEvent` (exactly what the copied actors forward: reconciliation.*, strategy.error/fatal, stream.disconnect, scanner.*) | `journalType`, `detail` (JSON string, source shape) | `eventPublisher.emitJournalEvent(agentId, { journalType, detail })` → session circuit breaker |
| `bot_status` | bot `onHalted` / `onCrashed` / `onStartFailed` (E2 callbacks) | `status: 'stopped'\|'crashed'`, `reason` (`bot_halted_error_limit` / `runtime_crash` / `start_failed`), `managedBots` (creator's bots `{id,status}` at emit time) | agent set: `emitInstanceStatus(agentId, {status, reason, updatedAt, managedBots})`; always: `userEventPublisher.publishBotStatus(ownerId, botId, status)` |
| `agent_status` | agent `onCrashed` | `status: 'crashed'`, `error` (message only) | `sessionManager.handleRuntimeFailure(activeSessionId, agentId, ownerId, error)` |

- `journal_event` deliberately copies the forwarded subset, so the relay doesn't have to
  guess which audit types matter. Parity is exact.
- `ownerId` is herobids' user id (soft owner), so `publishBotStatus` needs no lookup.
- User-created bots have `agentId = null`, so only the user publish applies.
- Delivery is at-least-once. Payloads are additive-only.

## E3-T — Traderton (shippable alone; rows accumulate and get pruned)

### T1. Outbox table + repository
- `packages/db/src/schema/consumer-notifications.ts` + migration: columns as above.
  Indexes: `(created_at, id)` for the cursor scan, and `(agent_id)`.
- `ConsumerNotificationRepository` (`packages/db/src/consumer-notification-repository.ts`):
  - `append(entry)`
  - `scanAfter({ cursor?: {createdAt, seenIds}, types?, limit })`, same ordering and
    cursor semantics as `PgJournal.scanAfter` (asc `createdAt`, `id`)
  - `deleteOlderThan(cutoff, batchSize)`, deleting in batches
- Tests (integration, real Postgres):
  - "scans notifications after a cursor in creation order"
  - "filters by type"
  - "deletes only rows older than the cutoff, in batches"

### T2. Notifier
- `packages/worker/src/composition/consumer-notifier.ts`:
  `createConsumerNotifier(repo, logger)` with `scanCompleted`, `agentWake`,
  `journalEvent`, `botStatus` and `agentStatus` methods. Best-effort: it logs on failure
  and never throws into an actor (source callbacks were best-effort).
- Tests: "appends a routed notification for each method"; "swallows and logs a write
  failure".

### T3. Agent actor wiring (`decision-intake.ts` `constructAndRegisterAgentActor` ~L514–520)
- Replace the no-op `onTechnicalScanComplete`, `emitAgentWake` and `onJournalEvent` with
  notifier calls. `onCrashed`: keep deregister; add `agentStatus`. `AgentActorSpec` gains
  `ownerId` (the ensure has `injection.ownerId`).
- Scan payload cap: operator config `notifications.scanCompleted.maxSignals` (default 20,
  mirrors source `scannerCandidateLimit`). Truncate `signals` and set
  `signalsTruncated: true`.
- These callbacks only fire once E1 wires the scan loop; tests drive them directly:
  "forwards a completed technical scan to the agent"; "caps scan signals at the
  configured maximum".

### T4. Bot actor wiring (`create-trading-runtime.ts` actor factory)
- Pass `onJournalEvent` → `notifier.journalEvent`, routed by the instance config's
  `creatorType`/`creatorId` (E2 step 2).
- The E2 `onHalted` / `onCrashed` / `onStartFailed` additionally call
  `notifier.botStatus`. `managedBots` comes from
  `botRepo.getBotsByCreator('agent', creatorId)` (agent-created only).
- Tests:
  - "routes a bot strategy error to its creator agent"
  - "notifies bot_status stopped with the creator's bots when a bot halts"
  - "notifies only the owner for user-created bots"

### T5. Read tool + pruning
- New tool `scan_consumer_notifications` (read-database; **system subject only**, fenced
  like `scan_trade_events` via `allowedActorTypes:['system']`; consumer-only, so not in
  any skill tool set). Params: `cursor?`, `types?`, `limit` (Zod, max 500).
- Prune loop in `bin.ts`: every `notifications.pruneIntervalMs` (default 1h), delete rows
  older than `notifications.retentionDays` (default 7) in batches of
  `notifications.pruneBatchSize` (default 5000). It reschedules on failure (AGENTS rule).
- All `notifications.*` keys live in the trading config schema + `config/default.yaml`
  with comments (operator config). There are no env vars, so no `.env.example` change.
- Tests:
  - "returns notifications after the cursor for a system subject"
  - "rejects a non-system subject"
  - "prune loop deletes expired notifications and reschedules after a failure"
- 005: document the table semantics, the tool, at-least-once delivery, retention (the
  consumer must poll within `retentionDays`), and the additive-only payload rule.

## E3-H — herobids relay (GATED: start only after human go)

### H1. Relay
- `apps/worker/src/agents/actor-event-relay.ts`, modelled on
  `alerting/alert-dispatcher.ts`:
  - Redis lease `lease:actor-event-relay`, poll loop, reschedule on failure.
  - Reads through a small port backed by `scan_consumer_notifications` over a system
    read boundary (subject id `actor-event-relay`, created like
    `createBoundaryTradeEventFeed` in `index.ts` ~L514).
- **Cursor persisted in Redis** (`actor-event-relay:cursor`). AlertDispatcher keeps its
  cursor in memory and replays on restart, which is unacceptable for wakes.
  - When absent, initialise to "now".
  - Advance only after a batch is republished.
- Stale guard: skip `agent_wake` / `scan_completed` older than
  `actorEventRelay.maxEventAgeMs`. Never skip status or journal events.
- Republish per the vocabulary table. `agent_status` looks up the agent's active session;
  if there is none, log and skip.
- Zod-validate each payload; log and skip malformed rows without stalling the cursor.

### H2. Config + wiring
- `config/default.yaml` + domain schema: `actorEventRelay: { enabled, pollIntervalMs
  (5000), maxBatchSize (100), maxEventAgeMs (600000) }`, with comments. Construct only
  when a system read boundary is configured (mirror AlertDispatcher). Start and stop in
  `index.ts`.

### H3. Tests
`actor-event-relay.test.ts`:
- "republishes a scan completion to the agent's outbound stream"
- "republishes a bot halt as instance status with managed bots"
- "publishes user bot status for user-created bots"
- "starts from now when no cursor is stored"
- "does not advance the cursor when republishing fails"
- "skips stale wakes but delivers stale status events"
- "fails the agent session on a crashed agent actor"

Worker check: `pnpm exec tsc --noEmit -p apps/worker/tsconfig.json` + worker suite.

## Cross-stack proof (after both halves)
Halt a paper bot (inject repeated strategy errors) in Traderton. The owning agent stream
receives `instance.status` with `bot_halted_error_limit` within 2 poll intervals.

## Docs on completion
001 C2-table: `onTechnicalScanComplete` / `emitAgentWake` / `onJournalEvent` (agent and
bot) / `onHalted` notify / `publishBotStatus` / agent `onCrashed` → **Met** (scan rows only
become live with E1). Record the outbox table + polled delivery as Intentional divergence
(cross-process replacement for in-process callbacks). 000 "Open: backend→consumer event
channel" → settled (outbox table, polled; push remains 010 B10). 005 updated. 011 E3 ticked.

## Risks
- Latency is the poll interval (default 5s), versus near-zero in-process. Acceptable:
  scan intervals and breaker windows are minutes.
- If the relay is down longer than `retentionDays`, notifications are pruned unread.
  Acceptable, because they're stale by then; status truth stays in the `bots` table.
- At-least-once: a crash between republish and cursor save re-delivers a batch (a breaker
  may count one event twice). Accepted; noted in 005.

## Outstanding Issues (non-blocking, from code review)

### [T1] consumer_notifications outbox table + repository
- LOW: integration test uses `skipIf(!DATABASE_URL)` rather than a vitest exclude —
  consistent with existing journal/boundary integration tests (established convention).
- LOW: `deleteOlderThan` issues one extra no-op query when the expired-row count is an
  exact multiple of `batchSize`. Harmless.

### [T2] consumer notifier
- LOW: the best-effort error log omits `botId`; `journalEvent`/`botStatus` can carry a
  non-null botId, so a failed bot-scoped write loses that correlator. Harmless (rows aren't
  lost at the actor). Optional: add `botId: entry.botId ?? null` to the log object.
- LOW: doc-comment source line references (`~L1320–1345`, `~L2192–2244`) are drift-prone but
  match the plan's own provenance citations. No action.
