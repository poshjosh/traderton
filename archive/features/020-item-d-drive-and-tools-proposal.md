# 020 — In-process drive target + drive-path tools (item D) — Proposal

**Status:** APPROVED (2026-09-07, human) — the §4 crux is RESOLVED as **option (a)**; the four smaller
decisions (§8.2–§8.5) are locked. Decisions locked into [013 §6](./013-9b-authoring-plan.md). This doc is
now the design record.
**Phase:** 9b item D (the in-process drive path + the drive-path tools). Follows item C (DONE).
**Feeds:** [013-9b-authoring-plan.md](./013-9b-authoring-plan.md) §6 (item D). The self-contained
implementer brief lives in 013 §6; the implementer prompt is [021](./021-item-d-implementer-prompt.md).

> **Decisions locked (2026-09-07):**
> - **§4 = (a)** — COPY `tools/bots.ts` + `tools/trading.ts` verbatim; keep `ctx.agentId`/
>   `creatorType='agent'` as the M1 ownership scope; bind the injected `ownerId` at the persistence/creation
>   seam (where B/C already bind it), NOT by editing the copied tools. **Fallback (b)** (copy-and-adapt to an
>   `ownerId`-scoped lookup, logged Intentional Divergence) is a **stop-gate path** only if the copied
>   `getBotsByCreator('agent', ctx.agentId)` scope proves insufficient to isolate one owner's bots at M1 —
>   surface it, don't pre-emptively diverge.
> - **§8.2 = D-i** — author a 3-constant Traderton `AGENT_MESSAGE_TYPES` (`DECISION_SUBMIT`, `MANAGE_BOT`,
>   `BOT_QUERY`), string values copied verbatim from herobids. No source-fix #4.
> - **§8.3 = (i)** — add a thin `WorkerRuntime.enqueueLifecycle(command, botId, config?)` public entry over
>   the queue the runtime already owns; the handler does not touch BullMQ directly.
> - **§8.4 = E separate** — D authors the bot-lifecycle handler with the limit **call-site seam** present
>   (a `botLimitCheck`-shaped hook); item E fills it with per-`ownerId` atomic enforcement. E stays a
>   separately-reviewed item.
> - **§8.5 = omit `BOT_QUERY` routing** — neither copied tool emits it; the constant exists in the enum for
>   vocabulary fidelity, but the drive target authors no `BOT_QUERY` route (no dead stub).
**Grounding:** read-only investigation of the herobids drive path (2026-09-07):
`tools/bots.ts`, `tools/trading.ts`, `agent.ts` `publishToInbound` (:1229), and the
`agent-message-broker.ts` `processInbound`/`handleManageBot` routing. Governed by
[000](../../docs/000-vision.md) (ports-carry-values; minimum-authoring; author-the-seam-wire-the-copy;
herobids-as-oracle), [004](../../docs/004-decision-log.md) (decisions 7–13; mechanical-only; no approvals),
[013 §6](./013-9b-authoring-plan.md).

> **The investigation reshaped item D from what 013 §6 assumed** — the same way the item-C investigation
> did. 013 §6 said: "author a small in-process `publishToInbound` target + a bot-lifecycle handler, then
> COPY `tools/bots.ts` + `tools/trading.ts` verbatim." Reading the code, the two **tool files copy cleanly**
> (confirmed), but the **consuming side is NOT copyable**: herobids' `handleManageBot` is the agent-session
> + connection-grant + LLM-model-policy layer — the exact platform surface already cut consumer-side
> (decisions 11–13). So the authored bot-lifecycle handler is *smaller and different* than "copy
> handleManageBot": it is thin wiring that drives the already-copied `WorkerRuntime` lifecycle, tracing only
> `handleManageBot`'s trading core. This raises one shape question (§4). Nothing is implemented.

---

## 1. What item D is (from 013 §6 + decision log)

Wire the **drive path** — the in-process channel that carries a submitted decision or a bot-lifecycle
command from a tool call into the surfaces items B + C already built — and land the **7 drive-path tools**
that were quarantined at 9a because their only missing dependency was the message-broker drive path:
`submit_decision`, `create_bot`, `start_bot`, `stop_bot`, `list_bots`, `get_bot_status`,
`adjust_bot_config`.

## 2. Investigation findings (verified in herobids + Traderton)

