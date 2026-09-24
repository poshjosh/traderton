# L3-01 — herobids consumes Traderton over REST (investigate → propose)

**Status:** PROPOSAL — awaiting human decisions (§8). Do NOT implement yet.
**Milestone:** L3 of [024](../024-verification-and-consumption-roadmap.md) — herobids deletes its in-tree
trading execution and consumes `@traderton/*` over the **F/005 REST boundary**; merging = cutover.
**Reads:** [CANONICAL-STATE.md](../CANONICAL-STATE.md) (§3 REST is the settled cutover shape; §5 the
herobids consumption-branch read-only exception is IN FORCE), [005](../005-consumer-boundary-contract.md)
(the contract herobids calls), [000](../000-vision.md)/[004](../004-decision-log.md) (the why).
**Where the work happens:** in **herobids**, on a branch `consume-traderton` (per §5 — herobids `main` and
all other branches stay untouchable; the merge to herobids `main` = cutover, human-approved). This spec
lives in traderton (the migration spec is ours per 024); the edits it describes are executed in herobids.

---

## 1. What L3 is

herobids stops running trading in-process and instead makes **signed HTTPS calls to the Traderton boundary**
(`POST /internal/v1/tools:invoke`, `GET /internal/v1/invocations/:requestId`, HMAC per 005). herobids keeps
the platform it always owned (users, the connections/agents grant layer, the message broker, LLM reasoning,
human approvals, the maxBots decision) and injects the platform-owned VALUES into the 005 envelope
(authenticated `ownerId`+`actor`, resolved `venueAccountId`, grant validity, `maxBots`). Everything trading
(risk gate, planner, executors, venues, market-data, mechanical strategy, the actor/runtime loop, the
trading DB) is DELETED from herobids and lives only behind the boundary.

**The whole point (legal):** consuming in-process would put `@traderton/*` back inside the herobids
deployable, re-coupling trading to the platform's payment rails — the exact risk the split exists to
prevent (CANONICAL-STATE §3, [004](../004-decision-log.md)). So the consumption is REST, out-of-process.

## 2. How herobids drives trading TODAY (the seam, verified read-only)

Two dispatch shapes (both must be rewired or the in-process trading path survives cutover):

- **Redis-brokered side-effecting.** A tool calls `ctx.publishToInbound(AGENT_MESSAGE_TYPES.*, …)`; the
  worker's `AgentMessageBroker.processInbound` (`apps/worker/src/agents/agent-message-broker.ts`) validates
  + capability-gates + resolves grants, then routes to a handler that drives the engine:
  - `submit_decision` (`apps/worker/src/tools/trading.ts`) publishes `DECISION_SUBMIT`, then **blocks on
    `ctx.redis.blpop('agent:decision:reply:${decisionId}', 30)`** for a rich reply
    (`accepted | pending_approval | rejected | error`). The broker → `AgentDecisionHandler.handleDecisionSubmit`
    (`apps/worker/src/agents/agent-decision-handler.ts:7,~150+`) calls `submitDecisionForExecution` from
    `@herobids/engine` — **the trading execution core**.
  - `create_bot`/`start_bot` (`apps/worker/src/tools/bots.ts`) publish `MANAGE_BOT`; the broker →
    `handleManageBot` (`agent-message-broker.ts:~560–850`) resolves the connection/venue-account
    (`getRuntimeCapabilityDescriptor:568`, `getResolvedVenueAccount:595`, `isConnectionOwnedBy:601`),
    enforces `botLimitCheck` (maxBots, :607), stamps `venueType` (:612–618), then enqueues the trading
    actor via `botStart` (:748/:825) onto the BullMQ `trading-instance-lifecycle` queue →
    `WorkerRuntime` (`runtime.ts`) → `AgentTradingActor` (the execution loop).
- **Direct-DB reads + light bot management.** `get_account_summary`, `get_analytics`, `list_positions`,
  `list_bots`, `get_bot_status`, `stop_bot`, `adjust_bot_config` reach trading Postgres directly via
  `ctx.botRepo` / `ctx.riskContractOps` / `ctx.executionConfig` (tools in `apps/worker/src/tools/
  {account,analytics,bots}.ts`).
- **Second bot path (non-agent):** `apps/api/src/routes/bots.ts` `POST /bots` enqueues the SAME
  `trading-instance-lifecycle` queue directly. Both call sites must be rewired.

The mixed `ToolContext` (`packages/domain/src/tools.ts:17`, `extends TradingToolContext`) carries both
platform (`agentId`, `agentRepo`, `publishToInbound`, `redis`) and trading (`botRepo`, `riskContractOps`,
`executionConfig`) fields — the type itself is a seam.

## 3. DELETE / KEEP / REWIRE inventory

