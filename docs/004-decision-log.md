# Decision Log — the *why* behind the decisions

**Status:** living
**Purpose:** capture the reasoning behind the decisions in
[000-vision.md](./000-vision.md), so a future agent (or human) has the judgment
to handle edge cases the same way — not just the rule, but why the rule exists.

Read this when a decision seems arbitrary or when you hit a case the rules
don't obviously cover. The reasoning tells you which way to lean.

---

## Why extract at all

Trading was fused into an agent + messaging platform through four seams: a
shared database schema, shared streaming infra, shared config, and a shared
risk gate. Attempts to draw a clean tool-invocation boundary (the herobids
`docs/features/pending/000-capability-foundations` set) specified the
request/response tool contract well but left the *data*, *streaming*, *config*,
and *risk-gate authority* seams unowned. Trading is also becoming its own
product (own TLD, external API/MCP/skills for other agents), which justifies a
separate repo rather than internal decoupling.

## Why copy-and-delete, not rewrite-from-scratch

Prior experience: rewriting a large system from scratch with an LLM agent lost
features and never reached parity — the larger the task, the more the agent
"filled in" plausible behaviour and omitted hard-won detail, then wrote tests
asserting the omitted version (green tests, real regression).

Copy-and-delete inverts this. Starting from real, working code means behaviour
is present with all its detail; the agent's job becomes *removal* (visible: a
bad delete breaks the build/tests) instead of *creation* (invisible omissions).
Hence the core rule: **copy, never author.** The only authored things are
deletions and thin seam-stubs.

## Why parity, not "does it run"

Liveness ("it boots") is a weak bar — a trading system can run and silently do
less (fewer venues, a weaker risk gate, a dropped edge case). The source repo
is the specification; we may improve but not degrade. The parity ledger makes
every source capability either Met / Improved / Deferred / Gap / Intentional
divergence — nothing is silently dropped. Copy-and-delete makes this cheap:
we start at 100% parity and only account for *subtractions*.

This is also why equivalence or shadow validation still matters during cutover.
Decision 4 in [000-vision.md](./000-vision.md) rejects public compatibility
debt such as alias routes and legacy field names; it does **not** relax the
proof bar. We still need side-by-side evidence that Traderton behaves like the
source before moving traffic.

## Why the anomalies log exists

The dangerous moment in copy-and-delete is hitting something broken or a seam
that resists a narrow stub. An agent's instinct is to author a fix to make the
build green — which is the exact silent-rewrite failure we're avoiding. The
anomalies log converts that into a visible, reviewable decision: stop, log,
surface. Deliberate up-front decisions do NOT go there — only mid-extraction
forced deviations.

## Why the seam sits between `connections` and `venue_accounts`

Traced the full chain: `user_credentials` → `venue_accounts` → `connections`
→ `agent_connections` → `agents`.

- `connections` is the platform's **single grantable entity** and is general —
  it also covers telegram/twitter, not just venues. So it (and
  `agent_connections`, `agents`, `users`) is platform identity/grant → stays.
- `venue_accounts` + `user_credentials` only make sense for venues Traderton
  actually calls. **Credential custody follows the venue caller** → they move
  to Traderton.

So the cut is between the grant layer (platform) and the venue-execution
identity (Traderton). `bots.userId` → soft `ownerId`; `bots.connectionId` →
`venueAccountId` (the connection indirection is platform-only; Traderton binds
bots directly to the venue account it already references).

## Why Traderton is multi-tenant but not the identity/billing authority

Feature parity says "reproduce everything," but the point of the split is that
trading no longer *owns* users or billing. You can't have both. Resolution:
Traderton stores an opaque `ownerId` + `actor` supplied (already authenticated)
by the caller, scopes all data by it, and enforces per-owner isolation — but it
never resolves *who* the owner is or bills them. So user-management and billing
are **Intentional Divergence**, not Gaps: a relocated concern, not a degraded
one.

That does not eliminate every money-related concern from Traderton. Platform
billing authority stays outside by design, but Traderton-native usage metering
or execution-cost attribution may still return later as a Deferred concern.
Keeping those ideas separate avoids mixing "not owned here" with "owned here,
but postponed."

## Why bots are mechanical (the cyclical tension, resolved)

The old model let bots use LLM intelligence and let agents run the mechanical
scanner — two capabilities on both actors. That symmetry made the actors
collapse into each other: if a bot can reason it's an agent; if an agent runs
mechanics it's a bot → no fixed point → the cycle.

The code showed the misfit concretely: a bot's `config.strategy.type` could
select `LlmStrategy` or `HybridStrategy` (both call the LLM), alongside the
mechanical `Mechanical`/`Dca`. Regime/scanner, by contrast, is *mechanical*
intelligence (indicators only, no LLM).

Resolution: **intelligence is the agent's defining trait; mechanical execution
is the bot's.** A bot executes a deterministic strategy and submits decisions;
it does not reason. LLM/Hybrid decision-making relocates to the agent, which
calls `submit_decision`. This breaks the cycle and gives Traderton a coherent
mechanical identity with **no LLM dependency and no LLM cost center**. Bots
being mechanical-only is a deliberate Intentional Divergence (source allowed
LLM/Hybrid bots).

