# 028 — F: M2 REST Boundary Adapter — Proposal

**Status:** APPROVED (2026-09-07, human) — the 5 decisions in §5 are locked. Executed on branch
`f-m2-rest`, split F1/F2; merges to `main` only at the milestone (merge gate). This doc is the design
record; the F1 implementer prompt is [029](./029-F1-implementer-prompt.md).

> **Decisions locked (2026-09-07):**
> - **§5.1 = tools:invoke-only.** F is the 005 single-entry-point boundary; the per-resource
>   `_deferred-authoring/api-routes/**` are **NOT reproduced** — trading capability rides the 25 copied
>   tools; platform-table routes (`agents`/`connections`/`blueprints`/`agentRuntimeSessions`) are
>   **signed-off Gaps** (logged in 001/003).
> - **§5.2 = Postgres.** A new `boundary_invocations` table + repo + migration is the idempotency store.
> - **§5.3 = Fastify** (the HTTP server lib; the boundary itself is authored fresh).
> - **§5.4 = F1/F2 split.** **F1** = shell + HMAC auth + envelope/version validation + `tools:invoke`
>   dispatcher over `ToolRegistry` + health, scoped to **read-only tools**. **F2** = idempotency + deadline
>   + side-effecting tools + the 7 required-verification tests. F1 lands + is reviewed before F2.
> - **§5.5 = the 7 required-verification tests** (005 §"Required Verification") are the F acceptance gate.
**Item:** Phase 9b **item F** (the last 9b item) — the M2 REST boundary per
[005-consumer-boundary-contract.md](../005-consumer-boundary-contract.md). Also **level F** of the
verification/consumption roadmap ([024](../024-verification-and-consumption-roadmap.md)) — the **mandatory
shipped boundary** (trading is a REST-isolated deployable; [000](../000-vision.md)/[004](../004-decision-log.md)).
**Feeds:** 013 §8; the "Consumer boundary contract validated" cutover gate in [001](../001-parity-ledger.md); L3.
**Grounding:** read-only investigation of 005, the quarantined `_deferred-authoring/api-routes/**`, the
`ToolRegistry` dispatch surface, and herobids' auth (2026-09-07). Governed by
[AGENTS.md](../../AGENTS.md), [000](../000-vision.md), [005](../005-consumer-boundary-contract.md), [013 §8](./013-9b-authoring-plan.md).

> **F wraps the M1 in-process ports in the 005 REST contract.** It is the shipped consumption boundary
> (per the legal posture) and an **adapter over the same ports** — it must inject values, not trading
> behaviour, and must not leak HTTP/HMAC concerns into the core (000 invariant). The in-process path stays
> first-class underneath it.

---

## 1. The investigation reshaped F (read this first)

013 §8 framed F as "author the Fastify/HMAC shell **+ copy-adapt the ~10 quarantined `api-routes/**`
handlers** (`userId`→`ownerId`)." **The investigation shows that framing is substantially wrong**, in a
way that makes F *cleaner*, not harder:

- **005 is NOT a REST-per-resource API.** It is a **single execution entry point** — `POST
  /internal/v1/tools:invoke` — carrying a generic envelope (`toolName` + `payload`) with a signed
  `subject.ownerId`/`actor`, plus a status endpoint + health. There are **no** per-resource routes in the
  005 contract (`GET /bots/:id/reconciliation-events` etc. do not exist in it).
- **The quarantined `api-routes/**` are a DIFFERENT contract** — herobids's JWT-authenticated,
  REST-per-resource **control-plane** (verified: `reconciliation.ts` does `app.get('/bots/:id/...')`,
  reads `request.userId` from JWT, filters `bots.userId` — a column that no longer exists, now `ownerId`).
  They are **not** the 005 boundary and **not** how tools are invoked under 005.
- **herobids has NO 005-style boundary at all** (verified: no `tools:invoke`, no HMAC-envelope auth; its
  auth is JWT `request.userId` via `apps/api/src/plugins/auth.ts`). So **there is nothing to copy for the
  boundary** — 005 is a fresh Traderton contract. F is **authored-new**, over an already-built dispatch
  surface (`ToolRegistry`), NOT a copy-adapt of the quarantined routes.

**Consequence:** F is **mostly authored boundary machinery over the copied tools**, and the "copy-adapt 10
route handlers" work largely **does not apply** — most quarantined routes are a control-plane 005 does not
define. This raises a real scope question (§4): what happens to those quarantined routes?

## 2. What 005 actually requires F to author (verified against the contract)

A Fastify (or equivalent) app exposing exactly:
- `POST /internal/v1/tools:invoke` — the only execution entry point.
- `GET /internal/v1/invocations/:requestId` — status only; never re-executes.
- `GET /health/live`, `GET /health/ready`.