**DELETE (moves fully behind REST):** packages `engine`, `venues`, `market-data`, `strategy`,
`backtesting`; the worker execution slices (`agent-trading-actor.ts`, `trading-actor.ts`,
`execution-actor.ts`, `runtime.ts`, technical/scanner/tick/candle/swap/venue-adapter-factory helpers);
the trading DB tables (`positions`, `fills`, `orders`, `execution-plans`, `decisions`, `decision-*`,
`balance-snapshots`, `reconciliation-events`, `backtest-runs`, `instruments`, `bots`) + their repos.
**`venue-accounts` is special — see §6 subtlety (a).**

**KEEP (platform, stays in herobids):** `users`, `connections`, `agent-connections`, `agents`,
`user-credentials`, `agent-runtime-sessions`, `agent-messages` tables + repos; the grant/venue-account
resolution front-end (`startup-context.ts` `resolveBotStartupContext`, `agent-runtime-descriptor.ts`
`getRuntimeCapabilityDescriptor`, `repositories.ts` `getResolvedVenueAccount`/`isConnectionOwnedBy`,
`connections.resolvedVenueAccountId`); the agent message-broker + messaging; LLM/reasoning; human
approvals; the per-agent `maxBots` decision (`agent-create-normalization.ts`).

**REWIRE (surgical — ~5–6 files; the fusion points, verified):**
1. `agent-message-broker.ts` `handleManageBot` — replace the `botStart`→actor kickoff (and the enqueue in
   `start`/`adjust`) with a **signed REST `tools:invoke`** of `create_bot`/`start_bot`/`stop_bot`/
   `adjust_bot_config`, keeping the grant-resolve + maxBots + venue-stamp PRE-work (that produces the
   injected values).
2. `agent-decision-handler.ts` `handleDecisionSubmit` — replace `submitDecisionForExecution` with a signed
   REST `tools:invoke` of `submit_decision`; keep the approval-required gate (platform) but source the
   `venueAccountId` it snapshots from the grant front-end, not the (now-removed) engine intake (subtlety c).
3. `apps/worker/src/index.ts` composition root — swap the trading half (WorkerRuntime/actor/botStart) for a
   constructed **Traderton REST client**; delete the trading-package imports.
4. `apps/api/src/routes/bots.ts` — the `POST /bots` path enqueues → signed REST invoke.
5. `packages/domain/src/tools.ts` `ToolContext` — drop the trading fields (`botRepo`/`riskContractOps`/
   `executionConfig`); read tools now call the boundary too.
6. Read tools (`tools/{account,analytics,bots}.ts`) — the direct-DB reads become signed REST invokes of the
   read-only tools (`get_account_summary`, `get_analytics`, `list_positions`, `list_bots`, `get_bot_status`).

## 4. The Traderton REST client (authored in herobids — a thin adapter, not trading behaviour)

A small `fetch`-based client in herobids (e.g. `apps/worker/src/traderton/client.ts` + a shared signer),
following herobids' existing HMAC patterns (`connections-oauth-state.ts:47–52`, `auth.ts:59–73` —
`createHmac('sha256') + timingSafeEqual`; no shared util exists yet, factor one). It:
- builds the 005 envelope (`TradertonToolInvocationV1`: contractVersion, requestId, idempotencyKey,
  correlationId, issuedAt, deadlineAt, `caller`, `subject{ownerId, actor}`, toolName, payload);
- signs the 005 canonical string (`METHOD\nPATH\nX-Traderton-Timestamp\nSHA256(body)`) — **mirror
  traderton's committed dev signer `packages/boundary/src/dev/sign.ts`** so the bytes match the verifier;
- POSTs `tools:invoke`, maps the `TradertonToolResultV1` outcome back to the tool's reply shape, and for
  the async/idempotent case polls `GET invocations/:requestId`.
- Config: add a `boundary` block (`baseUrl`, `hmacSecretRef`, `consumerId`, `keyId`, `timeouts`) to
  herobids `config/*.yaml` + `packages/domain/src/config/schema.ts` (env override for the secret, per the
  `STRIPE_WEBHOOK_SECRET` convention). The boundary base URL is the deployed Traderton service.

**Invariant check:** the client injects VALUES + calls copied tools; it authors no risk/planner/executor
logic. HTTP/HMAC lives in the client, not in any trading core (that core is now remote).

## 5. Acceptance bar + verification (the differential guarantee)

- **herobids' own trading tests stay green** — the worker trading tests (tool tests, broker/handler tests,
  the integration drive-path tests) are re-pointed at the boundary (or converted to boundary-differential
  tests). This is the "not weaker than herobids-today" parity bar.
- **REST differential at the boundary** — drive representative flows (a paper `submit_decision`, a
  `create_bot`, the read tools) through BOTH herobids-today (in-process) and herobids-on-the-branch
  (REST→Traderton) with identical inputs; assert identical trading outcomes. This is the L3 differential
  that 024 defers to the REST boundary (since L2 was skipped). It is the "does not deviate" guarantee.
