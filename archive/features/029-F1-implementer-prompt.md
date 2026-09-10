# 029 — F1 Implementer Prompt (M2 REST boundary — shell + auth + dispatcher + health, read-only tools)

**Status:** ready to hand to an implementer. On branch `f-m2-rest`.
**Task:** implement **F1** — the authored 005 REST boundary **shell**: Fastify app + HMAC-SHA-256 auth +
envelope/version validation + the `tools:invoke` dispatcher over `ToolRegistry` + `/health/{live,ready}`,
scoped to **read-only tools**. Idempotency, deadline enforcement, and side-effecting tools are **F2** (a
later prompt) — do not build them here.
**Authoritative brief:** [013 §8](./013-9b-authoring-plan.md) (LOCKED decisions + manifest),
[028](./028-F-m2-rest-proposal.md) (design record), and [005](../../docs/005-consumer-boundary-contract.md) (the
contract). Read all three. This prompt is the actionable checklist; **013 §8 wins on any conflict.**

---

## 0. Orient first

You are in **Traderton** (`/Users/chinomso.ikwuagwu/dev_ai/traderton`), on branch `f-m2-rest`. Read
[AGENTS.md](../../AGENTS.md), [000](../../docs/000-vision.md) (esp. the "in-process vs REST" hard-constraint block —
F is the shipped REST boundary, an **adapter over the same M1 ports**, and must NOT leak HTTP/HMAC concerns
into the core), [013 §8](./013-9b-authoring-plan.md), [028](./028-F-m2-rest-proposal.md), and **005 in
full** (it is the exact contract). Assume no chat context.

**What F is (and the law):** the 005 boundary is **authored-new** — there is NO herobids equivalent to copy
(herobids uses JWT `request.userId`, not this HMAC/`tools:invoke` boundary; verified). But F authors only
**boundary machinery** — auth, validation, dispatch, health — over the **already-copied 25 tools +
`ToolRegistry`**. It authors **no trading behaviour**; it dispatches to `tool.execute(...)`. If you find
yourself writing trading logic, STOP — the seam is mis-drawn (ports-carry-values, 000).

**F1 scope discipline:** F1 is the *read-only* slice so the shell can land + be reviewed before the
side-effecting/idempotency machinery (F2). **Only read-only tools are invokable in F1** (see §4). This is
safe precisely because read-only tools have no side effects, so F1 legitimately omits idempotency + deadline
(those exist to protect side effects — F2).

## 1. LOCKED decisions (013 §8.1)
- **(1) `tools:invoke`-only boundary** — the 005 endpoints, nothing else. No per-resource routes. (The
  quarantined `_deferred-authoring/api-routes/**` are NOT reproduced — a signed-off Gap; not your concern.)
- **(3) Fastify** is the HTTP server lib.
- **(4) F1 = shell + auth + envelope validation + dispatcher + health, READ-ONLY tools.** Idempotency
  (Postgres `boundary_invocations`), deadline enforcement, side-effecting tools, the status endpoint, and
  the 7 verification tests are **F2** — do not build them.
- Decisions (2) Postgres idempotency and (5) the 7 verification tests are **F2**.

## 2. Where F lives (decide + confirm against conventions)
A new package is the natural home — proposed `packages/boundary` (`@traderton/boundary`), depending on
`@traderton/worker` (for `createTradingRuntime`/`TradingRuntime`/`ToolRegistry`/`TradingToolContext`) +
`@traderton/domain`. Confirm the monorepo layout (a `packages/*` workspace with `tsconfig`/`package.json`
matching the others). The Fastify app + a tiny bin entry live here. Keep the *boundary* code out of
`@traderton/worker` (the core must not gain an HTTP dependency).

## 3. What F1 authors (all specified in 005 — trace it exactly)

