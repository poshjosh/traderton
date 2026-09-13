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

### Where mechanical-only is (and is not) enforced — the config-enum question

Recorded 2026-09-07 (M1 holistic review, finding S-1). Mechanical-only shows up at two
layers, and they are deliberately enforced differently:

- **Registry / runtime layer (enforced now):** the strategy registry never calls
  `registerAgentDecisionModes({ llm, hybrid })`, so `validateStrategyParams` reports
  `momentum:llm` / `momentum:hybrid` as unsupported, and `@traderton/strategy` exports only
  `Mechanical` / `Dca`. This is the copied+trimmed enforcement (source-fix #1) and is the live
  mechanical-only guarantee today.
- **Config-enum layer (NOT narrowed yet — by design):** `StrategySchema.decisionMode` is a
  **verbatim copy** of herobids' `z.enum(['mechanical','llm','hybrid'])`, so a bot config with
  `decisionMode: 'llm'` still *parses* (the registry then rejects it downstream). The enum was
  left as-is because narrowing it is a consequential authored behavioural change — exactly the
  kind this project refuses to make silently during the copy phase.

Why defer the narrowing to 9b rather than do it now: trimming the enum (and its copied
acceptance test) is *authoring* against a verbatim copy, which breaks copy-never-author and 1:1
diffability during extraction. Traderton owns its config (decision 2), so the right place to
express a tighter mechanical-only boundary is the **authored 9b config/composition surface**,
recorded as a signed-off Intentional Divergence. Two acceptable shapes: (a) narrow the
Traderton-owned config schema (or a Traderton wrapper over the copied `StrategySchema`) to
`decisionMode: ['mechanical']` and update the copied test — crispest guarantee; or (b) keep the
copied enum and rely on the registry rejection, documenting that config parse is
permissive-by-inheritance while the runtime is mechanical-only. Either way, add an explicit
live assertion of the mechanical-only guarantee at Traderton's owned boundary (ties to the
review's harness note that copied tool tests are not type-checked against the Traderton surface).
This is a 9b design decision, not a pre-9b blocker or a copy defect.

**DECISION (2026-09-07, human-approved): option (a) — narrow-and-diverge. IMPLEMENTED (item A′).**
9b tightened the Traderton-owned config boundary via a **wrapper** (not by editing the copied
`StrategySchema`): a new `MechanicalStrategySchema` (`decisionMode: z.enum(['mechanical']).optional()`
+ the same dca-or-required refine) is what `BotConfigSchema.strategy` validates against. The copied
`StrategySchema` stays byte-verbatim (its copied test asserting `llm` is accepted stays true — the
narrowing lives on the Traderton wrapper). A dedicated authored test (`config/mechanical-only.test.ts`)
asserts the guarantee (llm/hybrid rejected; mechanical/dca accepted). This chose the wrapper (a-i)
over editing the copy (a-ii) to keep 1:1 diffability of `StrategySchema`. Rationale for (a) over (b): it makes the mechanical-only guarantee
an explicit product invariant at the boundary Traderton owns, rather than an emergent property of
downstream registry rejection — closer to decision 3 (own risk/enforcement) and easier to test and
reason about. This is a sanctioned authored Intentional Divergence on Traderton's owned config
surface (decision 2), executed in 9b (not during the copy phase).

## Why Traderton does not own human approvals

Decided 2026-09-07 (human-confirmed), during 9b planning, while scoping the intake surface.

The question arose from a config knob (`agentApprovals.ttlMs`) but the real issue is a
boundary one: **does Traderton own the human-approval lifecycle?** Answer: **no.** The
consuming agent platform owns it.

The model — "agents ask for approvals": when a consumer's policy says a proposed trade needs
a human sign-off, the **consumer** decides that, asks the human (its own UI / messaging), holds
the pending approval (its TTL, short-code, expiry, per-user ownership), and — once the human
approves — calls Traderton's `submit_decision`, the *same* port a direct (no-approval) decision
uses. Traderton has **no** notion of a pending approval, an approver, or an authorization mode.
Traderton owns only decision **execution** (`submit_decision` → risk → planner → executors).

Why this is the right seam (evidence from the herobids source, read 2026-09-07):
- The approval flow is keyed on the platform **`userId`** (`approval.userId !== userId → not_owned`;
  it hard-requires "an owned agent with a user"). Traderton takes an opaque `ownerId` and never
  resolves *who* the user is (decision 10) — so an approval concept keyed on user identity cannot
  be Traderton's.
- `authorizationMode` (`direct | approval_required`) is read from the platform `agent.unifiedConfig`.
- The pending path notifies via the platform messaging surface (Telegram, `InstanceEventPublisher`)
  — the "ask a human" channel is the messaging platform, which stays in herobids (decisions 7–9).
- What the approval flow *reuses* from Traderton is only `submitDecisionForExecution` on approve —
  i.e. the execution Traderton already owns. Everything wrapping it (ask/hold/expire/notify/own-by-user)
  is platform.

Consequences:
- The copied `decision_approvals` table + `DecisionApprovalRepository` (Phase 2) were an **orphan**
  in Traderton (no trading code imported them). They are **deleted** (Intentional Divergence, logged
  in [001](./001-parity-ledger.md)); the initial migration regenerated (23→22 tables). Deletion is the
  sanctioned action (copy-and-delete), preserves 1:1 diffability, and is not a silent drop — the
  *capability* is consumer-owned, and Traderton's obligation (`submit_decision` execution) is unchanged.
- 9b's intake surface (item C) shrinks accordingly: no `ApprovalService`, no `authorizationMode` fork,
  no `agentApprovals` config in Traderton. Item C is just the venue-account-direct `DecisionIntakeResolver`
  + a slim decision handler that drives `submitDecisionForExecution`.
- This tightens, and is consistent with, the Phase-8 reclassification that already put the
  intake/approval/session cluster on the platform side.

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

## Why trading is an isolable, REST-first-but-in-process-capable deployable (legal, not architectural)

Added 2026-09-07 (human-stated constraint); **refined the same day** — the first draft
overstated it as "in-process forbidden as a law." The accurate rule is below. Read it before
the M1/M2 section that follows.

**The constraint (why REST-first).** Payment providers commonly **restrict or deny trading
activity**. If trading code runs inside the agent/messaging platform's shipped deployable, it
puts the platform's payment rails (subscriptions, billing — the platform's actual revenue) at
risk of being restricted or cut off. To ring-fence that risk, **trading must be a
separately-deployable, isolable unit** — able to run as its own service (its own TLD, behind
the REST boundary [005](./005-consumer-boundary-contract.md)) so it can be fully separated
from the platform's payment surface. **Given today's legal posture, trading ships REST-only:
herobids consumes it out-of-process over REST and does NOT import `@traderton/*` into the
shipped platform process.**

**Why it is a DEPLOYMENT constraint, not an architectural law (the refinement).** The
requirement is *isolability/separate-deployability*, not "in-process is forbidden." Technically
herobids *can* import `@traderton/*` and drive it in-process — the ports compose (L1 proved
it). Both consumption paths are, and must remain, **first-class and supported**:
- **In-process library** (`createTradingRuntime` + direct calls) — used for dev/test/eval now,
  and the **shipped** path the moment the legal hurdle is cleared.
- **REST adapter (M2/005)** — a thin adapter over the same ports; the shipped path today.
**Support both; let DEPLOYMENT decide which ships.** The core stays importable; REST never
becomes the only door and never leaks HTTP/HMAC concerns into the core. A future agent must
NOT collapse this into "REST-only, delete the in-process path" — the in-process path is a
deliberately-preserved option (see the invariant below).

