# Trading Service Split — Decision Record

> **Purpose.** This document captures the analysis and decisions from a contemplation
> session about splitting the `herobids` monorepo into two separate systems: an
> isolated **trading** service and the **agent platform** (everything else). It is
> written so another LLM agent (or a human) can review the reasoning and continue
> the work without needing the original conversation.
>
> **Status.** Contemplation / decision-capture only. No code has been changed.
>
> **Scope note (important).** This record documents the *full* design discussion,
> including forward-looking product ideas (auth models, prepaid wallets, billing,
> execution-mode scopes). A later scope correction from the stakeholder clarified
> that the **immediate goal is a mechanical extraction only — copy, delete, make it
> work — with no new features.** That correction is NOT captured here (it came after
> the cut-off point requested for this document). Anyone acting on this document must
> treat the auth/billing/wallet/API-redesign material as **deferred future work**,
> not part of the split itself. See "How to read this document" below.

---

## How to read this document

The decisions fall into two tiers:

1. **Extraction decisions** — what physically moves where, how the shared
   foundation is handled, and where the one unavoidable seam is. These are the
   decisions relevant to a copy/delete/make-it-work split.

2. **Future product decisions** — how the isolated trading service should
   authenticate agents, authorize actions, and bill them. These were discussed in
   depth and are recorded for completeness, but they are **deferred** and must not
   be built as part of the split.

Each decision lists the **decision**, the **reasoning**, and where relevant the
**evidence from the codebase** that grounds it.

---

## Background & goal

- The repo hosts many layers: agents, LLM, billing, trading, web, worker, API, etc.
- The stakeholder wants to split it into **trading** and **everything else (the agent platform)**.
- Driver: **legal constraints.** Trading is an *external capability*; messaging and
  similar are *internal capabilities*. The separation must be real, not cosmetic.
- Target end-state (stakeholder-confirmed):
  - Trading lives on its own TLD (referred to as `traderton.com` in discussion),
    its own server, its own auto-scaling.
  - **Two fully separate repos** — separate config, database, Redis, everything.
  - Trading keeps **no LLM code** at all.
  - Trading is **targeted at AI agents, not humans** as its clients.
  - Nothing is in production yet — **no data to migrate**; a clean cutover is possible.

---

## Repository analysis (facts established)

### Package dependency graph (internal `@herobids/*` deps)

```
domain        → (no internal deps)     [foundational]
llm           → (no internal deps)     [foundational]
market-data   → domain
engine        → domain                  ← pure, agent-agnostic trading core
venues        → domain, market-data     ← trading infra
strategy      → domain, llm, market-data ← LLM-assisted (belongs to agent platform)
backtesting   → domain, engine          ← trading
db            → domain
documents     → db, domain

apps/api      → backtesting, db, documents, domain, engine, llm, venues
apps/worker   → backtesting, db, documents, domain, engine, llm, market-data, strategy, venues
apps/web      → domain only
```

### Key structural findings

- **`engine` is a clean, agent-agnostic trading core.** It exposes an injectable
  API (`submitDecisionForExecution`, `runTradingCycle`, `checkRisk`, executors,
  reconciliation, position/order/fill trackers) via dependency injection. It
  imports only `domain`. It has **no knowledge of agents, users, or billing.**
- **The coupling is entirely on the agent side.** `apps/worker/src/agents/agent-intake-resolver.ts`
  imports from `@herobids/engine` and `@herobids/db`, resolves an
  agent → connection → venue-account binding, and hands DI deps to the engine.
  The engine never imports agent code. This is the natural seam — but today it is
  an **in-process function call**, not a network boundary.
- **Trading and agentic/billing concerns are file-level interleaved** inside the
  shared packages `domain` and `db`, and inside `apps/api` / `apps/worker`. Example
  fused files in the worker: `agent-trading-actor.ts`, `hybrid-agent-evaluator.ts`,
  `hybrid-decision-sizing.ts`, `agent-risk-limits.ts`, `tools/trading.ts`. These
  are "agent-owns-trading," i.e. the agent side reaches *into* trading.