**Endpoints (005 §Endpoints):**
- `POST /internal/v1/tools:invoke` — the execution entry point (read-only tools only in F1).
- `GET /health/live` — process can serve.
- `GET /health/ready` — config + boundary validation + the underlying `TradingRuntime` ready. (Full
  persistence/deps readiness firms up in F2; F1's `/ready` reflects what F1 wired.)
- (The status endpoint `GET /internal/v1/invocations/:requestId` is **F2** — idempotency-backed.)

**HMAC-SHA-256 auth (005 §Authentication), authored as Fastify middleware/preHandler:**
- Canonical string **exactly**: `METHOD + "\n" + PATH + "\n" + X-Traderton-Timestamp + "\n" + SHA256(raw
  JSON body)`. Use the **raw** body bytes for the SHA256 (configure Fastify to retain the raw body).
- Required headers: `Content-Type: application/json`, `X-Traderton-Consumer-Id`, `X-Traderton-Key-Id`,
  `X-Traderton-Timestamp` (RFC3339 UTC), `X-Traderton-Signature: sha256=<hex>`, `X-Request-Deadline-At`.
- Verify: consumer/key are **configured** (operator config, §"Configuration" — `boundary.allowedConsumers`);
  timestamp within `boundary.clockSkewMs`; **constant-time** hex-digest compare; the header `caller` fields
  match the body `caller.consumerId`/`keyId` **exactly**. Any mismatch → `authentication.invalid_caller`
  **before** authorization or any dispatch.
- `secretRef` is local signing material (operator config); it never crosses the boundary.

**Envelope + version validation (005 §Invocation Contract, §Version Compatibility):**
- Parse the body as `TradertonToolInvocationV1` with a Zod schema; **reject unknown outer keys**.
- Path-major ↔ `contractVersion`-major must match; unsupported → `contract.unsupported_version` (terminal,
  pre-dispatch).
- Then `toolName` → the tool's Traderton-owned payload schema: `ToolRegistry.get(toolName)`; unknown tool →
  `validation.invalid_payload`. Validate `payload` against `tool.parametersSchema` (the Zod schema on the
  copied tool); parse failure → `validation.invalid_payload`.

**Authorization (005 §Authentication And Authorization, the post-auth checks):**
- caller allowed to use the boundary; non-empty `subject.ownerId` + `subject.actor`; actor provenance valid
  for the tool; any tool-specific readiness/binding prerequisite. Failure → `authorization.denied`.

**Dispatch (the adapter-over-ports core):**
- Build a `TradingToolContext` from the request: the signed `subject.ownerId`/`actor` + the values the
  boundary supplies (the same injection item C/D used — resolved `venueAccountId` etc. come from the
  consumer/subject or config; for read-only tools most of these are unused). Get the `ToolRegistry` from
  the running `TradingRuntime` (or a registry the boundary constructs from the copied `*Tools` exports).
- `const result = await tool.execute(payload, ctx)` → map `ToolResult` → `TradertonToolResultV1`
  (`{kind:'success', payload}` or `{kind:'failure', code, message, retryable, details?}` using the **closed**
  `TradertonBoundaryFailureCode` union). Map a tool error to the right code (a tool-reported failure is
  typically `internal.non_retryable` or `upstream.transient` per the tool's `retryable`/`fault`; a
  not-found → `not_found.resource`; a readiness issue → `precondition.not_ready`). Never leak
  credentials/raw provider responses/internal authz detail (005 §Consumer Result Mapping).

**Result envelope:** `TradertonToolResultV1` (contractVersion, requestId, correlationId, outcome).

## 4. F1 read-only tool gate (the scope enforcement)
Only tools whose `category` starts with `read-` may be invoked in F1. `ToolRegistry` already exposes
`getReadOnlyToolNames()` (filters `category.startsWith('read-')`). Use it: if `toolName` resolves to a
**non-read-only** tool, F1 returns a typed failure (`precondition.not_ready` with a clear message like
"tool not available on this boundary yet — F2") — do NOT dispatch a side-effecting tool in F1. (The
read-only set per the tool categories: `get_account_summary`, `get_analytics`, `list_positions`,
`list_bots`, `get_bot_status`, `find_instrument`, `search_tokens`, `discover_tokens`, `check_regime`,
`get_funding_rates`, `get_market_overview`, `get_price`, `resolve_bot`, `resolve_watch`, `resolve_task`,
`get_risk_limits`, `get_schema`, `list_watches`.) The `execute-trade`/`write-*` tools are F2.

## 5. F1 tests (authored — 005 is fresh, no copy oracle)
A subset of 005 §"Required Verification" that applies without side effects (the full 7 land in F2). F1 must
prove:
- a **valid signed** read-only call succeeds (dispatches the tool, returns `TradertonToolResultV1` success);
- **bad/expired/replayed/unauthorized signatures fail before dispatch** (`authentication.invalid_caller`) —
  wrong signature, wrong consumer/key, out-of-skew timestamp, header/body `caller` mismatch;
- **malformed envelope / unknown outer key / unsupported version → typed failure** pre-dispatch
  (`validation.invalid_payload` / `contract.unsupported_version`);
- **unknown tool / bad payload → `validation.invalid_payload`**;
- **a side-effecting tool is rejected on the F1 boundary** (not dispatched) — the F1 scope gate;
- `/health/live` + `/health/ready` return the fixed semantics.
Deterministic (no real venue network; read-only tools may need a DB/registry — use the same gated approach
as elsewhere or a constructed registry with stub tool context where a read tool needs no live data; do NOT
stub the boundary's own auth/validation/dispatch — those are what's under test).

## 6. Guardrails / stop-gates
- **Author no trading behaviour** — dispatch to copied tools; if a scenario needs trading logic in the
  boundary, the seam is mis-drawn.
- **No HTTP/HMAC concern leaks into `@traderton/worker`/core** — it all lives in the boundary package.
- **Do NOT build idempotency, deadline enforcement, the status endpoint, or side-effecting dispatch** —
  that's F2. If F1 seems to *need* them, re-read the scope (read-only has no side effects to protect).
- **Do NOT reproduce the quarantined `api-routes/**`** — they're a signed-off Gap.
- If a copied tool can't be invoked through the dispatcher without authoring around a missing piece, STOP
  and surface it.

## 7. Verification / done criteria
- `pnpm build` green, `pnpm lint` clean (the new package typechecks).
- `pnpm test` stays green (the existing 2315/17 unchanged; F1 adds its own tests).
- F1 tests (§5) pass.
- Report: files/package added, how the dispatcher builds `TradingToolContext` + reaches `ToolRegistry`, the
  read-only gate, and any seam surfaced. Do NOT commit — the coordinator commits on the branch.
- **Then PAUSE** — F2 (idempotency + deadline + side-effecting + the full 7 verification tests) is the next
  prompt, gated on human review of F1.

## 8. Key file map
- [005](../../docs/005-consumer-boundary-contract.md) — the exact contract (endpoints, envelope, canonical string,
  headers, failure-code union, health). **Trace it precisely.**
- `packages/worker/src/tools/registry.ts` — `ToolRegistry` (`get`/`has`/`list`/`getReadOnlyToolNames`/
  `getDefinitions`) — the dispatch target.
- `packages/worker/src/tools/index.ts` — the `*Tools` exports (the 25 tools) + `ToolRegistry` +
  `convertZodToJsonSchema`.
- `packages/domain/src/trading/tool-contract.ts` — `TradingToolContext`, `AgentTool`, `ToolResult` (the
  tool contract the dispatcher builds a context for).
- `packages/worker/src/composition/create-trading-runtime.ts` — `createTradingRuntime`/`TradingRuntime`
  (how a boundary obtains a running core + its registry, if the boundary drives a live runtime).
- Other `packages/*` — the layout/tsconfig/package.json template for the new `@traderton/boundary` package.
- herobids `apps/api/src/plugins/auth.ts` — **reference only** (herobids's JWT auth — NOT copied; shown so
  you confirm F's HMAC boundary is genuinely different and authored fresh).
