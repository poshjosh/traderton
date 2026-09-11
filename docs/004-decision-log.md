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
