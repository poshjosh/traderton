# 014 — Decision Response & Event Model (design note)

**Status:** DRAFT for discussion — not a decision yet.
**Created:** 2026-09-07
**Purpose:** settle *how an agent submits a decision and receives its outcome* — synchronously and
asynchronously — before finalizing 9b items **C** (intake surface), **D** (drive/messaging seam), and
**B** (composition-root shape). These three are the same seam seen from three angles, so they are worked
together here.
**Feeds:** [013-9b-authoring-plan.md](./013-9b-authoring-plan.md) items B/C/D.
**Governed by:** [000](../000-vision.md) (ports-carry-values; M1→M2), [005](../005-consumer-boundary-contract.md)
(the M2 REST contract), [004](../004-decision-log.md).

---

## 1. The question, precisely

An AI agent calls `submit_decision`. It needs to learn the **outcome**. Two timescales:

1. **Immediate outcome** — was the decision *accepted for execution* or *rejected* (validation/risk-gate
   failure)? This is known within the submit call's lifetime.
2. **Later lifecycle** — fills arriving, plan status transitions, reconciliation notices, guardrail
   trips. These happen *after* the submit call returns and can trail for seconds→minutes→hours.

The design must serve both **without** forcing an AI agent to run a webhook server it may not have, and
must keep Traderton's boundary clean (ports carry values, not trading behaviour).

## 2. What the source actually does (verified, read-only)

The source already has **both** timescales — this is not greenfield:

### 2a. Synchronous reply (immediate outcome)
`tools/trading.ts` `submit_decision`:
- generates `decisionId`, publishes `DECISION_SUBMIT` with `_expectsReply: true`,
- then **blocks on `redis.blpop('agent:decision:reply:${decisionId}', 30)`** — a 30s synchronous wait.
- The decision handler computes an outcome and calls `eventPublisher.publishDecisionReply(decisionId, syncReply)`
  where `syncReply = { status: 'accepted'|'rejected'|'error'|'pending_approval', code?, message?, planId?, … }`.
- Timeout → `decision_reply_timeout` (agent told to check the events stream).

This is **request-response already.** It maps 1:1 onto 005's M2 contract: `POST /tools:invoke` returns the
terminal `TradertonToolResultV1` synchronously, and `GET /internal/v1/invocations/:requestId` resolves an
ambiguous timeout. (Note: `pending_approval` is now consumer-side per [004](../004-decision-log.md) — the
Traderton reply reduces to `accepted | rejected | error`.)

### 2b. Asynchronous event stream (later lifecycle)
`InstanceEventPublisher` emits canonical-envelope messages onto **Redis Streams**, one method per event.
The `INSTANCE_MESSAGE_TYPES` it emits split cleanly into trading vs platform:

| Event | Trading? | Notes |
|-------|----------|-------|
| `DECISION_ACCEPTED` | **trading** | decision admitted to execution |
| `DECISION_REJECTED` | **trading** | validation/risk-gate rejection |
| `PLAN_STATUS` | **trading** | execution plan transitions |
| `EXECUTION_RESULT` | **trading** | fills / final execution outcome |
| `RECONCILIATION_NOTICE` | **trading** | drift detected vs venue |
| `GUARDRAIL_TRIGGERED` | **trading** | risk guardrail fired |
| `JOURNAL_EVENT` | **trading** | trading journal event |
| `STATUS` (instance) | trading-ish | actor/instance status |
| `DECISION_PENDING_APPROVAL` | **platform** | consumer-owned approvals (dropped, [004](./004)) |
| `CONTEXT_SNAPSHOT` | **platform** | agent reasoning context |
| `TOOL_RESULT` | **platform** | agent tool-call plumbing |
| `WATCH_TRIGGERED` / `DISCOVERY_DETECTED` / `REGIME_CHANGED` / `AGENT_WAKE` (`MARKET_MONITOR_*`) | **platform** | agent-wake push loop (`monitor.ts`, already Intentional Divergence) |

