# 032 — F2b Implementer Prompt (M2 REST boundary — dispatcher integration: deadline + idempotency + side-effecting dispatch + status endpoint + real context + authz)

**Status:** ready to hand to an implementer. On branch `f-m2-rest`.
**Task:** wire the F2a idempotency store into the boundary and complete the side-effecting invocation path:
deadline enforcement, idempotency (persist-before-side-effect + replay/conflict/in-progress), open the
read-only gate to side-effecting tools, the status endpoint, a real `TradingToolContext` factory (with the
subject→injection resolver), and the 005 §Authz item-3 actor-provenance check.
**Authoritative brief:** [013 §8.1.1](./013-9b-authoring-plan.md) (F2 LOCKED decisions D1–D5) +
[030 §3, §4, §8.1](./030-F2-m2-rest-proposal.md) + [005](../../docs/005-consumer-boundary-contract.md) (the contract).
**Depends on:** F2a (DONE, commit `276f752`) — `@traderton/db` `BoundaryInvocationRepository`
(`beginOrResolve`/`complete`/`findByRequestId`/`computeRequestFingerprint`).

---

## 0. Orient first

You are in **Traderton** (`/Users/chinomso.ikwuagwu/dev_ai/traderton`), on branch `f-m2-rest`. F1 landed the
read-only boundary shell (`packages/boundary`, `@traderton/boundary`). F2a landed the Postgres idempotency
store (`@traderton/db` `BoundaryInvocationRepository`). **F2b is the dispatcher integration** — it makes the
boundary execute side-effecting tools safely. **F2c** (the compose stack + dev signing helper + the 7
required-verification tests) is the NEXT prompt — do NOT build it here.