### 2a. The tool files copy cleanly (confirmed)
`tools/trading.ts` (`submit_decision`) and `tools/bots.ts` (the 6 bot tools) need only:
- `AGENT_MESSAGE_TYPES` — **absent** (deleted with `agent-protocol.ts`, Phase 1). The tools use exactly
  **three** members: `DECISION_SUBMIT` (trading.ts:64), `MANAGE_BOT` (bots.ts:78, :257). `BOT_QUERY` is
  referenced by the broker router but **not** by either tool file.
- `convertZodToJsonSchema` — **present** (`tools/registry.ts`).
- `checkModeEscalation` — **present** (`@traderton/domain`, `trading/mode-rank.ts`).
- `deriveStrategyPreset`, `extractStrategyFromConfig` — **present** (`@traderton/domain`, `config/schema.ts`).
- `AgentTool`/`ToolResult`/`ToolContext` (`bots.ts`) / `TradingToolContext` — **present**; the
  `TradingToolContext` already carries `agentId`, `executionMode`, `redis` (incl. `blpop`), `botRepo`
  (with `getBotsByCreator`/`getBotById`/`markBotStopped`/…/`updateBotConfig`), and `publishToInbound`.
  `bots.ts` imports the wider `ToolContext` for `ctx.redis.publish` on `stop_bot`; that too is present.

So once `AGENT_MESSAGE_TYPES` (3 consts) + a `publishToInbound` target exist, **both files copy verbatim
modulo namespace.** (Note `submit_decision` still handles a `pending_approval` reply branch — dead in
Traderton since item C dropped approvals; kept verbatim as an unreachable branch, not authored away, so the
copy stays byte-faithful. See §5.)

### 2b. `publishToInbound` is a Redis-stream hop in herobids — in-process for Traderton M1
herobids `publishToInbound` (`agent.ts:1229`) `xadd`s an envelope to `INBOUND_STREAM`; a **separate
process** (the `agent-message-broker`) consumes it and routes by `envelope.type`. That cross-process hop
exists because herobids runs the agent container and the broker as separate services. Traderton M1 is an
**in-process library** (000/005), so the drive target is the in-process expression of that route: a
function that takes `(type, payload)` and dispatches synchronously to item C's handler / a bot-lifecycle
handler, plus servicing the `submit_decision` reply. This is the sanctioned "author the seam" move — the
seam is the transport (cross-process Redis stream → in-process call), NOT the trading behaviour.