- **The DB actor model is already a boundary.** `positions` and `decisions` key on
  `actorType` + `actorId` as **plain string columns with no foreign keys** to
  `agents`/`users`/`bots` (comments explicitly note "tradingInstanceId REMOVED —
  positions are actor-scoped"). The trading tables reference actors by opaque
  identifier, not by DB relation.
- **`connections` is the single grantable join point.** `connections.resolvedVenueAccountId`
  maps an agent/user to a `venue_account`; it is null for non-trading connections
  (telegram, twitter). The actor concept `agent | bot | user | system` was already
  designed as a boundary between the two worlds.
- **`venue_accounts` is the one real trading→user coupling:** `venue_accounts.userId → users`
  and `credentialId → user_credentials`. This is a small, well-defined seam
  (ownership + secrets).
- **Current auth** (`apps/api/src/plugins/auth.ts`): HS256 JWT with a **symmetric
  shared secret**, plus a DB-backed session check on every request. A symmetric
  secret cannot safely cross a trust boundary into a legally separated service.
- **Async event propagation today** uses Redis: `UserEventPublisher` (pub/sub,
  channel `events:<userId>`) for UI events like `order.filled` / `decision.accepted`,
  and Redis Streams (`agent:outbound:<agentId>`) for the durable agent protocol.
- **The agent protocol is already machine-oriented** (`packages/domain/src/agent-protocol.ts`):
  `submit_decision`, `decision.accepted`, `execution.result`, etc. — designed for a
  program, not a human clicking a UI.

---

## DECISIONS

### D1 — Extract *trading* into the new repo; the agent platform keeps everything else

**Decision.** Pull the trading subsystem out into the new (trading) repo. The
existing repo remains the agent platform.

**Reasoning.**
- Trading is the cohesive, self-contained subsystem. The core (`engine`) plus its
  infra (`venues`, `market-data`) plus `backtesting` depend only on `domain` and each
  other, with zero references to agents/users/billing.
- The agent platform is the **consumer**: agent → `submit_decision` → engine intake →
  risk gate → executor. Trading does not consume the agent runtime.
- Removing the agent layer means *deleting callers*; removing trading would mean
  *surgically gutting* trading references out of dozens of fused agent files. The
  first follows the grain of the dependency graph; the second fights it.

**This reverses the naive framing.** "Which is easier to remove?" — trading is the
easier thing to *extract cleanly*, because it is already the leaf of the dependency
graph and behind an injectable API.

---

### D2 — `strategy` stays with the agent platform, not trading

**Decision.** The `strategy` package remains in the agent-platform repo.

**Reasoning.** `strategy` depends on `llm`, and trading keeps no LLM. Strategy is
"LLM-assisted decision-making," which is the agent's job. Trading receives
already-formed decisions (`submit_decision` semantics) and executes them
mechanically — consistent with the engine's actual API (`submitDecisionForExecution`
takes a decision + context, not a strategy).

---

### D3 — Trading owns venue accounts and venue secrets (Model A) — **stakeholder-confirmed**

**Decision.** The trading repo stores venue accounts and encrypted venue
credentials. The agent platform holds only a reference/grant. (In the later
`traderton.com` framing, the agent "creates a wallet" on the trading portal — this
is consistent: the wallet/venue account lives on the trading side.)

**Reasoning.**
- Matches the legal driver: venue keys and trading data live only in the trading
  repo, physically separate from the agent platform.
- Matches the engine's design: reconciliation, journal, and balance snapshots all
  assume persistent venue-side state.
- The rejected alternative (Model B — agent platform owns secrets, passes them
  per-call) is weaker for legal isolation and awkward for reconciliation.

---

### D4 — The cross-service identity is the existing `(actorType, actorId, venueAccountId)` contract

**Decision.** The trading boundary is keyed on the existing opaque actor identity.
The agent platform sends `actorType='agent', actorId=<agentId>` plus a
venue-account/grant reference.

**Reasoning & evidence.** Trading tables (`positions`, `decisions`, `fills`) already
key on `(actorType, actorId, venueAccountId)` with **no foreign keys** to agent
tables. This means **no FK migration is needed on the trading side** — the single
biggest de-risker. The actor model was already designed as a boundary.

---

### D5 — Two separate repos, each self-sufficient (no shared runtime dependency)

**Decision.** Fully separate repos with separate DB, Redis, config, and server, per
stakeholder constraint. Each repo carries its own copy of the foundational layer it
needs.