So the async surface Traderton owns is a **~7-event trading subset** of a clean emitter. The publisher
itself is well-shaped (one method per event, canonical envelope) and its trading methods depend only on
trading payloads.

### 2c. The inbound broker (the "D: don't go small" concern)
`agent-message-broker.ts` is **1941 lines** and imports `AgentRepository`, `agentSkills`, `skills`, `users`,
`TelegramClient`, `EmailClient`, `AgentSessionManager`, `CapabilityPolicyEngine`, the preset tools. Its job
is agent lifecycle / skills / telegram / capability policy / session ownership. Of the 14
`AGENT_MESSAGE_TYPES`, only **3 are trading** (`DECISION_SUBMIT`, `MANAGE_BOT`, `BOT_QUERY`).

**Finding for D:** "copy-then-delete the broker" would import ~1900 lines of platform code to keep 3
trading routes — it *inverts* copy-and-delete (delete 95%, keep 5%, drag platform deps back). The broker
is platform. **BUT** the parity concern was right about the wrong file: the parity-critical piece is the
**outbound event surface (2b)**, not the inbound broker. Going "small" on the *inbound constants* loses
nothing (the other 11 types are platform); going "small" on the *outbound events* WOULD lose real trading
feedback. So: author the 3 inbound constants + drive target (D), and **own the outbound trading event
surface deliberately (this note's core)**.

## 3. Design principles

1. **Sync-first.** The common agent flow is "submit and learn the immediate outcome." Serve it with a
   synchronous request-response — it's what the source does and what 005 already specifies. An AI agent
   should not need any async infrastructure for the 90% case.
2. **Async is opt-in and consumer-delivered.** Lifecycle events (fills, plan status, reconciliation) are a
   **stream Traderton produces**; *how they reach the agent* is the consumer's choice. Traderton owns
   producing the events (a value/event port); it does not own the transport.
3. **Agent-friendly.** Do not require an AI agent to stand up a webhook server. Provide delivery modes that
   suit an agent: in-process subscription (M1) and poll/long-poll or a *once-registered* push endpoint (M2).
4. **Ports carry values, never behaviour.** The event port carries trading *facts* outward; the reply
   carries an *outcome value*. Neither lets a consumer inject risk/planner/executor behaviour.
5. **Same core, two adapters (ties to B).** Whatever the response model, M1 (in-process) and M2 (REST)
   drive the *same* intake core and the *same* event producer — only the delivery adapter differs.

## 4. Options for the async delivery (the open design choice)

Sync (immediate outcome) is settled — request-response, already in source + 005. The genuine choice is how
the **later lifecycle events** reach the agent. Four modes, not mutually exclusive:

- **(M-A) In-process subscription (M1 default).** The consumer (herobids) injects a sink / subscribes to
  Traderton's event port in-process. This is exactly the M1 shape — herobids consumes the stream as it does
  today. **No transport authored.** ✅ for M1.
- **(M-B) Poll / long-poll (M2, agent-friendliest).** The agent calls `GET /invocations/:id` (already in
  005) for a specific decision, and/or a `GET /events?since=cursor` to pull lifecycle events. No agent
  server required; the agent pulls when it wants. Simple, secure (same HMAC auth as inbound), stateless-ish.
- **(M-C) Register-once webhook (M2, for push-wanting consumers).** At onboarding the consumer registers
  **one** signed callback URL; Traderton POSTs lifecycle events to it (HMAC-signed, like 005 inbound in
  reverse, with retry/backoff). NOT per-decision URLs (URL sprawl, per-call auth, weaker security). This is
  the payment-provider webhook pattern, done once.
- **(M-D) Streaming (SSE/WebSocket).** A long-lived `GET /events/stream`. More infra; defer unless needed.

**Recommended shape:**
- **M1:** (M-A) in-process subscription — zero transport authored, matches how herobids works today.
- **M2:** (M-B) poll/long-poll as the **default** (agent-friendly, no agent server) **+** (M-C)
  register-once webhook as an **opt-in** for consumers that prefer push. (M-D) deferred.
- **Sync outcome** at both milestones via the request-response the source + 005 already define.

This keeps the 90% case a simple call-and-await, adds no mandatory agent infrastructure, and preserves the
full trading-event parity via an owned event producer.

## 5. What this means for 9b items B / C / D

### Item C — intake surface (revised)
- Author the venue-account-direct resolver + slim decision handler (as in 013).
- The handler produces a **synchronous outcome value** (`accepted | rejected | error`) delivered via an
  injected **reply port** (M1: the consumer's reply mechanism; M2: the `tools:invoke` response). No
  approval branch (consumer-owned).

### New item C2 — outbound trading event producer (this note's addition; parity-critical)
- Author a Traderton **event port** that produces the ~7 trading `INSTANCE_MESSAGE_TYPES` events
  (decision accepted/rejected, plan status, execution result, reconciliation notice, guardrail, journal).
- Traderton owns *producing* them; the consumer chooses delivery (M-A in-process at M1; M-B/M-C at M2).
- This subsumes and sharpens the former "item C `InstanceEventPublisher` port" open question: it is a
  **value/event port**, platform-transport-free. The trading payload shapes are copied from the source
  (they are trading types); the *transport* is authored per milestone.
- **Parity guard:** the acceptance bar is that every trading lifecycle event herobids-today emits is
  produced by Traderton (no silent loss). This is the concrete answer to the "don't go small / lose
  parity" concern — pinned to the outbound event list in §2b.

### Item D — inbound drive (confirmed direction)
- Author the **3 trading message-type constants** + the in-process drive target. Do **not** copy the
  1941-line broker (platform). "Small" is correct here *because the omitted 11 types + the broker body are
  platform* — provable file-by-file. The parity that matters lives in C2 (outbound), not the inbound broker.

### Item B — composition-root shape (deeper dive, tie-in)
- The response/event model reinforces the **factory** shape: `createTradingRuntime(config, ports)` returns
  the intake core **and** the event producer; M1 wires in-process sinks, M2 wraps the same instance with the
  REST adapter + delivery (poll/webhook). "Same core, two adapters" is exactly what makes both timescales
  work without divergence. The factory should expose: `submitDecision(...)` (returns sync outcome) and an
  `events` producer/subscription handle (async). This is the concrete B decision the response model implies.

## 6. Open questions for discussion (why this is a note, not yet a decision)

1. **Async default at M2:** poll/long-poll (M-B) as default with opt-in webhook (M-C) — agreed, or do you
   want webhook-first?
2. **Event cursor/retention:** if we offer poll (`GET /events?since=`), Traderton must retain events with a
   cursor (Redis Streams already give this via stream IDs + `MAXLEN`). Confirm Traderton owns an event
   store/stream, and its retention policy (a value, operator-config).
3. **Scope of the trading event set:** confirm the ~7-event trading subset in §2b is right (esp. whether
   `STATUS`/`JOURNAL_EVENT` are in or out for the agent-facing surface).
4. **Does C2 land in M1 or M2?** Producing events is M1 (in-process sink); the *poll/webhook transport* is
   M2. Confirm we author the producer at M1 and the transports at M2.
5. **B factory signature:** is `createTradingRuntime` returning `{ submitDecision, events, … }` the right
   public shape for herobids to consume in-process?

## 7. Recommendation (for the discussion)

- **Sync outcome:** request-response, as source + 005 (settled).
- **Async lifecycle:** own the trading event **producer** (C2, parity-critical); deliver in-process at M1,
  poll-default + opt-in register-once webhook at M2. No mandatory agent server.
- **Inbound:** 3 constants + drive target; broker stays platform (D).
- **Composition root:** factory returning the intake core + event producer (B).

Nothing here is implemented. On agreement, I fold C2 into 013 (as a first-class parity item), confirm D,
and lock B's factory signature — then proceed A→E for M1.
