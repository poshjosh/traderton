# 021 — Item D Implementer Prompt (in-process drive target + drive-path tools)

**Status:** ready to hand to an implementer.
**Task:** implement Phase 9b **item D** — the in-process drive path (authored `AGENT_MESSAGE_TYPES` 3-const
subset + `publishToInbound` drive target + bot-lifecycle handler + `WorkerRuntime.enqueueLifecycle` seam)
and the **7 drive-path tools** (`tools/bots.ts` + `tools/trading.ts`, copied verbatim).
**Authoritative brief:** [013 §6](./013-9b-authoring-plan.md) (the LOCKED decisions + manifest) and
[020](./020-item-d-drive-and-tools-proposal.md) (design record + herobids investigation). Read both. This
prompt is the actionable checklist; **013 §6 wins on any conflict.**

---

## 0. Orient first (do not skip)

You are in **Traderton** (`/Users/chinomso.ikwuagwu/dev_ai/traderton`), a trading library extracted from
**herobids** (`/Users/chinomso.ikwuagwu/dev_ai/herobids`, READ-ONLY source) by copy-and-delete. Read the
project memory in [AGENTS.md](../../AGENTS.md) (000/001/004 at minimum), then [013 §1 + §6](./013-9b-authoring-plan.md)
and [020](./020-item-d-drive-and-tools-proposal.md). Assume you have **no chat context**.

**The governing law (000/AGENTS.md), which item D leans on heavily:**
- **Copy, never author** — every line of trading behaviour arrives by being copied. You author only the
  **thin seam** where a platform coupling is cut (here: the cross-process message-broker transport becomes
  an in-process call), plus deletions.
- **Minimum authoring** — do not author anything a copy can produce. The two tool files are COPIES. Only
  the drive target + handler + the 3 consts + the enqueue method are authored.
- **Author the seam, wire the copy** — where you must author (because deleting the platform broker would be
  counter-productive), the authored code **mirrors what would have been copied** and **traces to the
  herobids reference line-by-line**, so authored behaviour is verified against the real system, not your
  assumptions. herobids is the behavioural oracle.