**Reasoning.** "Separate everything" is the stated requirement, reinforced by the
legal driver. A shared published package would be a standing coupling (shared
release cadence, lock-step upgrades) that undercuts the separation.

---

### D6 — Split `domain` and `db`; trading gets its own slices

**Decision.**
- **Trading repo** gets a new `trading-domain` (trading value objects
  `Quantity/Price/OrderId/FillId`, `result.ts`, trading ports: `venue.ts`,
  `mark-source.ts`, `swap-venue.ts`, `token-safety.ts`, `candle-fetcher.ts`,
  `economic-calendar.ts`, `sentiment.ts`) and a new `trading-db` (schema:
  `positions`, `orders`, `fills`, `decisions`, `execution-plans`, `venue-accounts`,
  `instruments`, `journal-events`, `reconciliation-events`, `balance-snapshots`,
  `decision-contexts`, `decision-approvals`, `decision-failures`,
  `token-safety-overrides`, `backtest-runs`, `replay-*`, `datasets`).
- **Agent-platform repo** keeps `domain` (minus trading slice), `db` (minus trading
  slice), `llm`, `strategy`, `documents`.

**Reasoning.** Both `domain` and `db` currently interleave the two concerns. The
trading slice is a cohesive cluster (few inbound FKs from the billing/user side),
which makes it the cleaner thing to pull out.

---

### D7 — Shared kernel: duplicate a small frozen kernel per repo + a versioned API contract

**Decision.**
- Duplicate a **small, stable "shared kernel"** (branded types, `Result`/`ok`/`err`,
  decimal helpers) into each repo rather than publishing a shared package.
- Enforce boundary sync via a **versioned API contract** (schema-first:
  OpenAPI/JSON-schema or a generated client), which is the single source of truth
  for the wire types.

**Reasoning.** The shared surface is tiny and essentially never changes; duplicating
a few hundred lines is cheaper than owning cross-repo package plumbing forever, and
it honors the legal-separation intent. Contract drift is handled at the narrow API
boundary, not by sharing code.

**Note.** This is a *future/product* concern to the extent it implies a network API
contract. For the pure extraction, only the "duplicate the kernel" half is needed to
make both repos compile.

---

### D8 — The one unavoidable seam: `AgentIntakeResolver` → engine

**Decision.** The in-process call `submit_decision` → `AgentIntakeResolver` → engine
cannot survive a two-repo split unchanged. On the agent-platform side,
`AgentIntakeResolver` must become a thin adapter/client instead of constructing
`DecisionIntakeDeps` locally and calling the engine directly.

**Reasoning.** The engine physically leaves the agent-platform repo, so the direct
import breaks. This is the only code location that *must* change (beyond
moving/deleting files) to make the split work.

**Open scoping question (unresolved at cut-off).** How far to go at this seam for
"make it work":
- (a) **Bare minimum to compile/green** — stub/adapter behind the existing interface
  so the agent-platform repo builds and its tests pass; real cross-service wiring
  deferred.
- (b) **Minimal working call** — a thin HTTP client + thin trading endpoint so a
  submitted decision actually reaches the engine across repos.

The author leaned toward (a) as truest to copy/delete/make-it-work, but flagged it
as a stakeholder decision. **This is the key decision to resolve before planning the
extraction.**

---

## FUTURE / DEFERRED PRODUCT DECISIONS

> Everything below was discussed as target-state product design. It is **NOT part of
> the mechanical split** and must not be implemented until after copy/delete/make-it-work
> is complete and green. Recorded for continuity.

### F1 — Trading targets AI agents, not humans

The isolated trading service's clients are autonomous agents. This invalidates
human-session assumptions (magic links, OAuth redirects, browser-only WebSocket
auth, short-code human approvals). Trading is a programmatic API for machine
principals.

### F2 — Agent onboarding lifecycle (stakeholder's worked example)