- **The stack:** the traderton `docker-compose.yml` (F2c) stands up the boundary + Postgres + Redis;
  herobids points its `boundary.baseUrl` at it for local/staging runs.
- **Merge gate (unchanged, human-owned):** herobids consumes the library (this branch) + all tests pass +
  run locally AND on staging for a while (manual/visual/black-box) + explicit human approval → merge =
  cutover.

## 6. Subtleties that need a decision (verified real, from the seam map)

- **(a) `venue-accounts` straddles the boundary.** herobids needs the account *identifier + ownership* to
  inject `venueAccountId` (its grant front-end reads `venue-accounts`), but Traderton owns *execution*
  against that account (and holds `user_credentials`). Who owns the `venue_accounts` table after cutover,
  and how does herobids resolve an account id it no longer stores? (Options: Traderton owns it and exposes
  a resolve/read tool; herobids keeps a thin account-id/ownership mirror; or the connection layer already
  carries enough. **Decision D-a.**)
- **(b) `submit_decision` is a synchronous 30s Redis BLPOP with rich statuses**
  (`accepted|pending_approval|rejected|error`); 005 is `invoke` + poll `invocations/:requestId`. The rewire
  must preserve the synchronous-feeling reply + all status codes over the async REST shape (invoke, and if
  not terminal, poll to deadline). **Decision D-b:** confirm the mapping (esp. how `pending_approval`, which
  is platform-owned, composes with a boundary that only knows execution).
- **(c) Approval-required (platform) currently reads the trading intake's `venueAccountId`.** After the
  engine leaves, the approval snapshot must source `venueAccountId` from the grant front-end (kept), not the
  boundary — confirm the approval flow needs no trading value the boundary won't return. **Decision D-c.**
- **(d) Dual bot-drive call sites** (broker + `api/routes/bots.ts`) both enqueue the same queue — both must
  be rewired; missing either leaves a live in-process trading path. (Not a decision — a checklist item, but
  flagged because it's the easiest cutover miss.)

## 7. Proposed L3 sub-phasing (slice-by-slice, each on the branch, reviewed, paused between)

- **L3a — the REST client + config + signer** (no rewire yet): the herobids Traderton client, the config
  block, a signer factored from the existing HMAC helpers, unit-tested against a stubbed boundary. Nothing
  deleted.
- **L3b — rewire the read path** (lowest risk): `get_account_summary`/`get_analytics`/`list_positions`/
  `list_bots`/`get_bot_status` → REST; drop the trading fields they used from `ToolContext`. Read tools
  have no side effects, so this is the safe first cut (mirrors why F1 was read-only first).
- **L3c — rewire the side-effecting path:** `submit_decision` (D-b), `create_bot`/`start_bot`/`stop_bot`/
  `adjust_bot_config` in both call sites (broker + API route); keep the grant/maxBots/approval PRE-work.
- **L3d — delete the trading packages + worker execution loop + trading DB** (the big subtraction), once
  nothing imports them; run the differential + herobids' suite.
- **L3e — differential + staging soak → the merge gate.** Human-owned.

## 8. Decisions needed before implementing (please steer)

- **D1 — Confirm the branch + scope.** Work on herobids `consume-traderton`; herobids `main`/other branches
  untouchable; merge = cutover (human-approved). (CANONICAL-STATE §5 — confirm we start it.)
- **D2 — `venue_accounts` ownership after cutover (subtlety a).** Traderton owns it + exposes a resolve
  tool? herobids keeps a thin id/ownership mirror? The connection layer suffices? RECOMMEND: Traderton owns
  `venue_accounts` + `user_credentials` (it makes the venue calls — decision 12); herobids resolves the
  account id it injects from the **connection grant** it already owns (`connections.resolvedVenueAccountId`),
  which is a platform value — so herobids injects an id it holds without storing the account row. Confirm.
- **D3 — `submit_decision` async mapping (subtlety b).** RECOMMEND: invoke → if terminal within the request,
  return it; else poll `invocations/:requestId` to the deadline, preserving all four status codes;
  `pending_approval` stays a *herobids* outcome produced by the platform approval gate BEFORE the boundary
  call (the boundary only executes an already-approved decision). Confirm.
- **D4 — L3 sub-phasing (§7)** — confirm L3a→L3e, read-path-before-write, delete-last.
- **D5 — This proposal's home + the herobids-side doc.** This spec is in traderton `docs/features/initial/features/`; the
  herobids branch will also need a short in-herobids record (its own AGENTS/README note that trading is now
  consumed over REST). Confirm you want both.

## 9. Recommendation

Proceed L3a→L3e with D2 = Traderton owns `venue_accounts`/`user_credentials` + herobids injects the
grant-resolved id; D3 = invoke+poll with approval staying a pre-boundary platform outcome; on your steer I
lock these into CANONICAL-STATE + write the L3a implementer prompt and run the coordinator loop **in
herobids on `consume-traderton`**, pausing between slices. Nothing merges to herobids `main` without you.