### 2c. The broker's `DECISION_SUBMIT` route → item C (already done)
`processInbound` routes `DECISION_SUBMIT` → `decisionHandler.handleDecisionSubmit` (broker :277–283). We
**already authored** that handler in item C (`submitDecision`). So the drive target's `DECISION_SUBMIT`
arm is: adapt the tool payload → item C's `DecisionSubmitInput` → call `submitDecision` → write the reply
to `agent:decision:reply:${decisionId}` (what `trading.ts`'s `blpop` awaits). Small, authored wiring.

### 2d. `handleManageBot` is NOT copyable — it is the agent/grant/LLM layer (the reshape)
herobids `handleManageBot` (`agent-message-broker.ts:552–…`) is heavily platform-fused. For
`create_and_start` it: reads `agentRepo.getAgent` + `getActiveSession` (the `agents` table — absent by
design); resolves the **connection grant** (`getRuntimeCapabilityDescriptor`,
`grantedConnectionsByFamily['trading']`, `getResolvedVenueAccount`, `isConnectionOwnedBy`) — the exact
connection-grant front-end cut in decisions 11–13 + Phase 8; resolves **LLM provider/model policy** for
llm/hybrid bots (`resolveEffectiveLlmSelection`, `getUserAiModelConfig`) — not in Traderton
(mechanical-only, decisions 7–9); `applyAgentCapitalLimit`; and calls `tryCreateBotWithLimit` /
`tryMarkBotRunningWithLimit` (the **maxBots** limit = **item E**). The `start`/`stop`/`adjust_config` arms
are the same shape (agent-owned, `bot.userId !== agent.userId` ownership, `botStart`/`botStop` closures).

**What survives once the platform layers are stripped** (the trading core, the part item D authors):
`BotConfigSchema.safeParse` (copied), `checkModeEscalation` (copied), and calling **`botStart`/`botStop`**
— which in herobids are closures that **enqueue a `WorkerRuntime` lifecycle job** (the same
`WorkerRuntime` item B already constructed, whose `startInstance`/`stopInstance`/reclaim mechanics are all
copied). So the authored bot-lifecycle handler is: validate config → mode check → **enqueue a
`WorkerRuntime` lifecycle job** (+ item E's limit at the create/start seam). It is NOT a copy of
`handleManageBot`; it traces `handleManageBot`'s trading core and drops the agent/grant/LLM shell.

### 2e. What's already present vs absent (Traderton)
- **Present:** the 3 domain helpers + `convertZodToJsonSchema`; `TradingToolContext` (with `botRepo`,
  `publishToInbound`, `agentId`, `executionMode`, `redis.blpop`); the item-C `submitDecision` handler +
  `actorRegistry`; the item-B `createTradingRuntime` + `WorkerRuntime` (`startInstance`/`stopInstance`/
  lifecycle-job queue). `WorkerRuntime` already defines a `LifecycleJob {command,botId,config}` +
  `QUEUE_NAME`; its `start()` processes those jobs.
- **Absent:** `AGENT_MESSAGE_TYPES` (deleted Phase 1); an in-process `publishToInbound` target; a
  bot-lifecycle handler; a **public enqueue** entry on `WorkerRuntime`/`TradingRuntime` (today the queue is
  written internally + by rehydrate; item D needs a way to enqueue a start/stop from the drive target —
  either a thin authored `enqueueLifecycle` method on the runtime, or the drive target writes to the same
  BullMQ queue directly). Surface this as a small seam (§3.5).

## 3. Proposed shape (the clean Traderton drive path)

### 3.1 Author `AGENT_MESSAGE_TYPES` — 3 trading constants (013 §6 D-i, recommended)
A tiny Traderton-owned constant set with exactly the members the tools use:
`{ DECISION_SUBMIT, MANAGE_BOT, BOT_QUERY }`. Rationale (013 §6): herobids' enum is a coherent
single-channel agent+trading enum; carving a "subset" via a source-fix (#4) is a full herobids release
cycle for 3 strings. Authoring 3 constants is smaller and lower-risk. **Mirrors the copy** — the 3 string
values are copied verbatim from herobids so the wire vocabulary is identical. (Stop-gate, 013 §10: if the
copied tool bodies turn out to reference more than these 3 → revisit source-fix #4. Confirmed today they
reference only `DECISION_SUBMIT` + `MANAGE_BOT`.)

### 3.2 Author the in-process `publishToInbound` drive target
A function `publishToInbound(type, payload)` (the `TradingToolContext.publishToInbound` port) that
dispatches in-process by `type`:
- `DECISION_SUBMIT` → adapt payload → item C `submitDecision(input)` → JSON-write the typed result to
  `agent:decision:reply:${decisionId}` via `redis` (what `trading.ts`'s `blpop(replyKey, 30)` awaits).
  Traces the broker `DECISION_SUBMIT` route (:277) + the reply shape item C returns.
- `MANAGE_BOT` → the authored bot-lifecycle handler (§3.3).
- `BOT_QUERY` → not emitted by the copied tools; either omit or a no-op stub (decide at impl; likely omit).
The target is authored wiring; it carries a **value** (decision/command) to Traderton-owned surfaces and
injects no planning/risk/execution behaviour (ports-carry-values ✓).

### 3.3 Author the bot-lifecycle handler (traces `handleManageBot`'s trading core, drops the shell)
`handleManageBot(payload)` for `create_and_start` / `start` / `stop` / `restart`(=stop+start) /
`adjust_config`:
- `create_and_start`: `BotConfigSchema.safeParse` (copied) → `checkModeEscalation` (copied) → item-E
  limit check (per-`ownerId`, §3.6) → persist the bot (via `botRepo`) → enqueue a `WorkerRuntime` start
  job. **venue/venueType/venueAccountId are injected** (the connection-grant resolution + LLM-model-policy
  stamping are DROPPED — consumer-side, decisions 11–13 / 7–9).
- `start`/`stop`/`restart`: validate ownership by the injected **`ownerId`** (NOT `agent.userId`; NOT the
  `agents` table) → enqueue the corresponding `WorkerRuntime` lifecycle job.
- `adjust_config`: deep-merge (the copied `deepMergeConfig`/`mergeBotConfig` shape) + `updateBotConfig`;
  the LLM provider/model preservation branch is DROPPED (mechanical-only).
This is the "author the seam, wire the copy" move: the handler drives the **copied** `WorkerRuntime`
lifecycle; it re-implements no start/stop/reclaim mechanics.

### 3.4 COPY `tools/trading.ts` + `tools/bots.ts` verbatim (modulo namespace)
Once §3.1–§3.3 exist, both files copy byte-faithfully. Wire them into the tool registry/barrel.
Un-quarantines `_deferred-config/validate-trade-instrument.test.ts` (needs `tools/trading.ts`) and (after
S-2/S-3 schema reconciliation) `_deferred-authoring/schema.test.ts`.

### 3.5 Surface: the `WorkerRuntime` enqueue seam
The drive target needs to enqueue a lifecycle job. Options (decide at impl, small): (i) add a thin
authored `enqueueLifecycle(command, botId, config?)` method to `WorkerRuntime`/`TradingRuntime` that does
the `queue.add` the runtime already does internally; or (ii) the bot-lifecycle handler writes to the same
BullMQ queue directly. Prefer (i) — one public entry, no duplicated queue wiring. This is wiring of the
copied runtime, not new lifecycle behaviour.

### 3.6 Item E boundary (maxBots) — where D stops and E begins
The create/start limit check is a **seam D exposes** and **E fills** (per the roadmap E rides in the D
handler). Proposal: D authors the handler with the limit **call site** present (a `botLimitCheck`-shaped
seam); E authors the per-`ownerId` atomic enforcement behind it. If preferred, D and E land together (E is
small). Flag for your steer (§8).

## 4. CRUX — the ownership/identity key for the bot tools

**`tools/bots.ts` keys bot ownership on `ctx.agentId` + `creatorType === 'agent'`** (e.g.
`getBotsByCreator('agent', ctx.agentId)`; `bot.creatorId !== ctx.agentId` → not owned). herobids' broker
keys on `agent.userId`. Traderton's tenancy key is the injected **`ownerId`** (decisions 10–13); there is
no `agents` table and bots are owner-scoped, not agent-scoped.

**The question:** when we copy `tools/bots.ts` verbatim, `ctx.agentId` is the registry/actor key — is that
the right ownership key for Traderton, or should ownership resolve to `ownerId`?

- **(a) Copy verbatim; `ctx.agentId` IS the owner key at M1 (RECOMMENDED).** The `TradingToolContext`
  already exposes `agentId`; at M1 the in-process consumer sets `ctx.agentId` to the actor id it owns, and
  `getBotsByCreator('agent', ctx.agentId)` scopes to that actor's bots. The `create_bot` path stamps the
  injected `ownerId` on the persisted bot (as item B/C already do). Ownership *enforcement* on
  stop/start/status stays `creatorId`-scoped exactly as copied. **No edit to the copied file** — the copy
  stays byte-faithful; the `ownerId` binding lives where B/C already put it. Cleanest, most copy-faithful.
- **(b) Copy-and-adapt `ctx.agentId` → an `ownerId`-scoped lookup** in the tool bodies (authored edits to
  the copied files, logged Intentional Divergence). Diverges the copy; only warranted if (a) can't scope
  correctly. My read: not needed at M1 — the actor key already scopes per owner-actor; the REST boundary
  (item F) is where `ownerId` becomes the authoritative subject, and F already plans the
  `request.userId → ownerId` adaptation for its own route handlers.

**Recommendation: (a)** — copy the tool files verbatim; keep `creatorType='agent'`/`ctx.agentId` as the
copied ownership scoping; bind the injected `ownerId` at the persistence/creation seam (as B/C do), not by
editing the copied tools. If you see M1 multi-owner cases where the actor key isn't a sufficient scope,
that pushes toward (b) and a small logged divergence — worth knowing before I spec it.

## 5. Copy-vs-author manifest (under recommendation (a))

| Piece | Bucket | Note |
|-------|--------|------|
| `tools/trading.ts` (`submit_decision`) | **COPY** (verbatim, modulo namespace) | incl. the unreachable `pending_approval` reply branch (approvals dropped — kept byte-faithful, not authored away) |
| `tools/bots.ts` (6 bot tools) | **COPY** (verbatim, modulo namespace) | binds to `TradingToolContext` (all fields present) |
| `AGENT_MESSAGE_TYPES` (3 trading consts) | **AUTHORED (trivial)** | string values copied verbatim from herobids; mirrors the copy |
| in-process `publishToInbound` drive target | **AUTHORED (seam)** | in-process expression of the Redis-stream hop; traces broker `processInbound` routing |
| bot-lifecycle handler (`handleManageBot` core) | **AUTHORED (wiring)** | traces `handleManageBot` trading core; drives copied `WorkerRuntime`; drops agent/grant/LLM shell |
| `submit_decision` reply write (`agent:decision:reply:*`) | **AUTHORED (wiring)** | pairs item C's result with `trading.ts`'s `blpop` |
| `WorkerRuntime.enqueueLifecycle` seam | **AUTHORED (thin)** or wire existing queue | one public enqueue entry over the copied queue |
| `handleManageBot` agent/session/grant/LLM-policy shell | **DROPPED (Intentional Divergence)** | connection-grant front-end + agent session + LLM policy — platform (decisions 7–13) |
| per-`ownerId` maxBots enforcement | **item E** | D exposes the limit call-site seam |

## 6. Exclusions — NOT in item D (routed elsewhere)

| Excluded | Goes to | Note |
|----------|---------|------|
| per-`ownerId` maxBots atomic enforcement | item E | D leaves the seam |
| `InstanceEventPublisher` status emits (`emitInstanceStatus` bot-list notifications) | item C2 | M1 no-op (the broker emitted managed-bot lists; consumer/event concern) |
| connection-grant resolution / `agents` table / LLM model policy | consumer-owned | dropped (decisions 7–13) |
| M2 REST invocation of these tools | item F | D is the in-process path; F is the HTTP boundary |

## 7. Verification plan (authored seam + copied tools)
- Build/lint green; existing suite stays green (currently 2253 passed / 15 skipped).
- **Copied tool tools:** bring across the herobids `tools/bots.test.ts` + `tools/trading.test.ts` if they
  exist and are trading-clean (they are the parity oracle for the copied files) — confirm at impl.
- **Authored drive target + handler test** (labelled AUTHORED, deterministic): a `MANAGE_BOT:create_and_start`
  → validates config + enqueues a start job (stub runtime); `DECISION_SUBMIT` → routes to a stub
  `submitDecision` + writes the reply key; ownership rejection on a foreign `creatorId`. Trace the handler
  to herobids `handleManageBot` trading core + `processInbound` for reviewability.
- Un-quarantine `validate-trade-instrument.test.ts` (+ `schema.test.ts` after S-2/S-3) and confirm green.

## 8. Open decisions for your steer
1. **§4 crux — ownership key:** (a) copy verbatim, `ctx.agentId`/`creatorType='agent'` is the M1 scope +
   bind `ownerId` at the persistence seam [recommended]; or (b) copy-and-adapt the tools to an
   `ownerId`-scoped lookup (logged divergence). Shapes whether the tool copy stays byte-faithful.
2. **§3.1 `AGENT_MESSAGE_TYPES`:** author the 3-const trading subset (D-i) [recommended] vs herobids
   source-fix #4 (D-ii). (Confirmed the tools use only `DECISION_SUBMIT` + `MANAGE_BOT`.)
3. **§3.5 enqueue seam:** add a thin `WorkerRuntime.enqueueLifecycle` [recommended] vs write the BullMQ
   queue directly from the handler.
4. **§3.6 / item E boundary:** land E's per-`ownerId` limit as a separate item behind the seam D exposes
   [roadmap default], or fold E into the D handler now (E is small).
5. **`BOT_QUERY`:** omit (unused by the copied tools) vs stub. Recommend omit.

**RESOLVED (2026-09-07):** §4 = (a); §8.2 = D-i; §8.3 = (i); §8.4 = E-separate; §8.5 = omit `BOT_QUERY`
routing. See the locked-decisions block at the top. 013 §6 is the self-contained implementer brief;
[021](./021-item-d-implementer-prompt.md) is the implementer prompt — then implement, review, commit, and
pause before item E.
