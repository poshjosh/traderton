# Bug Report: Agent orphan sweep stops user-created bots about a minute after they start

- **Status:** FIXED (2026-10-05). The narrow fix is applied; the model fix is deferred (see "Deferred").
- **Severity:** Medium. Any bot created by a user through herobids was stopped by the first sweep tick. It surfaced as the `bot-trade-test` failure in the herobids Tier-5 suite. The product is agent-first, so user-created bots have little live use today.
- **Date:** 2026-10-05
- **Component:** `packages/db/src/repositories.ts` (`BotRepository.listRunningAgentBots`), used only by `packages/boundary/src/agent-orphan-sweep.ts`
- **Introduced by:** `d225312` (2026-10-04 21:12, Wave E / E1-T T5, the agent-actor orphan sweep)

## Symptom

herobids `scripts/shell/tests/bot-trade-test.sh` (Tier 5) started failing on 2026-10-04 (`wave-e` run onwards; it passed in `phase4`, 17:40 the same day):

```
Waiting for trading activity...
⚠ No trading activity detected within timeout ...
Stopping bot...
✗ FATAL: Stop failed: 200 {"status":"already_stopped","botId":"..."}
```

The bot had stopped on its own while the test waited. herobids `POST /bots/:id/stop` returns `200 already_stopped` for a bot already in a terminal state (`apps/api/src/routes/bots.ts` L648), and the test expects `202`.

## Root Cause

1. **The drive target stamps every bot as agent-created.** `packages/worker/src/composition/drive-target.ts` (~L373–388) persists `creatorType: 'agent', creatorId: deps.actorId` for every bot. For the herobids user path, `deps.actorId` is the user's id, so the row has `creator_id = owner_id`. This is deliberate: the agent-scoped start/stop/adjust guards (`requireOwnedBot`) only accept bots with this stamp.
2. **The orphan sweep treats every such bot as an agent bot.** Pass 1 of `runAgentOrphanSweep` stops every running bot returned by `listRunningAgentBots` (`creator_type='agent' AND status='running'`) whose `creator_id` has no running row in `agent_actor_runs`. A user never has one, so the sweep stops the user's bot on its first tick (`agentScanner.orphanSweepIntervalMs`, 60s by default).

## Confirmation (2026-10-05, local cross-stack)

Stack: `herobids/scripts/shell/run/with-boundary.sh --keep-up` (VENUE=1inch, EXECUTION_MODE=shadow).

- **The baseline reproduced the CI failure.** The actor started at 07:49:53. The boundary then logged `orphan sweep: stopped bot of non-running agent` for the test's bot at 07:50:03, with `creatorId` equal to its `ownerId`.
- **Not a halt or crash.** The journal for that bot was empty: no `strategy.fatal`, no `instance.crashed`.
- **The row matched the stamp.** `bots` showed `creator_type='agent'` and `creator_id = owner_id`.

## Fix (applied)

`listRunningAgentBots` now also requires `creator_id <> owner_id`. A user-path bot is stamped with the user's own id as creator, and no agent can be one of these.

- **Blast radius:** only the orphan sweep (and one integration test) calls this method.
- **Agent bots are unaffected.** They are stamped with the agent's id, which never equals the owner's user id, so they are still swept.
- **Safe failure mode.** If the condition were ever wrong, the effect would be that a bot is not swept. That is how user bots behaved before `d225312`.
- **No other changes:** the creator stamp, the guards and the schema are untouched.

## Verification

- `pnpm lint` and `pnpm build` are clean.
- New `packages/db/src/running-agent-bots.integration.test.ts` (3 tests): a running agent bot is listed; a user-path bot (`creator_id = owner_id`) is not; a stopped bot is not. It is added to `scripts/shell/tests/run-integration.sh`. The full integration tier passes (11 files, 51 tests). Without the new condition, the user-path test fails.
- **End to end:** after rebuilding the boundary, herobids `bot-trade-test.sh` passes (`ALL CHECKS PASSED`). The bot ran through two sweep ticks without being stopped, and was then stopped and deleted by the test.

Related herobids test changes made while investigating (`scripts/ts/bot-trade-test.ts`):

- The bot is now created with complete mechanical strategy params (`stopLossPct`, `takeProfitPct`, `positionSize`). Bot creation does not check them against `MechanicalParamsSchema`, and a missing required field would halt the bot with `strategy.config_invalid` once the strategy is evaluated.
- The test now fails fast, printing the bot's status and recent journal events, if the bot reaches `stopped`/`crashed` before the test stops it.

## Deferred

- **Model fix:** stamp user-created bots `creatorType: 'user'`, and teach the start/stop/adjust guards to accept owner-scoped user bots. Deferred because the product is agent-first, and because it touches the write guards the user lifecycle currently depends on. Revisit when users can own bots directly.
- **Create-time validation of strategy params:** bot creation accepts params the selected strategy will reject on its first evaluated tick. Not required for this bug; track separately if user or agent bot creation needs a 400 instead of a silent halt.

## References

- `packages/db/src/repositories.ts` — `listRunningAgentBots`
- `packages/boundary/src/agent-orphan-sweep.ts` — pass 1
- `packages/boundary/src/bin.ts` ~L218 — sweep wiring
- `packages/worker/src/composition/drive-target.ts` ~L373–388 — creator stamp and its rationale
- herobids `scripts/ts/bot-trade-test.ts`, `apps/api/src/routes/bots.ts` L648
