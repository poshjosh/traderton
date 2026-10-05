# Bug Report: Agent orphan sweep stops every agent-created bot within one sweep interval

- **Status:** FIXED (2026-10-05). The sweep now needs positive evidence; the herobids side of the design (E1-H) is still gated (see "Remaining gaps").
- **Severity:** High. In the agent-first product, every bot an agent created was silently stopped within ~60s (`agentScanner.orphanSweepIntervalMs`), while the agent kept running.
- **Date:** 2026-10-05
- **Component:** `packages/boundary/src/agent-orphan-sweep.ts` (pass 1), `packages/db/src/repositories.ts` (the pass-1 listing)
- **Introduced by:** `d225312` (2026-10-04, Wave E / E1-T T5)
- **Related:** [003](./003-orphan-sweep-stops-user-created-bots.md), the same sweep stopping user-created bots

## Symptom

herobids `agent-trade-test.sh`: the agent creates a bot through `manage_bot`, and about 4s later (the next sweep tick) the boundary logs:

```
[08:53:33] INFO (actor-91ba778a…): Actor started
[08:53:37] INFO (boundary-agent-orphan-sweep): orphan sweep: stopped bot of non-running agent
    creatorId: "bd0311e3…"   ← the real, running agent
```

`agent_actor_runs` was empty.

## Root Cause

- **Pass 1 treated "no run row" as "agent dead".** It stopped every running agent bot whose creator was not in the set of `desired_state='running'` rows in `agent_actor_runs`.
- **Nothing writes that table in practice.** Only the consumer-only `start_agent_actor` / `stop_agent_actor` tools write it. The plan (`docs/features/2026/10/04/001-wave-e-actor-events-and-lifecycle/003-e1-agent-scan-loop-plan.md`, E1-H H2) has herobids' session manager call them, but E1-H is gated and was never implemented. So for every agent the set was empty, and every agent bot looked orphaned.
- **This also diverged from the source.** The removed herobids `listRunningBotsForInactiveAgents` (herobids `45271d28^`, `packages/db/src/repositories.ts` L875–887) inner-joined `agents` and matched only `status IN ('stopped','crashed')`. A bot with no matching agent row was never touched. The Traderton port turned "known stopped" into "not known running".

## Fix (applied)

Pass 1 acts only on positive evidence, matching the source's semantics.

- **New listing:** `BotRepository.listRunningBotsOfStoppedAgents()` replaces `listRunningAgentBots()`. It inner-joins `agent_actor_runs` on (`actor_id = bots.creator_id`, `owner_id = bots.owner_id`) and returns only running agent bots whose creator's run row is `desired_state='stopped'`. It keeps the user-bot exclusion from 003 (`creator_id <> owner_id`).
- **Simpler pass 1:** `runAgentOrphanSweep` pass 1 now stops exactly what the listing returns, with no in-memory set difference. Pass 2 (re-ensure dead `running` agents) is unchanged.
- **No other changes:** no schema change, no change to `stop_agent_actor` (its own cascade is unaffected), no herobids change.

Why it's safe:
- **Stopping a bot is destructive, so absence of data never triggers it.** For agents without a run row (all of them today), bots behave as before `d225312`.
- **The designed behaviour still works.** When E1-H lands and herobids calls `stop_agent_actor`, that tool cascade-stops the bots immediately, and the sweep remains a backstop for any it missed.

## Verification

- `pnpm lint` and `pnpm build` are clean; worker/boundary/db unit suites pass (1614 tests). The sweep unit tests are updated, including a regression test: an empty run table stops no bots.
- `packages/db/src/running-agent-bots.integration.test.ts` now has 6 cases: stopped creator → listed; no run row, running creator, non-running bot, user-created bot, or a stopped row under a different owner → not listed. The full integration tier passes (11 files, 54 tests), including the multi-replica CASE 2 takeover.
- **End to end:** I rebuilt the boundary and ran herobids `agent-trade-test.sh`. The agent's bot was created 3s after `manage_bot` and ran for the whole 10-minute watch with no sweep stop.

## Remaining gaps (not fixed here)

1. **No agent→bot cascade on stop or crash.** herobids `POST /agents/:id/stop`, crash and session end don't stop the agent's bots; L3d-5 removed those hooks. E1-H H2 restores them by calling `start_agent_actor` / `stop_agent_actor`. herobids is gated behind a human go. Wire start and stop together: a `stopped` row that is never flipped back by `start_agent_actor` would make the sweep stop bots the agent creates after a restart.
2. **herobids agent delete can't stop a running agent bot.** `DELETE /agents/:id` calls `stop_bot` as the **user** subject, but `stop_bot` requires `creatorId === ctx.agentId`. The call fails with `validation.invalid_payload` and the delete returns 503. Seen in `agent-trade-test` teardown. Pre-existing; needs either an owner-scoped stop path or `stop_agent_actor` (E1-H).
3. **Stale teardown in `agent-trade-test.ts`.** It still runs `DELETE FROM bots` against the herobids database, where that table no longer exists.
4. **`agent-trade-test` still fails at "no trade observed within 600s".** With the bot no longer killed, the remaining failure is the documented LLM dependency: most ticks were `context_unchanged` skips. It isn't a code defect found here.

## References

- `packages/boundary/src/agent-orphan-sweep.ts`, `packages/boundary/src/bin.ts` (sweep wiring)
- `packages/db/src/repositories.ts` — `listRunningBotsOfStoppedAgents`
- `packages/boundary/src/agent-actor-lifecycle-ops.ts` — `stopAgent` / `cascadeStopBots`
- `packages/worker/src/tools/agent-lifecycle.ts` — consumer-only ruling
- herobids `apps/api/src/routes/agents.ts` (`DELETE /agents/:id`, `POST /agents/:id/stop`), `apps/worker/src/index.ts` (L3d-5 notes)