Implication for the split: `llm` stays agent-side; `strategy` is split —
mechanical (`Dca`, `Mechanical`, `scan-engine`, `regime`) moves, LLM (`Llm`,
`Hybrid`, `llm-provider`) stays.

## Why `blueprint.ts` is a within-file seam

`blueprint.ts` is platform bot/agent-blueprint policy (agent style, preset
policies, wake prefs) → stays platform. But it also contains genuinely
trading-shaped schemas (risk, execution defaults, token safety) that are the
"instance config" Traderton must own. So it's a seam *inside a file*: copy the
risk/execution/token-safety schema pieces, leave the agent-policy pieces. Flag
carefully — this is where an agent would copy too much or drop a field.

## Why infra comes last, and is copied not authored

Infra (Hetzner, Dockerfile, compose, CI) is the outermost layer — it wraps a
working service. Building it early yields a container with nothing coherent
inside (liveness, not parity). It belongs at the end of the build sequence.
When we reach it, copy the trading-relevant slice of herobids' proven infra and
delete the rest — same copy-and-delete principle. Traderton gets its own
Postgres, Redis, host, and pipeline (own-database + own-TLD decisions).

## Why the data seam turned out small (a reassurance)

Early fear was a 70-table shared schema with cross-boundary FKs. Investigation
showed the trading core tables (`decisions`, `positions`, `orders`, `fills`,
`journal-events`, etc.) are **already soft-linked** — plain `text` columns, no
FKs. The only trading→platform hard FKs are the identity/grant seam above. This
is strong evidence the split follows a real seam, not an arbitrary line.

## Why source-fix requests are allowed (never source edits)

Copy-and-delete lets Traderton author only deletions and thin seams. When the
source has an awkward shape — e.g. a single symbol fusing trading and platform
fields — the choices inside Traderton are to author a workaround (forbidden) or
stall. The better fix is usually to make the seam clean *at the source*: reshape
herobids so trading and platform concerns are separable, then copy the
already-clean shape.

So Traderton may **request** such a reshape; it must never edit herobids itself.
Reasons:

- **Preserves 1:1 parity.** If herobids changes and Traderton copies it, the two
  stay diffable — the whole point of keeping file-for-file correspondence with
  the source, so we can monitor parity and port bug-fixes cleanly. An authored
  Traderton-only fix would create exactly the drift we are avoiding.
- **Keeps authorship where the context and tests live.** A reshape validated by
  herobids' real suite and released is trustworthy in a way an in-Traderton
  guess is not.
- **Respects herobids as READ-ONLY.** Traderton asks; the owner makes, tests,
  gates, and releases. Clean separation of authority.

Guardrails: requests must be **behaviour-preserving** (validated by herobids'
existing tests) — altering trading behaviour is a product decision, not a
copy-enablement request. Every request and the resulting herobids version is
logged in [003-anomalies-and-deviations.md](./003-anomalies-and-deviations.md).
Prefer a clean in-Traderton deletion when one exists; each source request costs a
full herobids test/gate/release cycle, so reserve it for seams a deletion cannot
cut without authoring non-trivial logic.

## Why blueprint.ts stays platform, and bot cloning is a planned Traderton feature

`blueprint.ts` in herobids is the **marketplace/authoring** layer — reusable
agent/bot templates with revisions, publication status, fork lineage, likes,
popularity/trending scores, and browse cursors. Investigation of its consumers
(2026-09-05) confirmed it is not part of the trading path:

- Bot creation, validation, and startup all validate against **`BotConfigSchema`**
  (defined in `config/schema.ts`, trading-owned), not the blueprint payload —
  `apps/api/routes/bots.ts`, `apps/worker/agents/agent-message-broker.ts`,
  `apps/worker/index.ts`.
- The bot **execution** path (`agent-trading-actor.ts`, `packages/engine`) has no
  blueprint references at all.
- `BotBlueprintRevisionPayload` is used only by the marketplace API. Critically,
  `apps/api/services/blueprint-projection.ts` builds the bot blueprint payload
  *from* a bot row (`projectBotToBlueprintPayload`) — the blueprint is a
  marketplace **view over** the bot's `config`, and `BotConfigSchema` is the
  source of truth.

So blueprint.ts is platform and is **not copied** into Traderton (Intentional
Divergence). We deliberately do **not** keep a hollowed `blueprint.ts` containing
only `BotConfigSchema`: `BotConfigSchema` is defined in `config/schema.ts`, so a
blueprint.ts holding only it would match no source file and break the
file-for-file 1:1 diff discipline. 1:1 parity is preserved by deleting the
platform file (the diff is simply "file removed"), not by repurposing it.