The authored machinery, all specified precisely in 005:
1. **HMAC-SHA-256 auth** over the canonical string `METHOD + "\n" + PATH + "\n" + X-Traderton-Timestamp +
   "\n" + SHA256(body)`; required headers (`X-Traderton-Consumer-Id/Key-Id/Timestamp/Signature`,
   `X-Request-Deadline-At`); header↔body `caller` match; configured consumers/keys; clock-skew window;
   constant-time compare. Fails `authentication.invalid_caller` before side effects.
2. **Envelope validation** — `TradertonToolInvocationV1` (reject unknown outer keys) → `toolName` →
   the **Traderton-owned payload schema** (`ToolRegistry.get(toolName).parametersSchema`, a Zod schema).
   Unknown tool / non-parsing payload → `validation.invalid_payload` (terminal, pre-side-effect).
3. **Authorization** — caller allowed; non-empty `ownerId`+`actor`; actor provenance valid for the tool;
   tool-specific readiness/binding prerequisites.
4. **Idempotency** — persist each side-effecting invocation **before** any side effect, keyed
   `(consumer_id, owner_id, tool_name, idempotency_key)`, storing fingerprint/requestId/correlationId/
   state/terminal-response/timestamps/expiry. Reused key + different fingerprint → `validation.invalid_payload`;
   same fingerprint → in-progress status or the original terminal result. Retention configurable
   (`boundary.idempotencyRetentionHours: 168`, not hard-coded).
5. **Deadline** — reject if `deadlineAt` already passed (pre-validation) and re-check before every
   downstream side effect → `deadline.expired`.
6. **Result mapping** — `TradertonToolResultV1` success/failure with the **closed** `TradertonBoundaryFailureCode`
   union (10 codes); preserve `retryable`; never leak credentials/raw provider responses/internal authz detail.
7. **Version compat** — path-major ↔ `contractVersion`-major; unsupported → `contract.unsupported_version`
   pre-side-effect.
8. **Health** — `/live` = process serves; `/ready` = config + persistence + boundary validation + mandatory
   deps ready.

**How it drives the M1 core (adapter-over-ports):** `tools:invoke` → authenticate → validate envelope →
`ToolRegistry.get(toolName)` → validate `payload` against `tool.parametersSchema` → build a
`TradingToolContext` (the boundary supplies `ownerId`/`actor` + the injected values a consumer owns) →
`tool.execute(payload, ctx)`. For `submit_decision`/bot-lifecycle the tool already routes through the
item-C/D drive path + `createTradingRuntime`. **F authors no trading logic — it authenticates, validates,
persists idempotency, enforces deadline, dispatches to a copied tool, maps the result.**

## 3. Idempotency persistence — a small new store (flagged)

> **CORRECTION (2026-09-08, F2 investigation — [030](./030-F2-m2-rest-proposal.md) §2, decision D1):** the
> claim below that the idempotency store is "not a copy — 005 is a fresh contract" is **partly wrong**.
> herobids DOES have an idempotency oracle — `apps/api/src/services/blueprint-idempotency.ts`
> (`computeInstantiateRequestHash`) + the blueprints fork/instantiate routes + their `*_requests` tables.
> F2 **copy-adapts** the fingerprint hasher + advisory-lock/dedupe control flow (re-keyed to the 005
> 4-tuple) and authors only the `in_progress`/status/retention/expiry deltas. Deadline enforcement remains
> genuinely authored (no oracle). See 013 §8.3.

005 requires persisting invocations keyed `(consumer_id, owner_id, tool_name, idempotency_key)` before
side effects. `@traderton/db` has **no such table** today (checked: the `decision_approvals` orphan was
deleted; nothing else fits). So F needs a **new `boundary_invocations` table + repo** (requestId,
correlationId, fingerprint, state, terminal-response JSON, timestamps, expiry). This is **authored
Traderton-owned infra for the boundary** (not trading behaviour, not a copy — 005 is a fresh contract), and
it's a migration. Flag: it's the one new persistent schema F introduces. (Alternative: a Redis-backed
idempotency store with TTL — simpler, but 005 says "persisted"; Postgres is the faithful reading. §5.)