**Latency — why preserving the in-process option matters (analysis, 2026-09-07).** The
transport overhead *added around* the trading work (risk gate + planner + DB + venue call),
per `submit_decision`-class call, order-of-magnitude:
| Topology | Added overhead / call | dominated by |
|----------|----------------------|--------------|
| In-process library | ~0.001–0.05 ms | a function call (no serialize, no network) |
| REST, same machine (compose / loopback) | ~0.3–2 ms | JSON + HTTP framing + loopback + HMAC |
| REST, separate machine, same region/VPC | ~1–5 ms | + one LAN/VPC round-trip + TLS |
| REST, separate machine, own TLD, cross-region | ~20–150 ms+ | + WAN RTT (dominant) + DNS + TLS |
Load-bearing reading: **the expensive part is the far/cross-region hop, not "REST" itself**;
in-process→same-machine-REST is ~1–2 ms. For the agent/bot path this is **noise** — an LLM
already spent 1–30 s reasoning before the call, and Traderton's own execution loop (actor,
marks, reconciler) runs in-process *inside the traderton service* regardless of topology, so
REST is crossed only for intake + events, not per internal tick. So REST-first costs little on
today's paths; but if a future latency-sensitive need arises AND the legal hurdle is cleared,
plugging trading in-process removes the boundary overhead entirely — which is exactly why we
keep the in-process path alive.

**INVARIANT (do not break):** *the in-process library must always remain a first-class,
working consumption path; REST is an adapter over the same ports, never the only door.* This
preserves the deployment optionality (isolate-behind-REST today; plug-in-process later).

**Consequences (load-bearing for the roadmap):**
1. **M2/REST is the shipped boundary today** (F is required — it is how trading ships isolated
   for the current legal posture). It is *mandatory-for-shipping*, but it is an adapter over
   the in-process ports, not a replacement for them.
2. **M1 (in-process) is BOTH the assembly/verification milestone AND a permanently-supported
   consumption path** — only "not the shape herobids *ships* in today," not forbidden.
3. **L2 (differential) was SKIPPED** (2026-09-07) — see the L2 skip note in
   [024](./024-verification-and-consumption-roadmap.md) + 027-L2-differential-proposal (on branch `l2-differential`, not on this branch):
   the herobids ref only recorded **agent/LLM** decisions (no mechanical-bot corpus), so there
   is no faithful mechanical reference to diff Traderton (mechanical-only) against; the
   decision-layer parity L2 would test is already covered by the byte-verbatim `@traderton/strategy`
   split (+56 copied strategy parity tests) and the 83 copied risk-gate parity tests, and L1
   exercised the full execution path live. Manufacturing a mechanical corpus was judged high-cost /
   low-marginal-value over L3's eventual REST-boundary differential. Order (when L2 is done at
   all): L1 → L2 → F → L3, L2 before-F-or-skipped.

## Why there is an interim "library consumer" milestone (M1) before the API (M2)

Added 2026-09-06, while resolving the Phase 8 (`apps/worker`) stop-gate.