**Planned Traderton-native capability — bot reproduction / cloning.** We want
Traderton to let users reproduce/clone a bot from day one. This does not need the
marketplace machinery. From the herobids clone/projection behaviour, reproducing
a bot is: take the bot's stored `config` (the authored recipe validated by
`BotConfigSchema`), strip instance-only fields (`venueAccountId`, `connectionId`,
`status`), and create a new bot from that recipe bound to a (possibly different)
venue account / owner. The config is the reproducible essence; the marketplace
publish/fork/browse flow is separate and stays platform.

This is a deliberate future feature, not a parity gap and not an anomaly. It is
recorded here + in the ledger as a planned Traderton-native capability built on
`BotConfigSchema`, to be designed and built in a later phase — not authored during
the Phase 1 domain-slice extraction.

## The soft-reference rule (generalizing decisions 10–13)

Decisions 10–13 name specific identity FKs to convert (`bots.userId`,
`bots.connectionId`, `venue_accounts.userId`, `backtest-runs.userId`). Phase 2 (db)
investigation found the actual FK graph has more copied trading tables that hard-FK a
platform table than decisions 10–13 enumerated: `user_credentials.userId`,
`replay_corpora.userId`, and `datasets.userId` also reference `users`. The named list
was illustrative, not exhaustive.

The governing principle behind those decisions (decision 10: Traderton does not own
user identity — it accepts an authenticated `ownerId` + `actor` at the boundary) implies
a general rule, adopted 2026-09-06:

> **Soft-reference rule.** No Traderton-copied table hard-FKs a platform table. Every
> `users` FK in a copied trading table is converted to a soft `ownerId` (plain text
> column, no `.references()`, validated at the boundary). Every other platform FK
> (`connections`, `agents`, `billing*`) is dropped or softened per decisions 11–13
> (e.g. `bots.connectionId` → `venueAccountId`). Intra-trading FKs (a copied table
> referencing another copied table — e.g. `bots.venueAccountId` → `venue_accounts`,
> `venue_accounts.credentialId` → `user_credentials`, `market_assessment_artifacts` →
> `market_assessment_runs`) are preserved.

This is a sanctioned **authored seam**, not an anomaly and not a stop-gate: it is the
schema-level expression of the ownerId boundary model. Apply it uniformly to every
copied table without re-litigating per table.

Corollary (from the same investigation): a KEPT repository/class may carry individual
platform-coupled *methods* (e.g. `BotRepository.getResolvedVenueAccount` reads
`connections`; `listRunningBotsForInactiveAgents` joins `agents`). Before treating such
a method as a fused edge needing a source-fix request, **check its consumers across all
of herobids (read-only, any phase)**: if only platform code calls it, delete the method
in place (a deletion, not authoring). Escalate to a source-fix only when a trading
consumer needs the reshaped behaviour.

## Why "herobids becomes a consumer of Traderton" changes how we classify

Discovered while extracting `packages/db` (Phase 2), on the BotRepository seam. The
end-state (stated in [000-vision.md](./000-vision.md): herobids becomes a runtime
consumer of Traderton) means the question "is this capability trading or platform?"
is too coarse. The precise questions are:

1. **Is the CAPABILITY trading?** (bots, decisions, execution, limits → yes.)
2. **Is the current IMPLEMENTATION platform-coupled?** (e.g. per-agent limit locked on
   the `agents` table → yes.)
3. **In the end state, will herobids RELY on Traderton to provide this capability?**

A capability can be "trading capability, platform-coupled implementation, and herobids
will depend on Traderton for it." In that case:

- The platform-coupled implementation → **Intentional Divergence** (relocated, not
  copied). It is deleted from Traderton; it stays in herobids' agent layer for now and
  is retired when herobids cuts over to calling Traderton.
- The capability itself → **Deferred but REQUIRED for cutover** — Traderton must
  provide it (via the relevant tool, e.g. `create_bot`/`start_bot`), because
  herobids-on-Traderton must not be weaker than herobids-today. Record it against the
  affected tool/subsystem in the ledger so the cutover gate cannot pass without it.

Worked example (BotRepository, Phase 2): `tryCreateBotWithLimit` /
`tryMarkBotRunningWithLimit` enforce a per-agent maxBots limit by row-locking `agents`.
- Implementation (agent-keyed, agents-locked) → Intentional Divergence (platform); the
  methods are DELETED from `@traderton/db` (their only callers are the platform
  agent-broker + worker runtime, which stay in herobids).
- Capability (limit-enforced bot creation/start) → Deferred-REQUIRED; owned by
  Traderton's bot-lifecycle phase (worker/api), where the limit key (per-owner /
  per-venue-account / operator config) is decided. herobids will call Traderton's
  `create_bot`/`start_bot`, so this MUST land before cutover; herobids' per-agent
  enforcement is the parity reference for "not weaker than."

Corollary for the automation flow: a novice agent that lacks the "herobids becomes a
consumer" model will mis-file such a capability as optional backlog and risk a silent
parity regression at cutover. The model is now explicit in 000; the ledger must tag
required-for-cutover Deferrals distinctly from optional ones.
