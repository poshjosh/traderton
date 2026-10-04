# 001 — E2: bot status truth + restart survival (Traderton only)

**Status:** PENDING (steps: 1 DONE, 2 DONE, 3 DONE, 4 DONE, 5 PENDING).
**Depends on:** nothing (E0 done). **Repos:** traderton only.
**Source behaviour:** `git -C ../herobids show 45271d28^:apps/worker/src/index.ts`:
`WorkerRuntime` callbacks ~L1785–1880, bot actor `onCrashed`/`onHalted` ~L2160–2240,
`instanceLoader` ~L2262–2268.

## Goal

A bot's row matches reality, and bots come back after a Traderton restart. The agent→bot
cascade stop and orphan sweep are in E1 (they need agent run state). Telling the owning
agent / user about status changes is in E3.

## Findings this plan acts on (verified by code reading)

- **F1. `MANAGE_BOT:stop` does not mark the row stopped.** `composition/drive-target.ts`
  `stopBot` (~L532) only enqueues the stop job. Its own comment says herobids "marks
  stopped + enqueues". Once a real loader exists (step 2), a bot stopped through this path
  would be **resurrected** by the next reclaim sweep. Fix before enabling the loader.
- **F2.** The shipped process is `packages/boundary/dist/bin.js` (Dockerfile). Its loader
  is `async () => []`. A correct loader already exists in the M1 entry
  `packages/worker/src/bin/worker.ts`, which nothing ships.
- **F3.** `boundary/src/bin.ts` has no SIGTERM/SIGINT handler, so `runtime.shutdown()`
  never runs on deploy. Actors die mid-cycle and leases expire after 30s.
- **F4.** Source graceful shutdown marked every bot `stopped` (`shutdown → stopInstance →
  onStopped → markBotStopped`). The human ruling replaces that with resume.

## Steps