**The law (AGENTS.md):** copy-never-author. `../herobids` is READ-ONLY. F2b is **authored boundary
machinery** (005 is a fresh contract) that injects VALUES and dispatches to the already-copied tools —
author NO trading behaviour. Everything you build lives in `packages/boundary` (+ the boundary's own bin);
no HTTP/HMAC/idempotency concern may leak into `@traderton/worker`/core (the 000 invariant).

## 1. What F2b delivers (the six concerns)

All in `packages/boundary` unless noted. Each is specified in 005; trace it exactly.

1. **Deadline enforcement (D3 — PRAGMATIC).**
2. **Idempotency wrap** (persist-before-side-effect via F2a's repo).
3. **Open the read-only gate** so side-effecting tools dispatch.
4. **The status endpoint** `GET /internal/v1/invocations/:requestId` + the `TradertonToolInvocationStatusV1` type.
5. **A real `TradingToolContext` factory** (subject→injection resolver, D2) wired in `bin.ts`.
6. **005 §Authz item-3 actor-provenance (D4 — OPTION B).**

## 2. Deadline enforcement — D3 PRAGMATIC (005 §Deadlines)

005: "Traderton rejects a request whose deadline has already passed **before validation**, and checks it
again **immediately before every downstream side effect**." Per **D3 (pragmatic)** implement exactly two
checks — do NOT thread `deadlineAt` into the copied drive path:

- **Pre-check:** in `dispatcher.dispatch()`, right after the envelope parses (so `deadlineAt` is readable)
  and before tool lookup/payload validation: if `Date.parse(invocation.deadlineAt) <= now`, return
  `deadline.expired` (retryable=false). Inject a clock (`now: () => number`) the same way `app.ts`/the
  dispatcher already do for tests.
- **Re-check:** immediately before `tool.execute(...)` (dispatcher step 7), re-evaluate the same condition
  → `deadline.expired`. This is the single "before the side effect" re-check the pragmatic reading commits
  to (030 D3). Add a code comment noting the divergence from 005's literal "every side effect" wording is
  the logged D3 decision (docs/003 has the entry — see §7).

The `deadline.expired` code already exists in the closed union (`contract.ts` `BOUNDARY_FAILURE_CODES`).

## 3. Idempotency wrap (005 §Deadlines, Retries, And Idempotency; F2a store)

Wrap the **side-effecting** execute path in `dispatcher.dispatch()`. 005 order: authenticate (done in
`app.ts`) → validate → **persist before side effect** → execute → store terminal. Concretely, after payload
validation + authz (steps 5–6) and after the deadline re-check, for a **side-effecting** tool:

1. Compute the fingerprint: `computeRequestFingerprint({ consumerId, ownerId, toolName, payload })` (use the
   parsed/validated payload; `consumerId` = `invocation.caller.consumerId`, `ownerId` =
   `invocation.subject.ownerId`).
2. `beginOrResolve({ consumerId, ownerId, toolName, idempotencyKey: invocation.idempotencyKey,
   requestFingerprint, requestId, correlationId, retentionMs })` where `retentionMs` is a VALUE derived from
   `boundary.idempotencyRetentionHours` (config — see §5; 005: never hard-coded).
3. Branch on the result:
   - **`conflict`** → `validation.invalid_payload` ("idempotency key reused with a different request").
   - **`in_progress`** → return the `TradertonToolInvocationStatusV1` **in-progress** shape (see §4) — NO
     second execution.
   - **`replay`** → return the stored terminal result (`terminalResponse`) as the `TradertonToolResultV1`.
   - **`started`** → proceed: build context → `tool.execute` → map result → `complete({ …key…,
     terminalResponse: mappedResult })` → return the mapped result. Wrap so that a thrown/failed execute
     still transitions the row to terminal with the mapped failure (do NOT leave a row stuck `in_progress`
     on a caught error — store the `internal.non_retryable`/mapped failure as the terminal response).

**Read-only tools do NOT go through the store** (no side effect to protect — 005; F1 rationale). Gate on the
category: only side-effecting tools (`execute-trade`/`write-database`, i.e. `getCategoryOperation(category)
!== 'read'`) persist. Read-only tools keep the F1 path (execute directly, no store).

The dispatcher currently has only `{ registry, contextFactory }` in `DispatcherDeps` — **add the
`BoundaryInvocationRepository`** (and the `retentionMs` VALUE, and the clock) to `DispatcherDeps`/
`BoundaryAppDeps`, injected from `bin.ts`. Do not import `@traderton/db` types into the dispatcher beyond the
repo's public interface; a thin local interface the repo satisfies is fine to keep the dependency clean.

## 4. Open the read-only gate + the status endpoint

- **Open the gate:** F1's dispatcher step 4 rejects non-read-only tools with `precondition.not_ready`
  ("F2"). Remove that gate so side-effecting tools dispatch — but keep the category distinction (§3: it
  decides store vs no-store). Side-effecting tools now run through the idempotency wrap.
- **Status endpoint:** add `GET /internal/v1/invocations/:requestId` in `app.ts`. It is **authenticated the
  same way** as `tools:invoke` (HMAC over the canonical string — `toSignedRequest` already strips the query;
  the path includes `:requestId`). It reads `repo.findByRequestId(requestId)`:
  - no row → `not_found.resource` failure envelope (or the status shape's terminal-not-found — 005 is
    silent; return a `TradertonToolResultV1` failure `not_found.resource`, retryable=false).
  - row `in_progress` → `TradertonToolInvocationStatusV1` `{ state: 'in_progress' }`.
  - row `terminal` → `{ state: 'terminal', result: <stored terminalResponse as TradertonToolResultV1> }`.
  005: the status endpoint "must never trigger a second execution" — it only reads.
- **Author `TradertonToolInvocationStatusV1`** in `contract.ts` (it is only in 005 prose today):
  ```ts
  type TradertonToolInvocationStatusV1 =
    | { contractVersion: '1.0'; requestId: string; correlationId: string; state: 'in_progress' }
    | { contractVersion: '1.0'; requestId: string; correlationId: string; state: 'terminal';
        result: TradertonToolResultV1 };
  ```
  Note `POST /tools:invoke` may now return EITHER `TradertonToolResultV1` (fresh terminal / replay) OR
  `TradertonToolInvocationStatusV1` (the `in_progress` reuse case) per 005 — type the route accordingly.

## 5. The real `TradingToolContext` factory + subject→injection resolver (D2)

F1's `bin.ts` `baseContextFactory` returns a NOOP context (NOOP redis, `publishToInbound` = no-op, no
`botRepo`). Side-effecting tools need a REAL context. Build it in `bin.ts` (composition root — NOT the
dispatcher; the dispatcher stays wiring-free):

- Stand up a real `createTradingRuntime(ports)` (from `@traderton/worker`) — it needs `config` (an
  `AppConfig`), a real `ioredis` client, and an `instanceLoader`. Read how `create-trading-runtime.ts`
  assembles everything and what `TradingRuntimePorts` requires; load `AppConfig` via the worker config
  loader. Call `runtime.start()` as appropriate for a serving process.
- The runtime exposes **`createDriveTarget(injection)`** where
  `injection = { ownerId, actorId, ownerMode, venue, venueType, venueAccountId, maxBotsOverride?, botLimit? }`.
  The returned value is the real `publishToInbound` (routes `DECISION_SUBMIT`→`submitDecision`,
  `MANAGE_BOT`→bot lifecycle).
- **The subject→injection resolver (D2 — AUTHORED, no oracle).** 005 carries only `ownerId` + `actor`; the
  drive target needs `venue`/`venueType`/`venueAccountId`/`ownerMode`. Author a resolver that maps a signed
  `DispatchSubject` → the `injection` VALUES:
  - **When the tool operates on a named bot** (the payload carries a `botId` — e.g. `stop_bot`,
    `adjust_bot_config`, `start_bot`), read that bot's row (`botRepo.getBotById`) and derive
    `venueAccountId` (the bot's column), `venue`/`venueType` (from the bot `config`), and `ownerMode` (the
    bot `config.execution.mode`). Validate the bot's `ownerId` equals the signed `subject.ownerId`
    (ownership) — mismatch → the boundary maps to `authorization.denied` (the copied drive target ALSO
    re-checks ownership; this is defence in depth, not a replacement).
  - **When no bot is named** (e.g. `create_bot`, `submit_decision`) → resolve a **per-owner default venue
    account**: query `venue_accounts` for the owner (`ownerId`), pick the owner's account (if exactly one)
    or an operator-configured default; derive `venue`/`venueAccountId` from it, `venueType` from the venue,
    `ownerMode` from operator config / a safe default (`paper`). If no venue account resolves →
    `precondition.not_ready` ("no venue account for owner"). Keep this resolver in the boundary package (it
    reads db rows via injected repos — a VALUE lookup, not trading behaviour).
  - This is the D2 authored seam. Add a doc comment: it is authored (no herobids oracle — herobids resolved
    this via the deleted connection-grant/`agents` layer, decisions 11–13) and it injects VALUES only.
- The context factory then returns a real `TradingToolContext`: `agentId` = `subject.actor.id`, `sessionId`
  = a boundary session id, `executionMode` = the resolved `ownerMode`, `authorizationMode` per config/subject
  (keep `approval_required` default unless config says otherwise), the **real `ioredis`** as `ctx.redis`,
  `publishToInbound` = the drive target for the resolved injection, and `botRepo` wired from the runtime's
  bot repository (so `write-database` bot tools work). Read the full `TradingToolContext` shape
  (`packages/domain/src/trading/tool-contract.ts`, the interface at line ~124) and supply what side-effecting
  tools read; optional fields a given tool doesn't use may stay undefined.

Keep the `contextFactory` signature (`TradingToolContextFactory`) as-is — you are supplying a real
implementation, not changing the seam. Guard the DB-work so an unresolvable subject returns a typed failure
(the dispatcher already maps a thrown factory to `precondition.not_ready`).

## 6. 005 §Authz item-3 actor-provenance — D4 OPTION B (operator config, NOT invented rules)

005 §Authz item 3: "the actor provenance is valid for the requested tool." **D4 = Option B:** enforce that
the asserted `actor.type` is one the **operator configured this consumer to assert** — a VALUE, not an
invented per-tool product rule. Concretely:

- Extend `BoundaryConfig` (`config.ts`) so each `allowedConsumers.<id>` entry MAY carry
  `allowedActorTypes?: Array<'agent'|'bot'|'user'|'system'>`, **defaulting to all four** when absent
  (back-compat + no surprise tightening).
- In the dispatcher authz step (step 6, where item-2 non-empty checks live), after the caller is known:
  if `invocation.subject.actor.type` is NOT in the consumer's `allowedActorTypes` → `authorization.denied`
  ("actor type not permitted for this consumer"). This resolves the F1-deferred item-3 (docs/003).
- Do NOT author per-tool rules (e.g. "a bot may not call `create_bot`) — that is the docs/010 B3
  later-option, explicitly out of scope. Add a comment: item-3 is satisfied as an operator-config assertion
  (Option B); per-tool granularity is B3.

Update the dispatcher's step-6 comment (which currently says item-3 is DEFERRED to F2) to say it is now
enforced via Option B.

## 7. Tests (authored — extend `app.test.ts`, no live infra)

F2b's boundary-logic tests run WITHOUT Postgres/Redis by injecting **fakes** for the repo + context (the same
way F1 injects a fake registry/context). Do NOT stand up real infra in unit tests — that is F2c's gated
integration + the 7 verification tests. Prove:

- **deadline pre-check** — an already-expired `deadlineAt` → `deadline.expired`, tool NOT dispatched, store
  NOT touched.
- **deadline re-check** — expiry between pre-check and execute (advance the injected clock) → `deadline.expired`
  before the side effect. (Use a fake context whose tool records whether it ran.)
- **idempotency started→terminal** — a side-effecting call with a fake repo: `beginOrResolve`→`started`,
  tool runs once, `complete` called with the mapped result.
- **idempotency replay** — fake repo returns `replay` → the stored terminal result is returned, the tool is
  NOT run again (assert the fake tool's call count stays 0).
- **idempotency in_progress** — fake repo returns `in_progress` → the `TradertonToolInvocationStatusV1`
  in-progress shape, tool NOT run.
- **idempotency conflict** — fake repo returns `conflict` → `validation.invalid_payload`.
- **read-only tools bypass the store** — a read-only tool with a fake repo: `beginOrResolve`/`complete` are
  never called; the tool runs directly.
- **side-effecting tool now dispatches** (the F1 gate is open) — the write tool that F1 rejected
  `precondition.not_ready` now runs (through the wrap).
- **status endpoint** — `findByRequestId` fake returns in_progress / terminal / null → the three shapes;
  and the status call NEVER invokes a tool.
- **authz Option B** — a consumer configured with `allowedActorTypes: ['agent']` receiving an `actor.type:
  'bot'` request → `authorization.denied`; default (unset) allows all four.
- Keep all existing F1 tests green (the read-only happy path, auth failures, envelope/version, the deadline
  header/body match, etc.).

The subject→injection resolver's DB reads are exercised by F2c's integration test (real Postgres) — in F2b's
unit tests, inject a fake context factory so the resolver's db path is not under unit test (or unit-test the
resolver in isolation with a fake `botRepo`/venue-account lookup if cheap).

## 8. Guardrails / stop-gates

- **Author no trading behaviour.** Deadline/idempotency/authz/status are boundary machinery; dispatch to
  copied tools. If a scenario needs trading logic in the boundary, the seam is mis-drawn.
- **No leak into core.** All new logic lives in `packages/boundary` (+ its `bin.ts`). The dispatcher takes
  the repo via an injected interface; it does not import HTTP or `@traderton/db` internals.
- **D3 pragmatic** — exactly two deadline checks; do NOT plumb `deadlineAt` into `create-trading-runtime`/
  the drive path (that is docs/010 B2).
- **D4 Option B** — operator-config allowed actor types; do NOT author per-tool provenance rules (B3).
- **Retention is a VALUE** (005 — never hard-code the 168h).
- **Do NOT build the compose stack, the dev signing helper, or the 7 required-verification tests** — that is
  **F2c**. If F2b seems to need real Postgres/Redis to be *tested*, use fakes (§7); real-infra proof is F2c.
- **Store hygiene:** a caught execute error must still `complete` the row terminally (never leave it stuck
  `in_progress`).

## 9. Verification / done criteria

- `pnpm build` green, `pnpm lint` clean.
- `pnpm test` green — existing suite unchanged + the new F2b boundary tests pass (all with fakes; no infra).
- Report: files changed; how the deadline pre/re-check, the idempotency wrap (started/replay/in_progress/
  conflict + complete-on-error), the opened gate, the status endpoint + `TradertonToolInvocationStatusV1`,
  the real context factory + D2 resolver, and the D4 Option-B authz are wired; and any seam surfaced. Do NOT
  commit — the coordinator commits on the branch.
- **Then PAUSE** — F2c (compose stack + dev signing helper + the 7 required-verification tests) is the next
  prompt, gated on human review of F2b.

## 10. Key file map

- `packages/boundary/src/dispatcher.ts` — the deadline checks, idempotency wrap, opened gate, D4 authz; add
  the repo + retention + clock to `DispatcherDeps`.
- `packages/boundary/src/app.ts` — the status endpoint route; route return type now a union.
- `packages/boundary/src/contract.ts` — author `TradertonToolInvocationStatusV1`.
- `packages/boundary/src/config.ts` — `allowedActorTypes?` per consumer (D4).
- `packages/boundary/src/bin.ts` — the real `createTradingRuntime` wiring + the D2 subject→injection resolver
  + the real context factory (+ a new resolver module, e.g. `subject-resolver.ts`, if cleaner).
- `packages/boundary/src/app.test.ts` (+ any new test file) — the §7 tests.
- Reference (READ): `@traderton/db` `BoundaryInvocationRepository` (F2a), `create-trading-runtime.ts`
  (`createDriveTarget` injection shape + `TradingRuntimePorts`), `packages/domain/.../tool-contract.ts`
  (`TradingToolContext`), `packages/db/src/schema/{bots,venue-accounts}.ts` (resolver sources),
  [005](../../docs/005-consumer-boundary-contract.md), [013 §8.1.1](./013-9b-authoring-plan.md),
  [030](./030-F2-m2-rest-proposal.md).