> **CORRECTED 2026-09-07 — read the section above ("Why trading is an isolable,
> REST-first-but-in-process-capable deployable") first.** This section originally called M1 a
> "library consumer" milestone. Refined: the in-process library **remains a first-class,
> supported path**, but for the **current legal posture herobids SHIPS its consumption over
> REST (M2)**, not in-process. So "same ports, two adapters" and "defer authoring to M2" below
> still hold; only "herobids ships in-process at M1" is corrected to "herobids ships over REST;
> in-process stays a supported, non-shipped-today path (dev/test/eval, and a future option if
> the legal hurdle clears)."
> M1 remains exactly as valuable, but re-labelled: it is a **Traderton-internal in-process
> *assembly + verification* milestone** (the extraction proves itself in one process, driven
> by a test/verification harness — see L1 in [024](./024-verification-and-consumption-roadmap.md)),
> **not** a state herobids runs trading in. Everything below about "same ports, two adapters"
> and "defer authoring to M2" still holds; only "herobids consumes in-process at M1" is wrong —
> substitute "a verification harness drives the assembled library in-process at M1."

For a long time the docs described a single end state: "herobids becomes a consumer of
Traderton **over the boundary**" — i.e. HTTP/REST (005). That framing was load-bearing in a
way we hadn't named: it implied the *first* time herobids calls Traderton is over an HTTP
boundary. That is precisely what produced the Phase 8 stop-gate — the mechanical decision
intake core is copyable, but if the first driver must be the 005 HTTPS boundary, then the
driver is **authored** boundary infrastructure (auth/idempotency/deadline), not copied
trading logic. Under "defer all authoring to the end," authoring the boundary early is
exactly what we want to avoid.

Naming an **intermediate library state (M1)** dissolves the tension:

- **M1 — Library consumer.** herobids consumes Traderton **in-process** via dependency
  injection / hexagonal ports & adapters. The extracted `@traderton/*` packages *replace*
  herobids' in-process trading; herobids drives Traderton's intake core in-process, exactly
  as it drives its own trading today. herobids keeps owning what Traderton deliberately does
  not — the `connections`/`agents` grant layer, the agent message-broker drive, the per-agent
  `maxBots` key — and **injects those into Traderton's ports as values/callbacks at the call
  site.** No boundary code is authored. This is where the extraction proves itself.
- **M2 — API consumer.** The 005 REST boundary is added as a **second adapter over the same
  ports.** Its request/deadline/idempotency semantics are the HTTP expression of the M1 ports.
  MCP/skills wrap it later.

Why this is the right shape, not a convenience:

1. **It makes "defer authoring to the end" coherent.** All the authored pieces (per-owner
   `maxBots` enforcement, the REST layer) become **M2 work**, done after M1 lands and a
   holistic review — not sprinkled through the extraction.
2. **It is the honest expression of the ownership seam.** Decisions 10–13 already put
   grant/identity/billing outside Traderton. M1 says: in the interim, the owner of those
   concerns (herobids) supplies them through ports. Nothing is dropped; nothing is authored to
   fake ownership Traderton doesn't have.
3. **Same ports, two adapters** keeps M1 and M2 from diverging — the API is not a different
   core, it is a driver over the identical seams.

### The ports-carry-values invariant

A consumer may inject through a port only the **platform-owned values** Traderton does not own:
a resolved `venueAccountId`, grant/connection validity, the `maxBots` limit decision, an
authenticated `ownerId`/`actor`. A port must **never** let the consumer inject *trading
behaviour* — the risk gate, planner, executors, reconciliation, and fill/position accounting
are Traderton's and are not overridable through a seam. If a proposed port would carry trading
logic, the seam is mis-drawn; that is the copy-never-author law asserting itself at the
boundary. This invariant is what keeps the injected M1 seams (e.g. injected `venueAccountId`,
deferred `maxBots` decision) from quietly becoming a backdoor around copy-never-author.

### Worked consequences (Phase 8)

- The bot-startup connection→venueAccount resolution (`resolveBotStartupContext`) is a platform
  grant concern → deleted from Traderton (Intentional Divergence); the port takes an injected
  `venueAccountId`. herobids (the M1 consumer) resolves it and runs the connection-grant guards;
  Traderton runs only the venue-account guards it owns.
- `create_bot`/`start_bot` limit enforcement is `Deferred (required for cutover)`: not copied
  (platform-keyed), not authored at M1; herobids enforces its existing key in the interim; the
  per-`ownerId` enforcement is authored as M2 work. Cutover is gated on it, so Traderton never
  ships weaker than herobids-today.

## Why Phase 10 (infra) is a shared versioned module, not copy-and-delete

Settled 2026-09-07. Full decision + verified source facts: [docs/features/012-shared-infra-module-decision.md](../archive/features/012-shared-infra-module-decision.md).

Every other phase moves trading code by copy-and-delete because herobids *stops* owning that code — trading
relocates to Traderton and herobids becomes a consumer. **Infra is the exception: herobids does not stop
owning infra.** Both herobids and Traderton must keep running on Hetzner/Nomad/cloud-init/deploy-scripts. A
naive "copy the trading slice of the infra and delete the rest" (what the original Phase 10 said) would create
**two divergent copies of the same infrastructure to maintain forever** — the opposite of the maintenance win
the extraction exists to produce.

So Phase 10 changes shape: herobids' proven infra is extracted into a **standalone, versioned Terraform
module library** — two composable modules, `app-host/hcloud` (control-plane substrate: VM, firewall, network,
TLS, cloud-init, deploy scripts) and `nomad-autoscaler/hcloud` (the agent-node pool + autoscaler) — consumed
via pinned git-ref `source`. Traderton consumes `app-host/hcloud` with `enable_nomad = false` (host only,
autoscaling-ready but not enabled, since Traderton is mechanical and runs no per-agent containers); herobids
consumes both. Each pins its own immutable version tag.

Load-bearing consequences for how agents work this phase:

- **The module-library extraction is authoring/refactoring, not copy-and-delete, and it is herobids-owned.**
  Parameterizing `app_name` (the ~232 `HEROBIDS_ENV` refs funnel through one `_ssh_opts.sh` seam), splitting
  the two modules, adding the `enable_nomad` flag and the single `user_data_override` seam — all of that is
  done *in herobids* by its owner (build/test/release), the same authority model as source-fixes. **A
  Traderton agent does not refactor herobids infra**; it consumes the released module and authors only
  Traderton's own operator config (tfvars/compose/env — always exempt from copy-never-author per decision 1).
- **It is timed to the M1 testing window, deliberately.** herobids is the only system with real agent load to
  exercise module B's autoscaler under production traffic, so it is module B's live test harness; Traderton
  validates module A (host boots, clones, composes-up, serves TLS). Building the reusable module properly in
  this window beats throwing away a temporary Traderton-only infra.
- **The same "is it generic or does it encode the first consumer's semantics?" boundary test we use for
  trading-vs-platform applies here** (doc 012 decision 9): the Nomad node-health publisher ships herobids'
  `ServerHealthSnapshot` schema, so it stays herobids-side (re-attached via the `user_data_override` seam),
  exactly as the browser-pool job and market-intelligence loops were ruled platform. And doc 012 decision 5's
  "a parameter with exactly one real value is a constant with extra steps" is the same anti-speculative-
  generality restraint used throughout — do not abstract beyond a memory-driven single-pool autoscaler.

This does not affect the M1 holistic review or Phase 9b; it is Phase 10 shape, recorded now so it is not lost.

## Why trading credentials are NOT mirrored into herobids (credential custody follows use)

Settled 2026-09-11 (human), during L3-P1b scoping. Extends decision 12 (credential
custody follows the venue caller → Traderton) and the soft-reference rule.

**The question.** herobids and Traderton each already have their OWN `user_credentials`
table (two physical tables in two databases — herobids' is `userId`-FK'd to `users`;
Traderton's is soft-`ownerId`). During L3-P1b scoping it looked like a "shared table
ownership" problem: the herobids `credentials.ts` DELETE operates on credentials of ANY
provider (trading AND non-trading), and its dependents check spans platform-owned
(`connections`, `agent_connections`) and trading-owned (`venue_accounts`, `bots`) rows.
Proposed idea: keep ALL credentials (incl. trading) in a usage-agnostic herobids table,
mirroring the trading ones for ease of reference.

**What the code actually shows (traced 2026-09-11).** Credential *use* splits cleanly
into two kinds:
- **Decrypt-and-use (custody — the legally-loaded use):** the only sites that decrypt a
  secret to plaintext are Gmail (`apps/worker/src/gmail-credential-resolver.ts` — a
  platform capability, legitimately in herobids) and the trading venue adapters
  (`venue-adapter-factory.ts`, which decrypts API/private keys to sign orders). That
  file is **already gone from herobids `consume-traderton`** and lives in Traderton —
  i.e. trading-credential custody has ALREADY moved behind the boundary.
- **Metadata-only (reference — legally harmless):** every OTHER herobids touch of
  `user_credentials` reads only non-secret columns or does lifecycle bookkeeping and
  NEVER decrypts — plan-limit counting (`plan-guards.ts`), link validation
  (`accounts.ts`/`connections.ts` read `{id, provider}`), the `credentials.ts` list/get
  (returns `id/provider/label/timestamps`, never `encryptedData`), delete, rotate, FKs.

**Decision.** Each side stores ONLY the credentials it actually uses; there is NO
trading-credential mirror in herobids.
- Trading credentials are Traderton-owned (custodied + decrypted behind the boundary).
- Non-trading credentials (Gmail/OAuth/social) stay entirely herobids-owned; Gmail token
  refresh is unaffected (it reads herobids' own table — correct, a platform concern).
- If a unified credential VIEW is ever needed (e.g. a UI list across both), COMPOSE it at
  read time (herobids' own credentials + a boundary read call) — a read-time composition,
  never a stored mirror.

**Why not the mirror.** A herobids reference-row for a trading credential (metadata only,
no `encryptedData`) would NOT break the legal rule (no secret material, no decrypt). But
it introduces a second writer of one fact → drift, plus a reconciliation burden, to save
provisioning-time/plan-check reads that are not on any hot path found. The extraction is
removing trading-shaped state from the platform, not adding a synced copy of it. A
metadata-only read-cache with an explicit reconciliation job remains a future option IF a
hot path that frequently lists/counts trading credentials is later found — declared as a
cache, never a second source of truth. None was found (touches are provisioning-time +
plan-checks, not per-request-hot).

**Consequence for L3-P1b.** The herobids `credentials.ts` route stays LOCAL and unchanged
— it correctly manages herobids' own credentials. Only the holistic TRADING path
re-points to the boundary (`setup.ts` → `provision_venue_account`; `provider-links.ts` +
`accounts.ts` deletes → `deprovision_venue_account`). See the parity-ledger cutover
obligation for migrating pre-existing trading-credential rows into Traderton at cutover.

## Q2 `score_candidate` re-point — decision + resolved unknowns (2026-09-11)

**Decision (Option A, human-ratified via the 008 process):** re-point herobids'
`preset-scorecard-runner.ts` from the in-process `scoreCandidate(candidate, scanConfig)` to the
boundary `score_candidate` tool. Make the runner + its assessor caller async; STOP feeding local
candles to scoring; call the boundary with IDENTIFIERS; reconstruct `scanHealth` from the boundary
result's `candlesEvaluated` (signal→healthy; null&count>0→no_signal; null&count===0→stale); map
`failure`/`transport_error` to a propagated Result error (NOT to a synthesized `stale` — that would
degrade parity by conflating infra failure with market staleness). No traderton-side change for the
happy path (`candlesEvaluated` already exists in the result). Decision made by the `Contemplator`
decision agent from a neutral brief; the agent corrected a false premise in the brief (candles are an
evidence-collection byproduct, not a scoring fetch). Parity-touching → human ratified.

**Parity impact (→ [001](./001-parity-ledger.md), Intentional-divergence):** `scanHealth='stale'` now
reflects the BOUNDARY's fetched candle count, not herobids' evidence-candle count. Accepted as an
improvement (source of truth = the candles actually scored). **Separate Deferred (out of scope for this
slice):** `collectEvidence` still fetches candles in-process — a distinct market-data coupling to be cut
by the `check_regime`/evidence-ports work.

**Resolved unknowns (traced in `packages/domain/src/market-assessment.ts`):** `MarketAssessmentIdentity`
is a discriminated union — orderbook/perp carry `symbol` (venue-canonical) + `venueFamily`; swap/dex
carry `network` + `address` (canonical TOKEN address).
- **Orderbook `providerSymbol`:** the old path passed `identity.symbol` directly as the candidate symbol,
  so mapping `providerSymbol = identity.symbol` reproduces the old scored behaviour by construction
  (parity holds — same symbol the old scan used). Clean thin seam; no resolver.
- **Swap `poolAddress` — a REAL GAP (new sub-decision, route via 008).** The boundary REQUIRES a DEX
  `poolAddress` for swap (errors without it), but the identity carries only a TOKEN `address`, and the
  OLD in-process path never resolved a pool — it sidestepped this by passing pre-fetched candles +
  `venueType: undefined`. So swap scoring CANNOT be reproduced over the boundary from identity alone.
  Consequence for the slice: **orderbook/perp scoring re-points cleanly now; swap/dex scoring is a
  separate decision** — where does token→pool resolution live (herobids seam? boundary accepts a token
  and resolves pool-side?), and is that resolution trading-adjacent? To be briefed + routed via 008
  before swap scoring is re-pointed. The score_candidate slice covers orderbook/perp; swap is Deferred
  (required for cutover) with this reason.

## Q2 regime re-point — telemetry re-source + a parity hole fix (2026-09-11, 008-routed)

**Decision (decision agent; parity/contract-touching → pending human ratification):** to re-point
herobids' regime telemetry over the boundary WITHOUT degrading it, make two minimal changes:

1. **`check_regime` success result gains a `freshness` block** — `{ provider, source:'upstream'|'cache',
   ageMs, isStale }` — copied from the provider result's existing `meta.freshness` (which traderton's
   `candle-registry.ts` currently DISCARDS). herobids records provider-success + freshness-mode from it.
2. **Make `rate_limit.exceeded` reachable across the boundary for regime.** Parity hole the agent found:
   `check_regime`'s rate-limit branch sets `retryable:true`, and `dispatcher.ts mapToolResult` maps ANY
   `retryable===true` → `upstream.transient` BEFORE any rate-limit check — so herobids could not tell a
   throttle from a generic failure, silently degrading its `recordRateLimitThrottle` vs
   `recordProviderFailure` split. Fix: `check_regime` sets `errorCode:'rate_limit'` on throttle; add a
   rate-limit branch to `mapToolResult` (keyed on the tool's errorCode) BEFORE the retryable branch →
   `rate_limit.exceeded` (existing closed-union member; no new surface).

**herobids maps telemetry from the TradertonClientResult union** (no local throw anymore): success →
recordProviderSuccess + recordFreshnessMode(source==='upstream'?'fresh':'cached') + snapshot fresh;
failure code `rate_limit.exceeded` → recordRateLimitThrottle + snapshot unavailable; any other failure OR
transport_error → recordProviderFailure + snapshot unavailable; in_progress → record nothing. BOTH regime
call sites (`coordinator.ts refreshRegime` + `evidence-adapters.ts`) apply the identical mapping.

**Ownership call (resolved, not escalated):** the seam that stops `candle-registry.ts` discarding `.meta`
is authored in TRADERTON — it cuts a platform coupling (discarded freshness), not trading behaviour;
copy-never-author permits thin-seam authoring for cutting couplings, and the values are copied from the
existing `ProviderResult.meta.freshness`. Logged in [003](./003-anomalies-and-deviations.md).

**Parity:** preserved exactly (Met), not degraded. The rate-limit-distinction fix actually RESTORES a
parity split that was latently broken for any future regime consumer. Pending human ratification (parity +
005-contract-visible).

## Q2 batch — herobids-side re-point decisions (2026-09-11, 008-routed, human-confirmed)

**Q1 regime scope → A (re-point regime ONLY now).** herobids `coordinator.ts refreshRegime` +
`evidence-adapters.ts` re-point to `check_regime`; telemetry re-sourced from the tool's `freshness`
block + `rate_limit.exceeded` code (parity). The coordinator's OTHER in-process market-data loop
(`providerRegistry.discovery.discover`) is NOT touched — so this does NOT clear `@herobids/market-data`;
discovery is a separate larger slice (the Traderton `discover_tokens` tool is a single-network point
query and does NOT carry the coordinator's multi-network snapshot/stale-state surface — re-pointing
discovery needs new snapshot-parity boundary surface). Regime-alone is a safe incremental step (regime +
discovery loops are independent). `check_regime` is `read-market-data` (resolver short-circuits — no owner
scoping needed); the coordinator gets a boundary client from the worker composition root (index.ts already
constructs `createTradertonClient`) with a SYSTEM subject (`actor.type:'system'`, e.g. id 'market-intel').

**Q2 agent-tool write path → A (`tradertonWriteBoundary?` on ToolContext).** Add a second optional,
subject-bound side-effecting boundary port to `TradingToolContext` (subject bound at the agent-container
composition root, mirroring the read adapter — a subject-less `invokeAndAwait({toolName,payload,deadlineMs})`).
Keeps the deliberate read/write adapter split (reads poll-never + domain-clean result; writes idempotent/
deadline-bound + raw union). `adjust_risk_limits` routes through it; it is `ownerScopedNoVenue` so
ownerId+actor suffices. Reject B (widen the read boundary — leaks write affordances into reads) and C
(route via decision-handler — over-couples to submit_decision plumbing).

**adjust_risk_limits boundary-absent → (a) HARD-FAIL `precondition.not_ready`, no in-process fallback
(human-confirmed).** Forced by the existing L3c "Fallback posture" (side-effecting writes fail closed when
the boundary is absent; do NOT fall back to in-process) + the unanimous write precedent (submit_decision,
bot lifecycle, executeApproval all fail closed). Reads keep their direct-DB fallback (transitional); writes
fail closed — `adjust_risk_limits` is on the write side. `ctx.riskContractOps` STAYS (the read
`get_risk_limits` still uses it); only the WRITE path (`adjustOverrides`) re-points. Implication accepted:
with no boundary, risk-limit adjustment is inert (same as submit_decision today) — capability relocated
behind the boundary, not dropped (system-level parity). Swap scoring + discovery + get_risk_limits-read
re-point remain separate slices.

## T2 swap score_candidate — decided approach (B) + deferred build (2026-09-11, 008-routed)

**Decision (decision agent): Option B** — `score_candidate` should accept a swap TOKEN
(`network + address`) and resolve the pool BEHIND the boundary (reusing Traderton's
`swap-candidate-discovery` selection + `geckoterminal.fetchPoolOhlcv`), so herobids passes the
identity it already has and does NO pool resolution / candle fetch. Rejected A (carry poolAddress —
entrenches herobids' in-process discovery as the pool source) and C (status quo).

**Grounded finding that changes urgency (verified in code):** the herobids swap-scoring path is
**effectively INERT today, and does NOT fetch swap candles in-process.** `evidence-adapters.ts`
`identityToScannerTarget` returns `null` for swap → the evidence candle port ERRORS for swap
("Candle evidence not supported") → `extractCandlesFromSnapshot` yields EMPTY candles for swap →
`scoreSwapInProcess` scores empty candles (no fetch of its own) → typically no signal → 'stale'/
'no_signal'. Also confirmed `scan-engine.ts` only CARRIES `venueType` onto the output, it does NOT
branch scoring on it (so 'swap' vs undefined does not change the score — no parity break there).

**Consequence:** T2 is NOT an urgent legal-isolation fix (no live in-process swap market-data fetch
on this path — the earlier `scanner-candle-fetcher` concern is about a fetcher this path doesn't invoke
for swap). Re-pointing swap to the boundary would make swap scoring ACTUALLY functional (real pool
candles) — a parity IMPROVEMENT, not a like-for-like move. Because it requires non-trivial Traderton
AUTHORING (extend `score_candidate` to accept a token + resolve pool behind the boundary) and its value
is enhancement not isolation, its BUILD is **Deferred as its own slice** (approach B is decided; not
urgent). Recorded so it is not lost. Coordinator sequencing call (not a parity/legal risk — deferring
changes nothing live).

## B2 investigation — agent.ts live market-data couplings (2026-09-12, terrain map)

Investigation (delegated) found B2 is larger than "a handful of agent.ts couplings" — it is a
multi-decision track. Six live in-process market-data couplings in `apps/worker/src/agent.ts`
(4022 lines): (1) regime eval tick-gate 2733-2740 → COVERED by `check_regime`; (2) volatility
candles 2743-2746 (binance.candles BTC 24x1h → ATR/adaptive interval) → GAP, no candle-series tool;
(3) hybrid sizing 3072-3084 → `priceService.resolvePriceTarget` (NOT getPrice) → get_price contract
MISMATCH (resolvePriceTarget resolves chain/address + returns resolvedChain/resolvedAddress); (4)
venue-intelligence refreshVenueIntelligence 1058-1230 (assetContexts/longShortRatio/discover/dexscreener)
→ maps to get_funding_rates/get_market_overview/discover_tokens/search_tokens but field-shape parity
unverified + bybit longShortRatio possibly a partial gap; (5) construction createProviderRegistry+
createPriceService 913-927; (6) NEW: economic calendar CompositeEconomicCalendarProvider 934-968 (cache-read
only) — no boundary tool.
**Separate BLOCKING surface:** the agent-container READ TOOLS consume ctx.marketDataRegistry/priceService
directly (tools/price.ts, tools/market-data.ts, tools/watch.ts) → removing createProviderRegistry from the
container is BLOCKED by those tools = a separate re-pointing slice.
**5 decisions to route (008):** volatility-candle gap (new surface vs extend check_regime w/ ATR vs
static-fallback); hybrid get_price-vs-resolvePriceTarget contract; venue-intel field-shape coverage;
whether registry removal / read-tool re-pointing is in B2 scope; economic-calendar scope.
Consequence: B2 = a track (several slices), not one slice. Surfaced to human for scope steer before routing
all 5 + building.

## B2 — four coupling decisions (2026-09-12, 008-routed; parity-touching → pending ratification)

The decision agent corrected two wrong premises in the brief (get_price shares resolvePriceTarget's
signature; bybit longShortRatio is ALREADY behind the boundary via get_market_overview). Outcomes:

- **Q-A volatility candles → DEFER (A4).** The in-process `binance.candles('BTC',1h,24)` → `calculateAtrPercent`
  → adaptive tick interval rides the SAME `marketDataRegistry` B2 defers. Moving it now needs new candle/ATR
  boundary surface for a coupling already agreed to persist until the read-tools slice → fails minimal-surface.
  Eventual surface (at the read-tools slice): a `get_volatility` tool returning `{volatilityPct, freshness}`
  (value, not candles — keeps ATR source-side per ports-carry-values). Deferred, no new surface now.
- **Q-B hybrid sizing → DEFER (B3).** Depends on `priceService` (stays until the read-tools slice). Re-pointing
  to today's `get_price` would DROP `resolvedChain/resolvedAddress` from the submitted-decision metadata (silent
  degrade) — rejected. Eventual: extend the boundary price contract (or add `resolve_price_target`) to return the
  resolved identity + {priceUsd,source,fetchedAt,stale}. Deferred with priceService/read-tools slice.
- **Q-C venue-intelligence → LAND NOW (C1).** Re-point each read to its EXISTING tool (reads already have boundary
  tools, independent of registry removal): hyperliquid.assetContexts + bybit.longShortRatio → `get_market_overview`
  (venue bybit); discovery.discover → `discover_tokens`; dexscreener.search → `search_tokens`. Compose the LLM signal
  herobids-side from boundary values (presentation stays herobids; rejected an aggregated tool = authoring on the
  seam). **Parity carve-out:** `get_market_overview` projection LACKS `markOracleSpreadPct` which herobids surfaces
  to the LLM ("Mark/oracle spread"). Resolution (coordinator, copy-faithful/not four-risk): ADD `markOracleSpreadPct`
  to the traderton `get_market_overview` projection (the source `HyperliquidAssetContext` already has it) — restores
  parity, no field dropped. Also verify search_tokens/discover_tokens field-shape parity before re-point.
- **~~Q-D economic calendar → RECLASSIFY AS PLATFORM (D2).~~ RETRACTED — see the 2026-09-12 human ruling below.**
  ~~Macro/economic data (not venue/trading market-data), zero traderton presence, and the tick read is
  `getUpcomingEvents({cacheOnly:true})` — a cache-only read of herobids-owned Redis (a herobids loop populates it).
  NOT a trading-boundary coupling. Stays in herobids; recorded as explicitly-platform (NOT a Gap).~~
  **This classification was WRONG.** It tested "where the data comes from" (macro/forex source, cache transport)
  instead of "does a trading decision consume it." The economic calendar IS trading-adjacent (see the human ruling).

**B2-now = Q-C only** (+ regime, the known coordinator pattern). A/B deferred to the read-tools slice; D out.


## 2026-09-12 — Market-intelligence boundary registry gap + DEX top-pick (routed via 008; decision agent = Contemplator)

**Trigger:** reviewing the B2 venue-intelligence re-point before commit, the DEX top-pick selection appeared to diverge between the in-process path (highest-liquidity ≥$10k) and the boundary `search_tokens` path — a parity/behaviour-change four-risk. Routed a neutral §2 brief.

**The decision agent corrected a MATERIAL false premise** (the value of the 008 process, again): the divergence I framed is moot in production because the boundary tools return `market_data_not_configured` — the boundary context factory (`bin.ts`) never wires `marketDataRegistry`. Verified by the coordinator: the only place `marketDataRegistry` is set on a tool context is the unit tests; no prod/dev bootstrap wires it; `check_regime` uses `ctx.marketDataRegistry!` (NOT the wired `scannerCandleFetcher`).

**Ruling:**
- **D1 (rule-forced, settled):** record the capability gap — the four market-intel read tools are inert over the boundary until the registry is wired. Recorded in 003 + 001. Wiring is the prerequisite work item (feasible: `appConfig.marketData` present; `createProviderRegistry` is the established path in `create-trading-runtime.ts`). Parity-touching → pending ratification; merge gate.
- **D2 (parity-touching, pending ratification):** once wired, adopt Option A — accept Traderton's safety-aware `search_tokens` ranking as the DEX top-pick (Intentional-divergence). herobids keeps its network filter + `[0]`, does NOT re-author a liquidity floor/sort (Option B rejected = re-homes market-data policy in herobids, violates the top rule). Option C rejected = rule-unviable (ranking is always safety-score desc; no param yields liquidity-desc). Justification: the DEX venue-intel signal is display-only (LLM prompt context; no execution/sizing/risk path consumes it), so a safety-first pick is an improvement, not a degrade. If the $10k floor must persist, pass `minLiquidityUsd:10000` (a filter) — ordering stays Traderton's.
- Also resolved by the agent: `discover_tokens` list ordering does not affect the discovery-metadata join (by network:address into a Map, order-independent).


## 2026-09-12 — Swap score_candidate token→pool RESOLVER mechanism (008-routed; decision agent = Contemplator) — CORRECTS the T2/Q2 ratified primitive

**Trigger:** building the deferred swap arm of score_candidate (ratified Option B: token in → pool resolved behind the boundary). Investigating the named primitive (`swap-candidate-discovery`) revealed it is the WRONG fit for a point lookup — routed the resolver-mechanism question.

**Decision agent corrected TWO false premises (both verified in-repo):**
1. `discoverSwapScannerCandidates` (swap-candidate-discovery.ts) is a SET DISCOVERY function (`discover({networks,maxResults,minLiquidityUsd})` → trending list → filter/rank/cap). It does NOT resolve a specific token address → its pool. Using it for a point lookup would fail for arbitrary held tokens → swap scoring degrades to 'stale'/no-signal → violates no-degrade.
2. The DexScreener search family in THIS repo does not surface a pool/pair address — `mapPairToTokenInfo` drops it and `TokenInfo` has no poolAddress field. The atomic `pool` object (poolAddress + base/quote) is produced ONLY by GeckoTerminal (`mapPoolsToTokens`). So "reuse the live search primitive" was illusory.

**Ruling (mechanism):** resolve a known swap TOKEN (network + token address) → pool via a NEW thin GeckoTerminal token-pools wrapper behind the boundary (`/networks/{network}/tokens/{address}/pools`), reusing the existing `mapPoolResource`/`mapPoolsToTokens` mappers + `buildGeckoUrl`/`buildGeckoHeaders`/`fetchJson`. Select the highest-liquidity pool (tie-break volume24hUsd desc, then poolAddress lexicographic; network filter case-insensitive) — matching the liquidity-ranked canonical-pool heuristic already used by merge/discovery. Then fetch candles via the existing `scannerCandleFetcher` (guaranteed GeckoTerminal-fetchable since same provider) and score. Loosen `score_candidate`'s `buildTarget()` so venueType:'swap' accepts `network + tokenAddress` (poolAddress becomes optional / resolved).
- Rejected B-literal (wrong primitive → degrade); rejected A (DexScreener carries no pool address here + cross-provider candle-fetchability risk).

**Copy-never-author check:** the pool-SELECTION behaviour (liquidity-ranked canonical pool) is copied from existing discovery selection; only a thin HTTP wrapper (new seam behind the boundary) + a param-guard loosening are authored. Consumer is display/assessment (preset scorecard → scanHealth), not execution, and the current in-process swap path is effectively inert (empty candles) — so real pool candles are a strict IMPROVEMENT, no specific-pool parity obligation.

**Classification: parity/legal-touching → PENDING HUMAN RATIFICATION.** It revises the LETTER of the human-ratified T2/Q2 decision (named primitive swap-candidate-discovery → GeckoTerminal point resolver); the DIRECTION (token in → pool behind the boundary) stays ratified. Two open questions for the ratification pass: (1) quote-asset constraint on the resolved pool — default taken: highest-liquidity, NO quote constraint (behaviour-affecting; confirm); (2) GeckoTerminal Pro-tier availability of the tokens/{address}/pools endpoint (operational; verify at e2e/config).


## 2026-09-12 — Economic calendar IS trading-adjacent (HUMAN RULING — FINAL, legal-based)

**Ruling (human, final):** the economic calendar is **trading-adjacent**. This is a legal-based
determination and is FINAL — it supersedes and RETRACTS the earlier Q-D "reclassify as platform / not a
Gap" call.

**Grounded facts that support it (verified in code):**
- The `macro-economic` context block (`herobids/apps/worker/src/runtime-composition.ts` ~1240) is
  `requiredFamilies: ['trading']` — it renders ONLY for trading agents.
- Its data (`runtimeState.metrics.macroEvents`, set in `agent.ts` ~3453 from
  `getUpcomingEvents({cacheOnly:true})`) is injected into the agent's DECISION prompt as
  "Upcoming Economic Events" (impact/forecast/previous) — market context the trading agent reasons over.
- The `EconomicCalendarProvider` port lives in the domain market-data ports layer
  (`packages/domain/src/ports/economic-calendar.ts`), alongside candle-fetcher.
- Under our own definition (AGENTS.md "Data": price, P&L, **market context** — always provided; the agent
  reasons over it), trading-gated market context consumed by a trading decision IS trading-adjacent. The
  source being macro/forex and the transport being a cache-only Redis read do NOT make it platform.

**Why the earlier ruling was wrong (recorded so the failure mode isn't repeated):** it conflated
data-provenance/transport with consumption. The correct test for trading-adjacency is "does a trading
decision consume it," not "where does the data originate." (This is the same drop/defer-leaning judgment
weakness 008 exists to catch — noted.)

**Consequence for the ledger:** economic calendar is NO LONGER "explicitly-platform / not-a-coupling." It
is a **trading-adjacent coupling** and therefore a cutover obligation: the acquisition (the ForexFactory/
Scrapfly scrape loop + parser + the `CompositeEconomicCalendarProvider`) and the read must move behind the
Traderton boundary so no trading market-context acquisition runs in the herobids process. Recorded in
001-parity-ledger as **Deferred (required for cutover)** — its own slice. The exact boundary shape
(acquisition-behind-boundary + a read tool, e.g. `get_economic_calendar`, vs. a boundary-populated cache
the consumer reads) is a build-time design for that slice; the classification (trading-adjacent, must not
stay a herobids-owned in-process coupling) is settled by this ruling.


## 2026-09-12 — Bot-consumer contract (008-routed; decision agent) — SETTLED rulings + human residue

Routed the §009 brief to a fresh decision agent. It VERIFIED all load-bearing facts (agent-scoped read tools + no `getBotsByOwner` repo method at TWO layers; boundary serves read-database; fills/journal Traderton-owned; create_bot dryRun schema-only; create_bot payload carries NO id) and tightened the brief (two items I'd over-escalated are actually rule-forced).

**SETTLED (rule-forced) — recorded here + 001:**
1. **Bot reads target = OVER THE BOUNDARY (1b). Local read-model (1a) UNACCEPTABLE.** Invariant 1 — a durable local bots/fills/journal projection re-homes trading-state authority in herobids. 1b tracked Deferred-required-for-cutover, gated on ruling 4.
2. **`POST /bots` = 202 Accepted, id-later, no local row. Polling (2b) REJECTED.** The boundary create payload carries no id and writes no local row; 201+id would require a fabricated id or a local write (invariant 1). Honest 202 = preservation-of-correctness; consistent with start/stop (already 202). Polling re-adds the tick-liveness coupling the async decision removed (invariant 7).
3. **Capability validation = async-by-default; the herobids local pre-check STAYS removed (3-local UNACCEPTABLE).** Re-adding it reverses settled decision #4 + re-homes a trading-config rule (invariant 1). The lost synchronous paper+swap 400 MUST be ledgered as Intentional-divergence/Gap (invariant 7) regardless of human item B.
4. **The owner-scoped Traderton read surface is a HARD, TOTAL prerequisite for 1b, built as a COPY/ADAPT (re-key existing `getBotsByCreator`-family queries agent→owner over the soft `ownerId` column, decision 13), NOT authored.** Permitted thin seam (invariant 1); precedent = L3-P1 `provision_venue_account`. Proceeds as an `l3-integration` slice under the autonomy contract — NO human sign-off before starting. New read-tool surface recorded in 005 when built.
5. **Interim posture = herobids local bot read endpoints STAY on the local mirror until 1b lands; do NOT 503/disable them.** Disabling working endpoints mid-migration is a feature-drop (invariant 7 / 008 §1). The interim mirror is the pre-existing trading DB (L3d deletes it later), not a new durable authority. Transitional staleness for boundary-created bots (no local row) logged in 001 as a Gap closing on 1b.

**FOR THE HUMAN (product/policy) — 3 genuine calls, recommended defaults:**
- **A. 202 create-response correlation shape.** Default: keep `{ok, note}` + ADD a structured `requestId`/correlation token so a client can locate the bot via the (forthcoming owner-scoped) read without polling. (id-later itself is forced; only the token detail is a call.)
- **B. Accept the lost synchronous paper+swap 400 (async-only) vs fund a sync `preview_bot_capability` boundary tool.** Default: accept async-only now, ledger as Intentional-divergence; the sync-preview tool (validation COPIED from `validateExecutionCapability`) is a clean later-option → 010 backlog.
- **C. Owner read-scoping semantics.** Default: owner view = ALL bots whose `ownerId` matches, regardless of `creatorType` (owner = tenancy boundary, decision 10). If product wants agent-created bots hidden from a user's list, that's a genuine segregation decision. Confirm in the ratification batch; slice builds on the default (008 §6.3), cheap veto.


## 2026-09-12 — CORRECTION to the bot-consumer contract rulings (false premise found; A + B RE-OPENED)

The 2026-09-12 "Bot-consumer contract" rulings for `POST /bots` (ruling 2: 202/id-later) and capability validation (ruling 3: async) rested on a **FALSE PREMISE** — that Traderton's `create_bot` writes the bot row asynchronously "on the next tick." Verified in code, that is WRONG:

- **The bot row is written SYNCHRONOUSLY** during the `create_bot` boundary call. `create_bot` (`packages/worker/src/tools/bots.ts`) does `await ctx.publishToInbound('MANAGE_BOT', {create_and_start})`; in the boundary composition `publishToInbound` is the IN-PROCESS `createDriveTarget` (`packages/worker/src/composition/drive-target.ts`), whose `createAndStart` runs `await deps.botLimit.tryCreateBotWithLimit(...)` — an atomic count+insert that PERSISTS the row and returns `{created, botId}` — then enqueues the START job. **Only the actor START is deferred**, not the row.
- **`create_bot` DISCARDS the synchronously-available id**: `createAndStart` returns `void`; the tool returns a hardcoded `{ok, note:'…next tick'}`. The "next tick" note is MISLEADING — only the start is deferred.
- **Config + mode validation are SYNCHRONOUS** (`BotConfigSchema.safeParse` + `checkModeEscalation` throw before persist).
- **The paper+swap capability check (`validateExecutionCapability`) is NOT WIRED into the live boundary create path at all** — it exists only in `packages/worker/src/_deferred-authoring/api-routes/` (quarantined, excluded from build/tests). So over the boundary today paper+swap is neither a sync 400 nor an async rejection — it is an ABSENT check (a parity GAP vs herobids, which validated it synchronously).

**Consequence:**
- **Ruling 2 (202/id-later) is RETRACTED.** A synchronous **201 + id** IS achievable without polling or re-coupling — the `botId` is already produced synchronously and merely dropped. The question re-opens as: plumb the id through `create_bot`'s return (→ herobids 201+id, parity-preserving) vs keep the void/202 fire-and-forget shape. Contract + copy-vs-author call → RE-ROUTE.
- **Ruling 3 (async capability) is RETRACTED / re-framed.** paper+swap is currently a GAP in the live path, not "async." Restoring parity = wire `validateExecutionCapability` into `createAndStart` (un-quarantine copied logic; copy/adapt, not authoring), which would make it a SYNCHRONOUS rejection again. Question: restore it (sync) vs leave the gap. Parity-restoration + copy-vs-author call → RE-ROUTE.
- **Ruling 1 (reads over boundary), 4 (owner-scoped read surface — BUILT), 5 (interim keep local reads) STAND** — unaffected by this premise.
- **C (owner read view) STANDS** with the human's refinement: owner sees all bots by `ownerId`, STRUCTURED so creator (`creatorType`/`creatorId`) is visible.

A + B re-routed to the decision agent with these corrected facts (next). Nothing was committed on the wrong premise beyond docs; the owner-scoped read slice (ruling 4) is correct and unaffected.


## 2026-09-12 — Bot-consumer contract: HUMAN RATIFICATION (A/B/C final)

The human ratified the corrected bot-consumer contract. All flags cleared; these are the FINAL settled positions for the bot re-point slice:

- **A1 (RATIFIED): `POST /bots` returns 201 + botId.** Plumb `{ok, botId}` through `createAndStart` → `create_bot`'s return (the id is synchronously available from `tryCreateBotWithLimit`); herobids returns 201 + id (parity with the pre-migration contract). Correct the misleading "next tick" note (only the actor START is deferred; the row + id are synchronous). Supersedes the retracted 202/id-later ruling.
- **B1 (RATIFIED): wire `validateExecutionCapability` into the live `createAndStart` path** (un-quarantine the copied `@traderton/domain` check; copy/adapt) so paper+swap is rejected SYNCHRONOUSLY → boundary failure → herobids 400. Restores the pre-migration parity gap. **Error-code (human choice): a DEDICATED capability code** (e.g. `execution_capability.paper_swap_not_supported` mapped to 400), preserving the pre-migration error identity/message — NOT the generic `validation.invalid_payload`. Supersedes the retracted async ruling.
- **C (RATIFIED, refined): owner read view = ALL bots whose `ownerId` matches, STRUCTURED so creator is visible** — surface `creatorType`/`creatorId` in the owner-scoped read payloads (`list_owner_bots`/`get_owner_bot_status`) so a user can tell "I made this" from "an agent made this for me." This is an intentional ADDITIVE divergence from the agent-scoped `list_bots`/`get_bot_status` shape (which omit creator) — logged as such, not a byte-parity match.

Rulings 1 (reads over boundary), 4 (owner-scoped read surface — built), 5 (interim keep local reads) stand. The bot re-point slice proceeds on these.


## 2026-09-12 — Wave A1: bot deletion over the boundary (008-routed; decision agent)

Pivotal verified fact: **NO FK points to `bots`** (fills/orders/positions/journal are actor-scoped by string `actorId`; `token_safety_overrides.botId` is a soft nullable text ref). So a hard bot-row delete orphans nothing and the forensic trail survives — hard-delete is safe AND copy-faithful (herobids' pre-migration DELETE was a hard row delete; no archival concept exists → soft-delete would be authoring).

**SETTLED (rule-forced):**
- **S1:** a `delete_bot` boundary tool MUST exist (leaving the Traderton-owned bot orphaned on a herobids-local delete is a silent divergence). 
- **S2:** `delete_bot` mirrors the `deprovision_venue_account` shape — `ownerScopedNoVenue`, `write-database`, owner-scoped existence via `getBotByIdForOwner` (→ `not_found.resource`), db/owner-unavailable → `fault:true`, hard-delete the row in a tx, metadata-only success `{botId, deleted:true}`.
- **S3:** refuse to delete a `running` bot (copied herobids 409 "stop it first") — a STATUS guard on the bot's own status (NOT deprovision's any-referencing-bot guard); dedicated errorCode mapped to 409.
- **S4:** herobids DELETE routes over `delete_bot` as authoritative, fail-closed (503 when boundary absent) — same posture as create/stop/start. Reject H-b (local-authoritative) + H-c (skip local mirror).
- **S5:** interim local-mirror delete stays but runs **boundary-first** (invoke delete_bot; only on success delete the local row, owner-scoped). Prevents split-brain/orphan. The local delete line is removed at D1 with the table.

**FOR THE HUMAN (pending ratification, safe default — proceeding per 008 §8.2):**
- **H-1:** confirm hard-delete is the intended terminal semantics (no forensic-retention policy requiring bot-config rows to persist). Default (proceeding): hard-delete — copy-faithful; forensic trail is FK-independent and survives. Retention, if ever wanted, is a POST-migration 010 item (would author new behaviour; must not ride this wave).


## 2026-09-12 — Wave A2: owner-scoped bot read-wave SHAPE (008-routed; decision agent)

The 5 herobids bot-detail read endpoints (costs/sessions/events/journal/journal-summary) read Traderton-owned `fills`/`journalEvents` LOCALLY. Verified: their handler bodies are BYTE-IDENTICAL to the quarantined Traderton copy (`_deferred-authoring/api-routes/bots.ts`) — so this is un-quarantine, not authoring. `get_analytics` does NOT subsume them (agent-scoped, time-windowed, different shape) — brief premise corrected.

**SETTLED (rule-forced on the core axis): S-C hybrid.**
- **S-B (herobids re-aggregates) is RULE-UNACCEPTABLE** — re-homes trading aggregation (fee-grouping, session-pairing, summary) into herobids = legal-isolation + copy-never-author violation. Aggregation MUST execute in Traderton.
- **3 dedicated owner-scoped AGGREGATION tools** (un-quarantine + adapt agent→owner, reusing the identical copied bodies): `get_owner_bot_costs` → `{botId, feesByCurrency}`; `get_owner_bot_sessions` → `{botId, sessions, limit, offset}` (pairing server-side); `get_owner_bot_journal_summary` → `{botId, tradeCount, feesByCurrency}` (verify exact summary shape).
- **1 owner-scoped RAW journal-read tool** `get_owner_bot_journal({botId, type?, limit, offset?})` → `{events}` serving BOTH `/journal` and `/events` (events = filtered read, NOT aggregation → no herobids-side logic). herobids passes results through verbatim.
- Every tool follows the landed `get_owner_bot_status` shape: resolve via `getBotByIdForOwner(botId, ctx.ownerId)` → `not_found.resource` (fault:false) if absent/unowned → compute/return. category read-database. Ownership gate preserved (replaces the local `bots` where(id,userId)).
- **All 5 endpoints / 4 tools are cutover-blocking as a SET** — each reads a local trading table; leaving any local blocks dropping the tables at D1.
- herobids endpoints keep the boundary-first + local-fallback posture (consistent with the delete/get routes); local reads removed at D1.

**FOR THE HUMAN (pending ratification, safe default — proceeding per §8.2):** tool granularity for the 2 pass-through reads — default = ONE shared `get_owner_bot_journal` (4 tools total); could split events/journal 1:1 (5 tools). Naming/ergonomics only, no rule impact.


## 2026-09-12 — H-1 RESOLVED by parity (no ratification needed)

Verified against herobids `main` (pre-migration production): the original `DELETE /bots/:id` handler does `await db.delete(bots).where(eq(bots.id, id))` — a HARD row delete. Searched every historical revision of `bots.ts` across all branches: ZERO soft-delete/`deletedAt`/archival/`status='deleted'` markers, ever.

So Traderton's `delete_bot` hard-delete is **copy-faithful** — it reproduces exactly what herobids did. It HONOURS copy-never-author; it does not violate/contradict/undermine anything. The earlier decision-agent escalation of H-1 as a "product call (retain config for audit?)" was an OVER-ESCALATION: retention is a capability herobids never had, so adding it would be authoring a new feature (forbidden mid-migration), and NOT adding it is not a degrade — it's parity.

**H-1 is SETTLED by parity — NOT pending ratification.** The standing ratification queue is now EMPTY. (Lesson: the ratification test is "does it go AGAINST a rule?", not "does it touch deletion semantics?" — a copy-faithful behaviour needs no sign-off even when the topic sounds consequential.)


## 2026-09-12 — Wave B1: hybrid-sizing price re-point (008-routed; §9 gate = SETTLED BY PARITY, no ratification)

herobids `resolveHybridTargetSize` (hybrid-decision-sizing.ts) uses `priceService.resolvePriceTarget` and flows `resolvedChain`/`resolvedAddress`/`resolvedSymbol`/`source` into go_long decision metadata (agent.ts ~3320). The boundary `get_price` tool calls `getPrice` and does NOT surface the resolved identity → re-pointing to it would DROP those fields (feature-drop). Traderton's context priceService already exposes `resolvePriceTarget` — so a boundary tool surfacing it is copy-faithful.

**§9 gate:** step 1 parity — preserving the resolved shape REPRODUCES herobids → settled by parity; step 2 — the copy-faithful option violates nothing.

**RULING (rule-forced, P-A): add a distinct boundary read tool `resolve_price_target`** (thin wrapper over `ctx.priceService.resolvePriceTarget`; shape `{ok, symbol, chain, address, name, priceUsd, source, fetchedAt, stale}`, mirroring get_price's structure). Re-point B1 `resolveHybridTargetSize` to it.
- Rejected P-B (re-point to get_price) = silent feature-drop → violates parity-not-liveness.
- Rejected P-C (extend get_price to also resolve) = authors a getPrice/resolvePriceTarget merge herobids does NOT have + mutates a shared tool's contract for unrelated callers. P-A reproduces herobids' two-surface split faithfully.
- **Shared surface B1+B3:** ONE tool serves hybrid sizing (B1) AND the watch tools (B3, which also use resolvePriceTarget for pinning). B1 builds it; B3 re-points to it. B2 (plain price) stays on get_price.
- No ratification (settled by parity); one new 005 read-tool surface (expected, parity-justified).

---

## B3 — watch tools over the boundary + watch-evaluation ownership (2026-09-12, decision agent; SETTLED within rules, no ratification)

**Context.** B3 re-points the herobids agent watch tools (`watch_token`/`remove_watch`/`check_watches`/`list_watches`, `apps/worker/src/tools/watch.ts`) over the Traderton boundary. Parity-check surfaced two seam issues beyond a clean tool re-point:

1. **`instrumentRepo` not wired in the boundary factory** (traderton `packages/boundary/src/bin.ts` — wires redis/botRepo/priceService/marketDataRegistry but NOT instrumentRepo). Consequence: over the boundary `watch_token` skips the instrument-identity block → protective watches (stop_loss/take_profit/exit) that rely on auto-linking (no explicit `coverage.targetPosition`) are REJECTED by the fail-closed guard, though they succeed in-process. Same gap makes boundary `find_instrument` always return `instrument.repo_unavailable`. → **B3-pre**: construct `new InstrumentRepository(db)` (already exported by `@traderton/db`; the `db` handle is already in the factory) and add it to the returned context. Mechanical composition-root wiring, authors no trading logic → **settled by parity / within rules**. Unblocks both `watch_token` protective auto-link and `find_instrument`.

2. **Watch-state split-brain + the platform monitor.** Watch state is Redis `agent:watches:{agentId}` (+ `:summary:` + `:notified:`). B3 moves the TOOLS' reads/writes to Traderton's Redis. But (a) the herobids worker's `market-intelligence/monitor.ts` `evaluateWatches()` is still constructed/started (herobids `index.ts:925`, local `redisClient`), reads+writes `agent:watches:*` locally and emits `agent.wake` (watch_threshold); and (b) the agent per-tick reader `loadActiveWatchSummary` (herobids `agent.ts:792`) reads `agent:watches:summary:*` locally. Landing B3 alone → monitor sees an empty local set → **watch-threshold wakes silently stop** + the agent's own watch summary goes stale = a silent parity DEGRADE.

**Decision (Option D — evaluation authority = Traderton `check_watches`; monitor = thin platform consumer).** Traderton `check_watches` already runs the identical edge-trigger logic, persists `lastConditionMet`/`lastCheckedAt`, refreshes the summary, and returns the triggered set — it is the single evaluation authority. The herobids monitor stops scanning/evaluating local watch state and instead, per active+subscribed agent, invokes `check_watches` over the boundary and consumes the returned `triggered[]`, doing ONLY platform work (session-active filter, wake-prefs filter, scanner-gated context-only mode, dedupe, rate-limit, `emitMarketWatchTriggered`, `enqueueWake`). The agent per-tick summary reader is re-pointed to source the summary over the boundary too. This draws the platform/trading line exactly: **evaluation + watch state = Traderton; wake emission = herobids platform.** No trading evaluation is authored in herobids (consumes existing `check_watches`) — only a thin seam.

**Sequencing (binding): B3 must NOT land alone.** B3-pre (traderton instrumentRepo wiring) + the 4 watch-tool re-points + the monitor re-point + the summary-reader re-point land ATOMICALLY in the same slice, else the branch has the Option-A silent degrade as an intermediate state. Fallback ONLY if the monitor/summary re-point proves materially larger than one slice: **Option C** — land B3 tools with the local watch-wake path explicitly DISABLED + a logged Deferred-required cutover row (a temporary, logged gap on a branch; still no merge, still no ratification). Never fall back to Option A (silent).

**Rejected:** A (leave monitor local → silent degrade, violates "must not degrade"); B (monitor re-implements evaluation off boundary-fetched raw state → drifts toward authoring evaluation in herobids, weaker on copy-never-author); C as primary (turns wakes OFF when a same-slice D is available — fallback only).

**Implementation mechanism note (assigned to Implementer, not a further decision):** the monitor runs in the main worker process looping over many agents, so it needs, per active agent, that agent's `ownerId` + a write boundary bound to that agent's subject to invoke owner-scoped `check_watches`. `systemReadBoundary` (SYSTEM subject, read-only) is insufficient. Resolve `ownerId` per agent from the existing session/agent registry and construct a per-subject write boundary (the write adapter takes the subject per-call).

**§9.3 gate result:** parity-check — the correct end-state reproduces herobids `main` observable behaviour (wakes still fire, summary fresh); D relocates only *where evaluation authority lives* (Traderton), consistent with the already-settled regime re-point. Violation check — D enforces the top isolation rule, honours parity (no drop), honours copy-never-author. **SETTLED WITHIN THE RULES; wake-firing itself settled by parity. No human escalation, no ratification.** (Only the Option-C fallback would log a temporary Deferred — still no ratification.)

**Out of scope for B3 (logged, not dropped):** `resolve_watch` (lives in `resolvers.ts` with resolve_bot/resolve_task — routes with the resolvers group later; still reads local Redis until then, no split-brain once both land on the same boundary). `generate-narrative.ts` diagnostic reads of `agent:watches:*` (read-only, eval-time; low priority note).