An agent: **registers** on `traderton.com` → **gets credentials** → **logs in** →
**creates a wallet** → **asks its human to fund the wallet** → **trades** (with or
without the human's own approval policy). This describes agents as **first-class
account holders** on the trading portal (a "direct agent client" model), i.e. the
trading service has its own native onboarding.

### F3 — Two orthogonal concepts that must NOT be conflated

The author initially conflated these; the stakeholder corrected it. They are
unrelated and live on different sides:

1. **Agent action-approval (agent-platform concern).** A human tells *their agent*
   "ask me before sensitive actions" (delete files, trade, change config, etc.).
   This is a generic property of the agent's own behavior, configured by the agent's
   owner, enforced in the agent runtime **on the agent platform**. The current
   Telegram short-code flow is one implementation. Trading knows nothing about it.

2. **Trading authorization (trading-service concern).** When an agent submits a
   trade, the trading service decides whether *this principal* may perform *this
   trading action*. Not "did your human approve you" — "are you a valid, funded,
   permitted trading principal here."

**Rule: do not couple these, even though they seem related.**

### F4 — Authentication (future): trading as a resource server, machine credentials

- Trading should be a **resource server** (validate tokens, reject anything not
  issued for it), not an identity provider — aligned with the ratified MCP model
  (OAuth 2.1, roles kept strictly apart; resource server never mints tokens).
  Sources: [MCP authorization spec](https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization),
  [WSO2 MCP auth](https://wso2.com/api-platform/learn/mcp-server-authentication/).
  *Content rephrased for compliance with licensing restrictions.*
- Use **machine credentials** (OAuth2 client-credentials / signed JWT assertions /
  per-agent scoped API keys), short TTLs, programmatic rotation and revocation — not
  the current symmetric-secret human JWT+session stack. Ecosystem guidance: human
  OAuth and long-lived env-var keys were not designed for non-deterministic agents
  that fire many calls per minute (wide blast radius on token theft). Sources:
  [Auth0](https://auth0.com/blog/why-ai-agents-need-their-own-permission-model/),
  [WorkOS](https://workos.com/blog/developers-guide-to-ai-agent-authentication-and-authorization),
  [Scalekit](https://www.scalekit.com/blog/oauth-vs-api-keys-for-ai-agents).
  *Content rephrased for compliance with licensing restrictions.*
- **Two models, start simpler, build the core to support both:**
  - Model A (platform-brokered service identity) — the agent platform vouches for
    its agents via an asymmetric service token carrying the actor claim.
  - Model B (direct agent client) — external agents are account holders with their
    own credentials + wallet lifecycle.
  - The stakeholder's `traderton.com` example is **Model B**, which reframes B as the
    *primary* product surface and A as a secondary path for in-platform agents. Build
    the authz core as `verify token → principal → (optional) grant/scope check` so
    the second model drops in additively.

### F5 — Authorization (future): mostly authentication does the work

- For trading, if a principal is authenticated and **funded**, "can it trade?" is
  essentially "yes — that is the product." There is no rich permission matrix over
  the primary verb.
- Mandatory gates: **authentication**, **funding/prepaid balance**, and the
  **engine risk gate** (hard safety invariants — malformed payloads, unreconciled
  state, user-configured limits). None of these is RBAC-style trading authorization.
- The one genuine trading authorization is **execution mode**: `trading:paper` /
  `trading:shadow` / `trading:live` (real-money vs not).
  - **Phase one:** execution mode is a property of the wallet/account (a live wallet
    trades live, a paper wallet trades paper). No separate permission system.
  - **Phase two (additive):** promote execution mode (and future capabilities like
    allowed venues, notional tiers, instrument classes) into explicit **scopes** on
    the credential. This is the "trading keeps its own authorizations" path — kept
    entirely separate from F3.1 (agent action-approval).

### F6 — Billing (future): prepaid, metered per action — **stakeholder-confirmed prepaid**

- **Prepaid** balance held at the **principal** level in the trading service's own DB.
- Metered debits per billable action (decisions, executions, notional, backtests,
  API calls), reusing the shape of the existing `billing-usage-events` + ledger and
  `cost-profile` machinery (copy, not share).
- Enforced **at the auth edge**: insufficient balance → reject before the engine sees
  the request (HTTP **402 Payment Required**).
- **Principal granularity decision:** model **both** levels — `principalId` (owner/
  account) holds credentials + prepaid balance; `actorId` (agent) is used for
  attribution + per-agent sub-quotas. Rationale: existing tables already carry
  `actorId` (per-agent usage reporting is free), while money/credentials naturally
  belong to an owner ("I topped up $500, all my agents draw from it"). Watch out for
  a runaway agent draining a shared balance — hence per-agent sub-quotas.
- **x402** (Coinbase/Cloudflare HTTP-402 stablecoin per-request payments) is noted as
  a *future* Model-B option for pay-per-call by unknown agents with no onboarding;
  conceptually aligned since the prepaid edge check already returns 402. Sources:
  [Coinbase x402](https://docs.cdp.coinbase.com/x402/how-it-works),
  [Cloudflare Agents x402](https://developers.cloudflare.com/agents/agentic-payments/x402/),
  [Zuplo — charge agents for MCP tool calls](https://zuplo.com/blog/charge-agents-for-mcp-tool-calls).
  *Content rephrased for compliance with licensing restrictions.*

### F7 — Async fills feedback channel (future)

Standard pattern recommended: **durable outbox on the trading side + signed webhooks
to the platform + a polled read API as reconciliation fallback**. Rationale: fills
arrive asynchronously from venues and must not be lost; Redis is no longer shared, so
the current in-process/shared-Redis path cannot cross the boundary. The platform's
webhook handler would re-publish into the existing `UserEventPublisher` / agent
outbound streams, keeping the UI/agent consumers unchanged. A message queue was
rejected because it implies shared broker infra, contradicting "separate everything."

### F8 — Gated / paid skills (future, agent-platform side)

Confirmed a real category (marketplaces with revenue splits; feature-gating skills
that check entitlements before premium capabilities run). Sources:
[MintSkills](https://www.mintskills.ai/),
[Flowglad feature-gating skill](https://lobehub.com/skills/flowglad-flowglad-feature-gating).
*Content rephrased for compliance with licensing restrictions.* In this codebase the
raw material already exists (`skills`, `skill-entitlements`, `skill-usage-events`,
`skill-revisions`, `ExternalSkillProvider`). "Gated skills" = entitlement checks +
usage metering on skills, living on the **agent-platform** side (skills are an
internal capability). Same `principal + entitlement + metered usage` mechanism as
trading's gate, but distinct system.

---

## Target end-state (summary of the confirmed direction)

**Trading repo (`traderton`):**
- Packages: `engine`, `venues`, `market-data`, `backtesting`, new `trading-domain`,
  new `trading-db`.
- The trading execution/actor runtime lifted out of `apps/worker` (e.g.
  `execution-actor.ts`, `trading-actor.ts`, `venue-adapter-factory.ts`, stream pool,
  reconciliation runtime, `swap-*`, `tick-gates`, mark sources).
- A new thin trading app (future: the trading API with its own auth/billing).
- Owns wallets/venue accounts, venue secrets, and (future) prepaid balances + its own
  billing DB.
- Keyed on `(actorType, actorId, venueAccountId)` — no FK migration.

**Agent-platform repo (existing):**
- Keeps `domain` (minus trading slice), `db` (minus trading slice), `llm`,
  `strategy`, `documents`; `apps/api`, `apps/web`, `apps/worker` (minus trading
  runtime).
- Keeps the generic agent action-approval policy (F3.1).
- `AgentIntakeResolver` becomes a trading client/adapter (see D8 for scope).
- (Future) a `/trading/events` webhook receiver that re-publishes fills into the
  existing `UserEventPublisher` / agent streams.

**Cross-cutting:** duplicated frozen kernel per repo + versioned API contract; clean
cutover (no prod data to migrate).

---

## What is settled vs. open (for the next agent)

**Settled (extraction):** D1–D7 (what moves where, how the foundation splits, the
kernel/contract strategy, actor-identity boundary, Model-A venue-account/secret
ownership).

**Open (extraction) — must resolve before planning:** D8 scope — (a) stub/adapter to
compile-and-green vs (b) minimal working cross-repo call.

**Deferred (do not build during the split):** all of F1–F8 (auth models, wallet
onboarding, authorization scopes, prepaid billing, x402, webhooks-vs-polling, gated
skills).

> Reminder for the next agent: a later stakeholder correction (not captured above by
> request) made explicit that the immediate task is **copy → delete → make it work,
> with no new features.** Treat F1–F8, and the "network API" reading of D7/F7, as
> future work. When in doubt, prefer the smallest change that leaves both repos
> building and green.