### 1. Mark explicit stops in the drive target (F1)
- `drive-target.ts` `stopBot`: `await deps.botRepo.markBotStopped(botId)` before
  `enqueueLifecycle('stop', …)`, matching the herobids broker (the comment's reference).
  Roll back to the previous status if the enqueue throws, mirroring `stop_bot`'s
  restore-on-failure.
- Test (`drive-target.test.ts`): "marks a bot stopped before enqueuing its stop job";
  "restores the previous status when the stop enqueue fails".

### 2. One shared running-bot loader (F2)
- New `packages/worker/src/composition/running-bot-loader.ts`:
  `createRunningBotLoader(db): InstanceLoader`, moved from `bin/worker.ts`
  (`bots WHERE status='running'` → `{ id, config: { ...row.config, venueAccountId,
  ownerId, creatorType, creatorId } }`). `creatorType` and `creatorId` are additive; E3 uses
  them for routing.
- `bin/worker.ts` uses it; export from `@traderton/worker`.
- `boundary/src/bin.ts`: replace `instanceLoader: async () => []` with
  `createRunningBotLoader(db)`. Update the comment that says no bots rehydrate.
- `drive-target.ts` `createAndStart` / `startBot` enqueue configs also stamp
  `creatorType`/`creatorId`, so start-path and reclaim-path configs match.
- Tests: `running-bot-loader.test.ts` covers "loads only running bots" and "attaches
  venueAccountId, ownerId and creator to each config". Boundary wiring test: "the
  boundary runtime is built with the running-bot loader".

### 3. Bot failure callbacks write status (create-trading-runtime.ts ~L745–770)
- `onStartFailed(botId, err)` → `botRepo.markBotCrashed(botId)` (log on failure, never
  throw). This stops the 15s reclaim loop from retrying a bot that fails to start.
- Bot `onCrashed(botId)` → `markBotCrashed` **before** `runtime.handleActorCrash` (source
  order). Otherwise the released lease lets the next sweep restart a crashing bot.
- New bot `onHalted(botId)` (currently not passed) → `markBotStopped`, registry delete,
  and the runtime cleanup that `handleActorCrash` does (drop from `runtime.actors`,
  release the lease). Confirm `TradingActor.stop()` is idempotent, since the actor
  already stopped itself, and add a test if it isn't covered.
- `onStopped`: **no DB write** (resume ruling). Explicit stops already mark `stopped`
  (`stop_bot`, step 1). Shutdown and restart must not. Document this at the callback.
- `onStarted`: stays a DB no-op (the drive target claims `running` first). Document why.
- The `bots` repo is already constructed in `createTradingRuntime`. If it isn't in scope at
  these sites, thread it.
- Tests (`create-trading-runtime.test.ts`):
  - "marks a bot crashed when its start fails"
  - "marks a bot crashed before releasing its lease on crash"
  - "marks a bot stopped and releases it when it halts on strategy errors"
  - "leaves a bot running in the database when the runtime shuts down"

### 4. Graceful shutdown in the boundary process (F3)
- `boundary/src/bin.ts`: SIGTERM/SIGINT → `app.close()`, `runtime.shutdown()` (stops
  actors, releases leases, leaves rows `running`), quit the Redis connections (main +
  bot-stop subscriber), exit 0. Mirror `bin/worker.ts`. Guard against double signals.
- Extract the handler into a small testable function (like
  `agent-direct-actor-ensure.ts`). Test: "shutdown closes the listener, stops the runtime
  and quits Redis once, even on repeated signals".

### 5. Restart round-trip proof
- Integration test (real Postgres + Redis, appended to
  `scripts/shell/tests/run-integration.sh`): create + start a paper bot → `shutdown()` →
  row still `running` → new runtime with the loader → bot actor running again. Second
  case: halted bot → row `stopped` → not reclaimed.

## Verification
`pnpm build && pnpm lint && pnpm test`; type-check the new test files at package level
(root lint excludes `*.test.ts`); `scripts/shell/tests/run-integration.sh`.

## Docs on completion
001 C2-table bot rows: onStartFailed / onCrashed / onHalted (status part) / instanceLoader
→ **Met**; graceful-shutdown resume → **Improved** (004 ruling); F1 recorded and fixed.
Notify parts stay open until E3. 011 E2: the status and restart parts are done; the
cascade/sweep part is tracked in E1.

## Risks
- Resuming bots on deploy means a bad release restarts every running bot into it. That is
  accepted by the ruling; operators can stop bots before a risky deploy.
- The halt path cleans up the runtime outside `stopInstance`. Keep it to the same steps
  `handleActorCrash` takes, to avoid a lease leak.

## Outstanding Issues (non-blocking, from code review)

### [Step 1] drive-target `stopBot` explicit-stop marking
- LOW: `restoreBotRuntimeState` takes `status: string` (not a bot-status union), so a
  future caller typo wouldn't be caught at compile time. Pre-existing repo signature
  shared with `startBot`/`stop_bot`; optional tightening in a separate change
  (`packages/db/src/repositories.ts`).
- LOW: log field ordering differs cosmetically from the `stop_bot` sibling
  (`{ botId, err }` vs `{ err, botId }`). No action needed.

### [Step 2] shared running-bot loader + boundary wiring + creator stamping
- LOW: `running-bot-loader.test.ts` fakes `select().from().where()` and ignores the
  predicate, so the unit test does not semantically prove the `status='running'` filter;
  the Step 5 integration round-trip is the real guard. Acceptable.
- LOW: minor redundancy between `whereCalls` counter and the `select` spy in the loader
  test. Harmless.

### [Step 3] bot failure callbacks write status
- LOW: the shutdown test uses an empty instance loader, so it is a wiring assertion
  (callbacks don't write terminal status) rather than a live-bot round-trip. The live
  round-trip is Step 5's integration proof. Acceptable.
- LOW: onCrashed/onHalted duplicate the `actorRegistry.delete` + `handleActorCrash`
  sequence. Only two call sites; abstraction would be premature.

### [Step 4] graceful shutdown in the boundary process
- MEDIUM: no per-step timeout — a stuck `app.close()`/`runtime.shutdown()` can consume the
  whole SIGTERM→SIGKILL grace window (the M1 worker entry has the same gap). Out of scope
  for Step 4 (plan specifies only the sequence + double-signal guard); relying on the
  orchestrator SIGKILL is acceptable here. Candidate follow-up: `Promise.race` timeout per
  step, then still `exit(0)`.
- LOW: shutdown docstring lumps the two Redis quits; the test is stricter than the comment.
- LOW: an optional final summary log would help operators distinguish a clean vs degraded
  teardown.
