# Traderton — Vision & Ground Rules

**Status:** living
**Created:** 2026-09-01

## What Traderton is

Trading infrastructure for AI/LLM agents. Agents connect and trade across
segments and families — starting with crypto, later forex, commodities,
equities, and others. Access is exposed over multiple mechanisms: HTTP API
now; MCP and skills later. The domain business meaning of "trading" lives
here, not in any consuming platform.

## The end state — herobids becomes a consumer of Traderton

**This is the most important thing to understand for *classifying* code —
second only to the copy-never-author law (see AGENTS.md) — and it governs many
decisions.** We are extracting trading out of herobids so that **herobids itself
becomes a runtime consumer of Traderton.** The agent + messaging platform stays
in herobids; everything trading (bots, decisions, execution, the 25 trading
tools) moves to Traderton; and herobids invokes Traderton
(`submit_decision`, `create_bot`, `start_bot`, …), supplying an authenticated
`ownerId` + `actor`. herobids is the **first consumer**.

### Two consumption milestones — same ports, two adapters

> **HARD CONSTRAINT — trading must be a separately-DEPLOYABLE, isolable unit; the
> CURRENT deployment posture is REST-only (legal, not architectural).** Payment
> providers commonly restrict or deny trading activity. To keep that risk off the
> agent/messaging platform's payment rails, trading must be able to run as its own
> deployable — separately controllable and, when legally required, fully isolated
> from the platform (its own top-level domain / TLD, behind the REST boundary
> [005](./005-consumer-boundary-contract.md)). **Given today's legal posture,
> herobids consumes Traderton out-of-process over REST — it does NOT import
> `@traderton/*` into the shipped platform process.**
>
> **BUT this is a DEPLOYMENT/ops constraint, not an architectural law — and the
> two consumption paths must BOTH remain permanently supported:**
> - **In-process library** — `createTradingRuntime(...)` + direct calls (what L1
>   exercised). First-class; kept working forever. Used for dev/test/eval today,
>   and available as the **shipped** path the moment the legal hurdle is cleared
>   (see the latency analysis in [004](./004-decision-log.md) — in-process removes
>   the boundary's ~1–150 ms overhead).
> - **REST adapter (M2/005)** — a thin adapter *over the same in-process ports*.
>   Never the only door; never allowed to leak REST-only concerns (HMAC/HTTP
>   envelopes) into the core.
>
> So: **support both; let DEPLOYMENT decide.** REST-only is how trading *ships
> today* for legal isolation; in-process stays a supported, tested path so we
> preserve the future option to plug trading in-process (e.g. for latency) if the
> legal constraint lifts. See [004](./004-decision-log.md) ("Why trading is an
> isolable, REST-first-but-in-process-capable deployable"). **Consequence for the
> milestones below:** M1 (in-process) is BOTH the Traderton-internal
> assembly/verification milestone AND a permanently-supported consumption path — it
> is only *not the shape herobids ships in today* (a legal, revisitable posture),
> not a forbidden one.

herobids consumes Traderton through **the same set of ports** (the extraction
seams — hexagonal architecture). What changes between milestones is only the
**adapter** driving those ports:

- **M1 — In-process library assembly (reached FIRST; a permanently-supported
  consumption path).** The extracted `@traderton/*` packages are wired into a whole,
  runnable trading library driven in one process via dependency injection / ports &
  adapters. This is where the bulk of the extraction lands (Phases 8–10 / 9b items
  A–E) and where consumability is *verified* in-process (L1,
  [024](./024-verification-and-consumption-roadmap.md)). The in-process caller
  injects the things Traderton does not own (a resolved `venueAccountId`,
  `ownerId`/`actor`, the `maxBots` limit) as values. **This path stays first-class
  and supported forever** — used for dev/test/eval today, and available as the
  *shipped* path if the legal posture lifts (the hard-constraint block above). It is
  only *not the shape herobids ships in today* (legal isolation), not a forbidden
  one. No REST/API layer is built for M1.
- **M2 — API consumer (the end state; the ONLY shape herobids consumes in).** The
  REST/API boundary ([005-consumer-boundary-contract.md](./005-consumer-boundary-contract.md))
  is added as a **second adapter over the same ports** — its request/response, auth,
  deadline, and idempotency semantics are the HTTP expression of the M1 ports. This
  is the boundary herobids (and any consumer) calls across the network; MCP/skills
  wrap the same boundary later still (decision 6). The "consuming platform" that 005
  speaks of *is herobids*; 005 describes the M2 adapter — **and per the legal
  constraint, M2 is mandatory, not optional: it is the cutover boundary.**

Load-bearing consequence: because M1 (in-process) is reached first, the extraction
and its in-process verification require **no authored boundary/API code** — the
harness injects what a consumer would own and calls the core directly. Authoring
(the per-owner `maxBots` enforcement, the REST/005 layer) is **deferred to after M1
lands and a holistic review**, then built as the M2 adapter. This two-milestone
framing lets us honor "defer authoring to the end" without leaving any trading
capability behind — while keeping in view that **the REST/M2 boundary is the
required cutover shape, because trading cannot ship inside the platform.**

> **Ports carry values, never trading behaviour (invariant).** A consumer (herobids
> at M1, any caller at M2) may inject through a port only the platform-owned things
> Traderton does not own — a resolved `venueAccountId`, grant/connection validity, the
> `maxBots` limit decision, an authenticated `ownerId`/`actor`. A port must **never**
> let the consumer inject *trading behaviour*: the risk gate, planner, executors,
> reconciliation, fill/position accounting are Traderton's and are not overridable
> through a seam. If a proposed port would carry trading logic, the seam is mis-drawn —
> that is the copy-never-author law asserting itself at the boundary.

The load-bearing implication for decisions:

> When a trading capability is currently implemented in herobids in a
> platform-coupled way, "it stays platform" is only half the story. Ask the
> second question: **in the end state, will herobids rely on Traderton to
> provide this capability?** If yes, then the *herobids implementation* may be
> Intentional Divergence (a relocated concern, not copied), but the *Traderton
> counterpart is a REQUIRED parity obligation* — herobids-on-Traderton must not
> be weaker than herobids-today. Such a capability is **Deferred-but-required**
> (see the Deferred distinction below and in
> [004-decision-log.md](./004-decision-log.md)), not optional backlog.

Concretely: a relocated concern (e.g. per-agent bot-limit enforcement, keyed on
the platform `agents` table) is not copied — that specific implementation is
platform. But the *capability* (limit-enforced bot creation via `create_bot` /
`start_bot`) is trading, is owned by Traderton, and herobids will depend on it.
So it is a required Traderton capability, deferred to the phase that builds
Traderton's bot lifecycle (where the limit *key* — per-owner, per-venue-account,
operator config — is decided), and it must land before cutover.

### Two kinds of Deferred

- **Deferred (optional):** a genuinely new/nice-to-have Traderton capability with
  no herobids parity obligation (e.g. bot cloning). May never be built without
  harm.
- **Deferred (required for cutover):** a trading capability herobids relies on
  Traderton to provide in the end state. Deferred only in *when* it is built, not
  *whether*. Blocks cutover until met (cross-reference the affected tool/subsystem
  in the ledger so the cutover gate cannot pass without it).

## How we are building it

Traderton is extracted from an existing, working system
(`../../herobids` relative to this doc, the `herobids` monorepo) where
trading is currently fused with an agent + messaging platform. We are **not
rewriting trading from scratch.**

### The core principle — copy, never author

> Every line of trading behaviour in this repo must arrive by being **copied**
> from the source system, never by being **authored**. The only things we
> author are **deletions** and the **thin seams** where platform couplings are
> cut.

Rationale: rewriting from scratch makes an agent reproduce behaviour from its
*model* of what the code should do, silently omitting hard-won detail (edge
cases, ordering, venue quirks) and then writing tests that assert the omitted
version — green tests, real regression. Copy-and-delete starts from real
behaviour with all detail present, so the job becomes *removal* (visible: a bad
delete breaks the build/tests) instead of *creation* (invisible omissions).

### The method — copy, then delete, then stub seams

1. Copy the trading-relevant subtree verbatim; get it compiling as a copy.
2. Bring the existing tests across unmodified — they are the parity harness.
3. Delete leaves first, roots last. Build + run tests after every deletion.
4. Cut platform seams by stubbing to the narrowest thing that returns what the
   real dependency returned; verify green; only then thin it.
5. Payments: delete cleanly, do not reimplement. Ledger it as Deferred.

**Discipline:** after every delete, the build compiles and the copied tests
pass. When they don't, we've found a real dependency or cut a seam wrong — fix
it there, with full local context, before moving on.

## Verification standard — parity, not liveness

"Does it run?" is necessary but insufficient. The bar is **feature parity with
the source system.** The source repo is the specification. We may **improve**,
we must not **degrade**. Anything we cannot preserve now is recorded in the
[Parity Ledger](./001-parity-ledger.md) — nothing is silently dropped.

## Settled decisions

1. **Own database.** Traderton owns its trading data in its own store. No shared
   schema with the source platform; cross-boundary foreign keys become soft
   references validated at the boundary.
2. **Own config.** Traderton owns its domain config schema and validation
   (operator + instance layers). Consuming platforms do not compile in trading
   config types.
3. **Own risk enforcement.** The trading risk gate and its hard invariants live
   here. User-configured limits remain immutable at runtime; operator defaults
   remain adjustable within operator bounds.
4. **No backward-compatibility obligations in Traderton's surface.** Fresh
   start. We drop deprecation aliases, route-migration matrices, and "don't
   rename persisted fields" constraints. Name things right the first time.
   We still require equivalence validation before traffic cutover; that is
   proof discipline, not a public-API compatibility promise.
5. **Traderton-native usage metering, payments, and caps are deferred.**
   Platform billing authority stays outside Traderton by design; any
   Traderton-owned usage metering, billing, or caps are cut for now and
   tracked as Deferred in the ledger.
6. **In-process assembly (M1) first, REST/API (M2) second, MCP/skills later —
   both consumption paths permanently supported; deployment decides which ships.**
   M1 (the in-process library / ports-and-adapters state) is reached first: the
   extraction proves itself in one process, and this in-process path **stays a
   first-class, supported consumption mode forever** (dev/test/eval today; a shippable
   option if the legal posture lifts). The REST/API boundary (M2) is a later **thin
   adapter over the same ports** and is **the shipped shape today** — per the legal
   posture (hard-constraint block above), trading ships as a separately-deployable,
   REST-isolated unit, so **herobids's shipped consumption is over M2.** This is a
   deployment choice, not an architectural one: the core stays importable in-process;
   REST never becomes the only door and never leaks HTTP concerns into the core. MCP
   and skills wrap the same M2 boundary later still. None of the outer adapters block
   the M1 assembly. See the hard-constraint block in "The end state" +
   [004](./004-decision-log.md) ("Why trading is an isolable, REST-first-but-in-process-capable
   deployable").

### Toolchain & naming

16. **Mirror herobids toolchain exactly:** Node ≥22, pnpm monorepo, TypeScript
    `strict: true`, ES2022, ESM only. Copied code must compile unchanged; do
    not upgrade versions during extraction.
17. **Rename `@herobids/*` → `@traderton/*` from the start.** Fresh repo, no
    history to protect — get the namespace right on day one rather than
    sweeping imports twice.

### Actor & intelligence model

7. **Bots are mechanical trading actors.** They belong to the trading layer and
   move to Traderton. A bot runs a deterministic strategy (`mechanical`, `dca`)
   and submits decisions; it does not reason.
8. **Intelligence is the agent's job, not the bot's.** LLM-driven decision
   making (`LlmStrategy`, `HybridStrategy`) is *reasoning* and stays agent-side
   on the consuming platform. The agent reasons, then calls Traderton's
   `submit_decision`. Mechanical intelligence (scanner, regime — indicators
   only, no LLM) is fine for bots and moves to Traderton.
9. **`llm` stays agent-side.** Traderton is mechanical and carries **no**
   `@herobids/llm` dependency and no LLM cost center. The `strategy` package is
   **split**: mechanical parts (`Dca`, `Mechanical`, `scan-engine`, `regime`)
   move to Traderton; LLM parts (`Llm`, `Hybrid`, `llm-provider`) stay
   agent-side.

### Ownership & seam (from source-code investigation)

10. **Traderton is multi-tenant but not the identity/platform-billing
   authority.** It accepts an authenticated `ownerId` + `actor` at the
   boundary; it does not manage users or platform billing. User management and
   platform billing are Intentional Divergence, not parity gaps.
11. **Seam sits between `connections` and `venue_accounts`.**
    - Stay platform: `users`, `connections`, `agent_connections`, `agents`.
    - Move to Traderton: `venue_accounts`, `user_credentials`, `bots`.
12. **Credential custody follows the venue caller → Traderton.** Traderton
    holds `venue_accounts` + `user_credentials` because it makes the venue calls.
13. **`bots` re-pointed to soft fields:** `bots.userId` → soft `ownerId`;
    `bots.connectionId` → `venueAccountId` (the connection indirection is
    platform-only and is dropped inside Traderton).
14. **`blueprint.ts` stays platform**, but its risk/execution/token-safety
    schemas are a within-file seam Traderton copies for config ownership.
15. **market-assessment splits:** copy the domain/analysis into Traderton; leave
   platform orchestration + platform-side billing behind. Traderton-side usage
   metering remains Deferred. `documents` stays platform.

### Source-fix requests

When the cleanest seam requires reshaping the source, Traderton may **request** a
behaviour-preserving change in herobids — never editing herobids directly. The
owner makes, tests, gates, and releases the change in herobids; Traderton then
copies from the improved source. Requests must be behaviour-preserving
(validated by herobids' existing tests) — they may not alter trading behaviour;
a behaviour change is a product decision, not a copy-enablement request. Log each
request and the resulting herobids version in
[003-anomalies-and-deviations.md](./003-anomalies-and-deviations.md). Prefer a
clean in-Traderton deletion when one exists; reserve source requests for seams a
deletion cannot cut without authoring non-trivial logic. Rationale is in
[004-decision-log.md](./004-decision-log.md).

## Deviation discipline

If preserving parity would require authoring **non-trivial logic** (not just a
narrow stub), stop and log it in
[003-anomalies-and-deviations.md](./003-anomalies-and-deviations.md). Do not
improvise a fix to make a build go green — a silent authored fix is the exact
failure mode this project exists to avoid. Deliberate up-front design decisions
belong in this doc + the ledger, not the anomalies log.

## Open (decide when we reach them)

- The backend→consumer event/streaming channel (fills, marks, position deltas).
- Venue/execution cost reporting across the boundary (note: with decision 9,
  Traderton has no LLM cost center).

## Documents

- [001-parity-ledger.md](./001-parity-ledger.md) — progress + parity tracking.
- [002-phase-0-subtraction-plan.md](../archive/002-phase-0-subtraction-plan.md) — copy /
  delete / seam plan.
- [003-anomalies-and-deviations.md](./003-anomalies-and-deviations.md) — logged
  deviations discovered during copy-and-delete.
- [004-decision-log.md](./004-decision-log.md) — reasoning behind the
   decisions in this doc.
- [005-consumer-boundary-contract.md](./005-consumer-boundary-contract.md) —
   the request / response, auth, deadline, and idempotency contract consumers
   use to call Traderton.
- [006-source-capability-manifest.md](./006-source-capability-manifest.md) —
   the exhaustive source capability inventory that the parity ledger tracks.
- [007-operational-readiness.md](./007-operational-readiness.md) — latency,
   equivalence, restart-resilience, and cutover proof for moving traffic to
   Traderton.
- [008-phase-1-scaffold-and-domain-slice.md](../archive/008-phase-1-scaffold-and-domain-slice.md)
   — the Phase 1 implementation slice (domain). **Done.**
- [009-extraction-roadmap.md](../archive/009-extraction-roadmap.md) — the outer roadmap for
   Phases 2–10 (db, engine, market-data, venues, mechanical strategy, backtesting,
   worker, api, infra): sequence, scope, stop-gates, and the per-phase pattern for
   autonomous coordinated execution.