- **Ports-carry-values** — the drive path carries a decision/command **value** to Traderton-owned surfaces
  (item C's `submitDecision`, the bot lifecycle). It must inject no planning/risk/execution behaviour.

## 1. The context that reshaped this item (read once, then act)

013 §6 originally said "author a small drive target, then copy the tool files." The investigation
([020 §2](./020-item-d-drive-and-tools-proposal.md)) found:
- **The tool files copy cleanly** — confirmed. Their only Traderton-absent dep is `AGENT_MESSAGE_TYPES`.
- **But `handleManageBot` is NOT copyable.** herobids `agent-message-broker.ts`'s `handleManageBot`
  (`:552–…`) is the agent-session + connection-grant + LLM-model-policy layer — the platform surface
  already cut consumer-side (decisions 11–13 / 7–9). So the authored bot-lifecycle handler is **thin wiring
  that traces `handleManageBot`'s trading core over the already-copied `WorkerRuntime`**, dropping the
  platform shell. Do NOT copy `handleManageBot`; do NOT copy the platform broker.

## 2. The LOCKED decisions (013 §6.1 — do not re-litigate)

- **(a) COPY `tools/bots.ts` + `tools/trading.ts` verbatim (modulo namespace).** Keep
  `ctx.agentId`/`creatorType='agent'` as the M1 ownership scope — do **not** edit the tools to re-key
  ownership to `ownerId`. The injected `ownerId` is bound at the persistence/creation seam (where item B/C
  already bind it), not in the tool bodies. **Fallback (b)** (copy-and-adapt to an `ownerId`-scoped lookup
  → logged Intentional Divergence) is a **stop-gate path** only if the copied
  `getBotsByCreator('agent', ctx.agentId)` scope proves insufficient at M1 — surface it, don't
  pre-emptively diverge.
- **(D-i) Author a 3-constant `AGENT_MESSAGE_TYPES`** (`DECISION_SUBMIT`, `MANAGE_BOT`, `BOT_QUERY`) with
  the string values **copied verbatim** from herobids. No source-fix.
- **(i) Add `WorkerRuntime.enqueueLifecycle(command, botId, config?)`** — one public entry over the queue
  the runtime already owns; the handler does not touch BullMQ directly.
- **E stays separate** — author the bot-lifecycle handler with the maxBots **call-site seam** present (a
  `botLimitCheck`-shaped hook / injected optional function); item E fills it. Do NOT author the limit
  enforcement here.
- **Omit `BOT_QUERY` routing** — neither copied tool emits it; author no `BOT_QUERY` route. The constant
  exists only for vocabulary fidelity.

## 3. Scope — what you are building (and NOT building)

**Building (authored):**
1. a 3-constant `AGENT_MESSAGE_TYPES` (values verbatim from herobids `agent-protocol.ts`).
2. an in-process `publishToInbound(type, payload)` drive target (§4).
3. the bot-lifecycle handler `handleManageBot(payload)` (§5).
4. `WorkerRuntime.enqueueLifecycle(command, botId, config?)` (§6).
5. an authored, labelled drive-target/handler test (§8).

**Copying verbatim:** `tools/trading.ts` (`submit_decision`) + `tools/bots.ts` (6 bot tools), then wiring
them into the tool registry/barrel (§7).

**NOT building** (route elsewhere — §9): the per-`ownerId` maxBots enforcement (item E — leave the seam);
`InstanceEventPublisher` status emits (item C2 — M1 no-op); the connection-grant / `agents` table / LLM
model-policy shell (consumer-owned — dropped); the M2 REST invocation of these tools (item F).

## 4. The `publishToInbound` drive target

herobids `publishToInbound` (`agent.ts:1229`) `xadd`s an envelope to a Redis stream that a **separate
process** (`agent-message-broker.processInbound`, `:140`) consumes and routes by `envelope.type`
(`:277` `DECISION_SUBMIT` → `decisionHandler.handleDecisionSubmit`; `:321` `MANAGE_BOT` →
`handleManageBot`). Traderton M1 is in-process, so author a function that dispatches synchronously by
`type` — this is the authored seam (transport cut), not authored trading behaviour:

- `AGENT_MESSAGE_TYPES.DECISION_SUBMIT` → adapt the tool payload to item C's `DecisionSubmitInput` → call
  the item-C `submitDecision(...)` (exposed on the runtime) → JSON-write the typed result to
  `agent:decision:reply:${decisionId}` via `redis` (an `lpush` + short expiry, or the exact push
  `trading.ts`'s `blpop(replyKey, 30)` awaits). The reply JSON shape must match what `trading.ts` parses:
  `{ status: 'accepted'|'rejected'|'error'|'pending_approval', code?, message?, planId?, ... }`. Item C
  returns `accepted|rejected|error`; `pending_approval` never occurs (approvals dropped) but keep the tool
  branch intact. Trace: broker `:277–283` + the item-C result type.
- `AGENT_MESSAGE_TYPES.MANAGE_BOT` → `handleManageBot(payload)` (§5).
- No `BOT_QUERY` route (decision).

The target is wired into the `TradingToolContext.publishToInbound` port the copied tools call. Decide at
impl whether the drive target lives on the `TradingRuntime` (alongside `submitDecision`) or a small
`composition/drive-target.ts` — whichever composes cleanly with item B/C; 013 §6 wins on conflict.

## 5. The bot-lifecycle handler (trace `handleManageBot`'s trading core; drop the shell)

Trace source: herobids `agent-message-broker.ts` `handleManageBot` (`:552`, through `create_and_start` /
`start` / `stop` / `adjust_config`). **Keep the trading core; DROP the platform shell.**

For each action:
- **`create_and_start`:** `BotConfigSchema.safeParse(rawConfig)` (copied) → `checkModeEscalation(botMode,
  ownerMode, 'create')` (copied) → **maxBots limit seam** (item E — call an injected optional
  `botLimitCheck?(ownerId)` and proceed if absent) → persist the bot via `botRepo` (stamp the injected
  `venue`/`venueType`/`venueAccountId`/`ownerId`) → **`enqueueLifecycle('start', botId, config)`**.
- **`start`:** resolve the bot via `botRepo.getBotById`; validate ownership by the injected `ownerId`
  (NOT `agent.userId`, NOT the `agents` table); `BotConfigSchema.safeParse` preflight (copied) →
  maxBots seam (non-reclaim only) → `enqueueLifecycle('start', botId, config)`.
- **`stop`:** ownership check → `enqueueLifecycle('stop', botId)`.
- **`restart`:** stop then start (or the copied restart semantics if `WorkerRuntime` exposes one).
- **`adjust_config`:** deep-merge (the copied merge shape) + `botRepo.updateBotConfig`.

**DROP (all platform / consumer-owned — do NOT author):** `agentRepo.getAgent`/`getActiveSession`; the
connection-grant descriptor resolution (`getRuntimeCapabilityDescriptor`,
`grantedConnectionsByFamily['trading']`, `getResolvedVenueAccount`, `isConnectionOwnedBy`); the
LLM-provider/model-policy stamping (`resolveEffectiveLlmSelection`, `getUserAiModelConfig` — mechanical-only,
no llm/hybrid bots); `applyAgentCapitalLimit`; the `emitInstanceStatus` managed-bot-list notifications
(→ item C2, M1 no-op). venue/venueType/venueAccountId are **injected**, not grant-resolved.

The handler drives the **copied** `WorkerRuntime` lifecycle (via `enqueueLifecycle`); it re-implements no
start/stop/reclaim mechanics.

## 6. `WorkerRuntime.enqueueLifecycle`

Add one thin public method to `packages/worker/src/runtime.ts` that enqueues a `LifecycleJob`
(`{command, botId, config?}`) onto the queue the runtime already owns (`QUEUE_NAME`,
`trading-instance-lifecycle`) — the same enqueue the runtime does internally. Expose it on `TradingRuntime`
(item B's return) so the drive target/handler can call it. This is wiring of the copied runtime, not new
lifecycle behaviour — do not duplicate BullMQ setup.

## 7. Copy the two tool files + wire them

- Copy `tools/trading.ts` → `packages/worker/src/tools/trading.ts` verbatim (modulo `@herobids/*` →
  `@traderton/*`). Its imports: `AGENT_MESSAGE_TYPES` (your 3-const module), `convertZodToJsonSchema`
  (`./registry.js`), `AgentTool`/`ToolResult`/`ToolContext` (present). Keep the `pending_approval` branch
  byte-faithful though unreachable — do NOT delete it (that would edit the copy).
- Copy `tools/bots.ts` → `packages/worker/src/tools/bots.ts` verbatim. Its imports: `AGENT_MESSAGE_TYPES`,
  `checkModeEscalation`/`deriveStrategyPreset`/`extractStrategyFromConfig` (`@traderton/domain`),
  `convertZodToJsonSchema`. It binds to `ctx.botRepo`/`ctx.agentId`/`ctx.executionMode`/`ctx.redis` — all
  present on `TradingToolContext`/`ToolContext`. **Do not edit the ownership scoping** (decision a).
- Wire both into the tool registry/barrel (`tools/index.ts`) so the 7 tools are exported/registered.
- If herobids has `tools/bots.test.ts` / `tools/trading.test.ts` and they are trading-clean, **copy them
  too** — they are the parity oracle for the copied files. Confirm they don't drag in platform-only deps;
  if they do, note it and cover the copied behaviour with the smallest faithful copied subset.

## 8. Verification (copied tools have an oracle; the seam is authored)

- `pnpm build` green, `pnpm lint` clean.
- **Existing suite stays green** (baseline 2253 passed / 15 skipped / 0 failed). No copied module altered.
- **Copied tool tests** (if brought across) pass — the parity oracle for `bots.ts`/`trading.ts`.
- **Authored drive-target/handler test** (labelled AUTHORED, deterministic — no real network/DB; stub the
  runtime + item-C `submitDecision` + a fake redis):
  - `MANAGE_BOT:create_and_start` → validates config + calls `enqueueLifecycle('start', …)`.
  - `MANAGE_BOT:start`/`stop` → ownership check + `enqueueLifecycle`.
  - a foreign-`creatorId`/`ownerId` bot → ownership rejection.
  - `DECISION_SUBMIT` → routes to the stub `submitDecision` + writes the `agent:decision:reply:${id}` key
    with the correct JSON shape; `trading.ts` (or a direct `blpop` stub) reads it back.
- **Trace** the handler to herobids `handleManageBot` trading core + `processInbound` routing so it's
  reviewable against the reference, diverging only where 013 §6 says (drop the agent/grant/LLM shell,
  injected venue/venueAccountId/ownerId, maxBots seam, no-op events).

## 9. Exclusions — do NOT author these here (route to the owning item)

| Excluded | Goes to | Note |
|----------|---------|------|
| per-`ownerId` maxBots atomic enforcement | item E | leave the `botLimitCheck` seam |
| `InstanceEventPublisher` status emits (`emitInstanceStatus` bot-list) | item C2 | M1 no-op |
| connection-grant resolution / `agents` table / LLM model policy | consumer-owned | dropped (decisions 7–13) |
| M2 REST invocation of these tools | item F | D is the in-process path |
| advertised `create_bot.config.strategy` tool-schema narrowing | item D follow-up / (A′ note) | only if it falls out cleanly; otherwise leave for the schema reconciliation — do not author broad new schema |

## 10. Guardrails / stop-gates (surface, do not push past)

- **A copied tool body references more of `AGENT_MESSAGE_TYPES` than the 3 consts** → stop-gate (revisit
  source-fix #4). Confirmed today they use only `DECISION_SUBMIT` + `MANAGE_BOT`.
- **The copied `getBotsByCreator('agent', ctx.agentId)` scope can't isolate one owner's bots at M1** →
  stop-gate → fallback (b) with a logged Intentional Divergence (do not silently re-key).
- **Any temptation to copy `handleManageBot` or the platform broker** → STOP; that is the dropped
  agent/grant/LLM shell. Author only the trading core.
- **Any temptation to read the `agents` table / `AgentRepository`, or resolve a connection grant** → STOP;
  that is consumer-owned (decisions 11–13). venue/venueAccountId/ownerId are injected values.
- **Any authored code that is trading behaviour, not transport/routing wiring** → STOP; the seam is
  mis-drawn (ports-carry-values).
- Do NOT edit any copied module (tools or `WorkerRuntime` internals beyond adding the thin
  `enqueueLifecycle`) to make wiring fit — if it doesn't compose, surface it.

## 11. Done criteria + docs

- Build/lint/tests green; the 7 drive-path tools registered + exported; `WorkerRuntime.enqueueLifecycle`
  exposed on `TradingRuntime`.
- Update [001](../../docs/001-parity-ledger.md): the 7 drive-path tool rows → Met (note maxBots enforcement is
  item E; status events are item C2); un-quarantine `_deferred-config/validate-trade-instrument.test.ts`
  (and note `schema.test.ts` pending S-2/S-3). Update [013 §6](./013-9b-authoring-plan.md) item D → DONE
  with the authored-vs-copied-vs-dropped manifest of what you actually wrote, and record any Outstanding
  Issues (non-CRITICAL/HIGH) from CodeReviewer + any seam surfaced.
- Commit as its own logical commit ("9b item D: in-process drive target + drive-path tools").
- **Then PAUSE** — item E (per-`ownerId` maxBots) is next and is gated on human review of D.

## 12. Key file map (start here)

Traderton (reuse — do not alter, except the thin `enqueueLifecycle` add):
- `packages/worker/src/runtime.ts` — `WorkerRuntime`, `LifecycleJob {command,botId,config}`, `QUEUE_NAME`;
  add `enqueueLifecycle` here.
- `packages/worker/src/composition/create-trading-runtime.ts` — item B's factory; `TradingRuntime` return
  (already exposes `submitDecision`, `constructAndRegisterAgentActor`); expose the drive target +
  `enqueueLifecycle` here.
- `packages/worker/src/composition/decision-intake.ts` — item C `submitDecision` + `DecisionSubmitInput`
  (the `DECISION_SUBMIT` route adapts to this).
- `packages/worker/src/tools/registry.ts` — `convertZodToJsonSchema`, `ToolRegistry`.
- `packages/worker/src/tools/index.ts` — the tool barrel (wire `bots.ts`/`trading.ts` in).
- `@traderton/domain` — `checkModeEscalation` (`trading/mode-rank.ts`), `deriveStrategyPreset` /
  `extractStrategyFromConfig` (`config/schema.ts`), `TradingToolContext`/`AgentTool`/`ToolResult`,
  `BotConfigSchema`.

herobids (READ-ONLY reference — trace, never import):
- `apps/worker/src/tools/trading.ts`, `apps/worker/src/tools/bots.ts` — the two files to copy.
- `apps/worker/src/agent.ts:1229` — `publishToInbound` (the Redis-stream hop being made in-process).
- `apps/worker/src/agents/agent-message-broker.ts` — `processInbound` (`:140`, routing `:277`/`:321`) +
  `handleManageBot` (`:552–…`, the trading core to trace; the shell to drop).
- `packages/domain/src/**` — `AGENT_MESSAGE_TYPES` (copy the 3 string values `DECISION_SUBMIT`,
  `MANAGE_BOT`, `BOT_QUERY` verbatim).