## 4. The quarantined `api-routes/**` — disposition (the stop-gate, 013 §10)
The ~10 quarantined route files are **not** the 005 boundary. Their disposition, route-by-route:
- **Most are herobids control-plane REST** (`bots.ts` 30KB, `accounts.ts`, `analytics.ts`, `exports.ts`,
  `credentials.ts`, `backtests.ts`, `datasets.ts`, `capabilities/`, `actor-health.ts`, `reconciliation.ts`)
  — JWT + `request.userId` + per-resource paths. Under 005, **read/query capability is expressed as
  Traderton tools invoked via `tools:invoke`, not as bespoke REST routes.** Much of what these routes do is
  **already covered by the 25 copied tools** (e.g. `get_account_summary`, `get_analytics`, `list_positions`,
  `list_bots`, risk-limits, reconciliation queries). So the disposition is likely: **do NOT copy-adapt them
  as routes; their capability rides the tool surface** — and the route files are then **not needed** (a
  signed-off Gap: "herobids's per-resource control-plane REST is not reproduced; equivalent capability is
  the tool surface over 005").
- **Platform-table routes → Gap (013 §10 stop-gate):** any route referencing tables absent from
  `@traderton/db` (`agents`, `connections`, `blueprints`, `agentRuntimeSessions`) is inherently a herobids
  control-plane concern and **stays herobids / signed-off Gap** — not ported.
- **Genuinely-missing trading capability?** The one thing to check carefully: is there any *trading* query
  a consumer needs that is NOT covered by an existing tool and only existed as one of these routes (e.g.
  `bots/:id/reconciliation-events`, `exports`)? If so, that capability becomes a **new Traderton tool**
  (authored/copied into the tool surface), invoked via 005 — NOT a REST route. This is the route-by-route
  decision 013 §10 flagged; the proposal's recommendation is to enumerate them at F step 1 and classify
  each as (covered-by-tool / new-tool / signed-off-Gap).

**This is the key open decision for your steer (§5.1):** F under 005 is a *tools-over-one-endpoint*
boundary, so the quarantined per-resource routes are mostly **not reproduced** (Gap, capability via tools).
Confirm that reading, or if you intend F to also expose herobids-style per-resource REST, that's a
larger/different scope than 005 describes.

## 5. Open decisions for your steer
1. **Route disposition (the big one):** confirm F = the 005 `tools:invoke` boundary only, and the
   quarantined per-resource `api-routes/**` are **not** reproduced as routes (their trading capability is
   the tool surface; platform-table routes are signed-off Gaps) [recommended — it's what 005 specifies].
   Or do you want F to also carry a per-resource REST surface (bigger, beyond 005)?
2. **Idempotency store:** a new Postgres `boundary_invocations` table + migration [recommended — 005 says
   "persisted"] vs a Redis TTL store (simpler, weaker durability).
3. **Framework:** Fastify (herobids's framework; the quarantined routes + herobids api use it, so patterns
   are familiar and the dep is known) [recommended] vs a lighter alternative. Note: the *boundary* is
   authored fresh regardless; this is just the HTTP server lib.
4. **Scope size / sub-phasing:** F is the largest authored item (auth + envelope + idempotency + deadline
   + dispatcher + health + a migration + verification tests). Land it as one item, or split into
   F1 (shell + auth + dispatcher + health, read-only tools) then F2 (idempotency + deadline + side-effecting
   tools + the §"Required Verification" tests)? Recommend **F1/F2 split** — it lets the read-only surface
   land + get reviewed before the side-effecting/idempotency machinery.
5. **Verification:** 005 §"Required Verification" lists 7 mandatory tests (signed calls pass / bad sigs
   fail pre-exec; malformed → typed failure; deadline blocks side effects; same-key retry = one effect;
   different payload same key rejected; readiness blocks traffic; compose/staging reaches healthy ready).
   These are the F acceptance bar — authored (005 is fresh, no copy oracle). Confirm they're the gate.

## 6. Copy-vs-author (under the recommended reading)

> **CORRECTION (2026-09-08 — 030 §2, D1):** the idempotency store's fingerprint + lock/dedupe flow is
> **COPY-ADAPT** from herobids `blueprint-idempotency.ts` + the blueprints route, not authored-new. Only the
> `in_progress`/status/retention/expiry deltas + deadline enforcement are authored. See 013 §8.3.

- **AUTHORED (new — 005 is a fresh contract, no herobids equivalent):** the Fastify shell, HMAC auth
  middleware, envelope/version validation, the idempotency store (table+repo+migration) + logic, deadline
  enforcement, the `tools:invoke` dispatcher, result mapping to the closed failure union, health endpoints,
  and the 7 required-verification tests. All **boundary machinery**, not trading behaviour.
- **REUSED (copied M1 surface, unchanged):** the 25 tools + `ToolRegistry` (the dispatch target), the
  `TradingToolContext`, `createTradingRuntime` + the item-C/D drive path (what side-effecting tools call).
- **NOT reproduced (Gap, signed off):** herobids's JWT per-resource control-plane routes
  (`_deferred-authoring/api-routes/**`) — capability rides the tool surface; platform-table routes stay
  herobids. Logged as Intentional Divergence in [001](../001-parity-ledger.md)/[003](../003-anomalies-and-deviations.md).
- **Ports/invariant check:** F injects values (signed `ownerId`/`actor`, deadline, idempotency key) and
  dispatches to copied tools; it authors no risk/planner/executor logic; HTTP/HMAC concerns stay in the
  adapter, never leak into the core. ✓

On your steer (esp. §5.1 route disposition + §5.4 sub-phasing), 013 §8 becomes the self-contained
implementer brief and a `029` implementer prompt is written — then implement → review → the 005
verification tests → update 013/001/024. F is production surface (target-state) but lands on the
`f-m2-rest` branch and merges to `main` only at the milestone (the AGENTS.md merge gate).
