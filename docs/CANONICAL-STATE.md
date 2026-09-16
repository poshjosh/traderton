# Traderton — Canonical State

**Status:** living. **The single source of truth for what is TRUE NOW** — current state, target
state, the invariants (law), and the settled decisions. **Created:** 2026-09-08 (doc-consolidation at
the extraction→consumption phase boundary).

> **Read this first.** It is the map. When it and any other doc disagree about *current state,
> decisions, or invariants*, **this document wins** and the other is stale — fix the other. Where this
> doc points you to a still-live doc for depth (the *why*, the parity detail, the contract), that doc
> remains authoritative *for its own scope*; this brief is authoritative for the summary + which docs
> are live. Historical plans live in [`archive/`](../archive/) — do not re-execute them.

---

## 1. What Traderton is (one paragraph)

Trading infrastructure for AI/LLM agents (crypto now; forex/commodities/equities later), exposed over
an HTTP API now and MCP/skills later. It is being **extracted from the herobids monorepo by
copy-and-delete** so that **herobids becomes a runtime consumer of Traderton**: the agent + messaging
platform stays in herobids; everything trading (bots, decisions, execution, the 25 trading tools)
lives in `@traderton/*`; herobids invokes it (`submit_decision`, `create_bot`, …) supplying an
authenticated `ownerId` + `actor`. Repos: `traderton` = `/Users/chinomso.ikwuagwu/dev_ai/traderton`;
`herobids` = `/Users/chinomso.ikwuagwu/dev_ai/herobids` (source).

## 2. Current state (2026-09-08)

- **Extraction (M1 library) is complete.** `@traderton/{domain,db,engine,market-data,venues,strategy,
  backtesting,worker}` are extracted, build strict, lint clean, copied parity tests green. The
  in-process library is whole (`createTradingRuntime(...)`). Details per capability: the parity ledger
  [001](./001-parity-ledger.md).
- **Phase 9b authoring (items A–E) is complete** on `main`: config shape, composition root, decision
  intake, drive path + the 25 tools, per-owner `maxBots`.
- **F — the M2 REST boundary — is COMPLETE** on branch **`f-m2-rest`** (NOT merged to `main`). It is
  `@traderton/boundary`: Fastify shell + HMAC auth + envelope/version validation + the `tools:invoke`
  dispatcher (deadline + idempotency + side-effecting dispatch) + the status endpoint + `/health/*` +
  a Postgres `boundary_invocations` idempotency store + a compose stack + a dev signing helper.
  Built in four slices **F1** (read-only shell) → **F2a** (idempotency store) → **F2b** (dispatcher
  integration) → **F2c** (stack + the 7 required-verification tests). **Proven end-to-end**: `docker
  compose up` reaches a healthy `/health/ready`, and all 7 of 005's required-verification tests pass
  against real Postgres+Redis (14 assertions, incl. compose startup). F2a's advisory-lock idempotency
  was additionally proven against live Postgres (fails without the lock — a real test).
- **L1 (in-repo integration harness)** is done on branch `l1-integration-harness` (found + fixed a real
  `venueAccountId` consumability gap; the *fix* was cherry-picked to `main` as `f7a0dd1`; the *harness*
  stays on its branch as scaffolding, per the merge gate). **L2 (differential)** was deliberately
  **SKIPPED** (no faithful mechanical reference exists — [024](./024-verification-and-consumption-roadmap.md)
  L2 skip note + [004](./004-decision-log.md)).
- **`main` holds only the extraction + M1 authoring + the L1 fix.** F, the compose stack, and all
  verification scaffolding live on branches, per `main`-branch discipline (§4). **Nothing is merged to
  `main` for F**, and the merge gate is unmet (§4).

### 2.0 No pre-existing production data — GREENFIELD cutover (2026-09-12, human-stated; TRUTH-NOW)

**There is NO real/production data. We are starting afresh.** There are no pre-existing
trading-credential, venue-account, bot, fill, journal, or user_credentials ROWS to migrate.
This is a **greenfield cutover**: after cutover, all trading links/bots/data are created NEW
directly in Traderton (via `provision_venue_account`, `create_bot`, the drive path, etc.).

Consequences (binding on the D-wave):
- **D2 (migrate pre-existing trading-credential + venue-account rows) collapses to a NO-OP** —
  there are no rows to migrate. It remains as a documented "confirm-empty + drop the old table"
  step, not a data-migration project. The `Deferred (required for cutover)` obligation is
  satisfied by the absence of data.
- **D1-cred carve-out needs NO backfill** — the new herobids-local `platform_credentials` table
  starts empty; there are no non-trading credential rows to copy over. New non-trading links land
  in the new table directly.
- The old shared `user_credentials` table DROP is no longer gated on a data migration — once its
  code consumers are re-pointed (D1-cred non-trading half + the D1-c4 trading-validation re-points),
  it can drop (it is empty).
- **D3/D4 need no data-seeding** — cross-stack E2E + staging soak run against freshly-created data.
- Nothing else in the parity/copy discipline changes: parity is still measured against herobids
  `main` BEHAVIOUR, not against any dataset.

### 2.1 L3 consumption progress (2026-09-12 — supersedes the older §3.1 D4 sub-phasing for CURRENT STATE)

The §3.1 "L3a/b/c/d/e" sub-phasing was the original plan; the actual work has run as a series of
per-capability re-point slices on herobids `consume-traderton` + traderton `l3-integration` (both
branches, NOTHING merged to `main`; the merge gate remains the one hard stop — see §4 + the autonomy
contract in [008 §6](./008-decision-process.md)). Decisions are made via the [008](./008-decision-process.md)
process. **What is DONE (re-pointed to the boundary, on branches):** REST boundary consumption (L3a/b/c),
write/read adapters; **provisioning** (L3-P1b: `provision_venue_account`/`deprovision_venue_account`);
**venue-account plan-limit** via `count_venue_accounts`; **regime** (market-intelligence coordinator +
evidence → `check_regime`, telemetry re-sourced); **orderbook `score_candidate`**; **discovery**
(coordinator → `discover_tokens`, widened multi-network); **risk-limits** read (`get_risk_limits`, read-
fallback) + write (`adjust_risk_limits`, fail-closed); **bots** (submit_decision + lifecycle). The
market-intelligence coordinator no longer imports `@herobids/market-data`.

**CORRECTION (important — the old "extract the in-process scan pipeline" framing is now STALE):** the
classic in-process scan pipeline (`technical-phase`/`complete-technical-scan`/scanners/swap-discovery/
swap-token-resolver/token-safety) was already deleted from the live runtime with the "L3d-5 actor slice";
**B1 (2026-09-12) deleted the dead files.** It was NOT a live surface. `@herobids/engine` is **type-only**
everywhere (all importers) — no engine value runs in-process. `TechnicalScanState` + its consumers are
LIVE and KEPT (herobids consumes `agent.technical.scan_completed` messages Traderton now produces).

**What REMAINS (the real surviving in-process market-data surface):**
- **B2 — agent-container tick-loop couplings** (`apps/worker/src/agent.ts`): regime eval (→`check_regime`),
  volatility candles for ATR/adaptive-interval (GAP — no candle-series tool), hybrid sizing
  (`priceService.resolvePriceTarget` — get_price contract mismatch), venue-intelligence reads (assetContexts/
  longShortRatio/discover/dexscreener), economic-calendar cache-read. **Scope decided (human, option 1):**
  re-point the tick-loop couplings now; **DEFER full registry removal.**
- **The agent-container READ TOOLS surface (its own slice, NOT B2):** `tools/price.ts`, `tools/market-data.ts`,
  `tools/watch.ts` consume `ctx.marketDataRegistry`/`ctx.priceService` in-process. Until these re-point,
  `createProviderRegistry`/`createPriceService` **cannot** be removed from the agent container — so "no
  market-data in the agent process" is NOT achieved by B2 alone. Tracked as a cutover obligation in
  [001](./001-parity-ledger.md).
- **B3 = the deferred swap `score_candidate` build** (token→pool behind the boundary; approach ratified).
- Then package/table deletions (LAST) + L3e differential/soak + the merge gate.

## 3. Target state & what's next

**End state:** herobids consumes `@traderton/*` and its own trading code is retired; Traderton runs as
a separately-deployable unit. Two consumption paths exist and **both are permanently supported** — the
choice between them is a *deployment* decision, not an architectural one (§4 invariant):

- **In-process library (M1 path):** herobids imports `@traderton/*` and calls the ports directly,
  injecting the platform-owned values (`ownerId`/`actor`, resolved `venueAccountId`, grant validity,
  the `maxBots` decision). Lowest latency; first-class and kept working forever. Today used for
  dev/test/eval.
- **REST boundary (M2 path):** herobids calls `@traderton/boundary` over HTTP with the 005 HMAC
  contract. This is the **legally-motivated shipping posture today** (payment providers restrict
  trading, so trading must be isolable off the platform's payment rails — [004](./004-decision-log.md)).

**SETTLED — herobids consumes over REST (M2); there is no in-process cutover.** This is recorded across
[000](./000-vision.md), [004](./004-decision-log.md), and [024](./024-verification-and-consumption-roadmap.md)
(L3 row: "over F's REST boundary (NOT in-process — legal constraint)"; sequencing: "the REST boundary is
the ONLY shape a consumer legally uses — there is no in-process cutover"). The legal reason is decisive:
consuming in-process would put `@traderton/*` back inside the herobids deployable, re-coupling trading to
the platform's payment rails — the exact thing the split exists to prevent. **In-process is NOT the cutover
path.** It remains a *permanently-supported non-cutover* path (dev/test/eval today; a future shipping option
only if the legal hurdle lifts — invariant 3). So: which shape herobids *ships/cuts over* in is **decided —
REST**; in-process is kept alive but is not how herobids consumes in production.

**Immediate next work: herobids consumes Traderton over REST** (the merge-gate work). Governed by the
verification & consumption roadmap [024](./024-verification-and-consumption-roadmap.md); the level structure
is L1 (done) → L2 (skipped) → **F (done)** → **L3 (herobids consumes over REST → cutover)**. L3 is the next
milestone. See §5 for the ownership-rule change L3 forces.

### Open decision — market-assessment ownership (2026-09-16)

`market_assessment_requests`/`_runs`/`_artifacts` and their Herobids worker
orchestration are **temporarily retained in Herobids**. This preserves a working
agent-preset review path and the completed c4.9f table drop remains correctly
scoped: the three tables are not part of that drop.

This is **not** a final determination that the capability is outside the legal
trading boundary. Market assessment consumes Traderton market/scoring evidence
and chooses an agent preset used for future entries. Before legal-isolation
sign-off / final cutover approval, an 008 decision brief must decide the whole
workflow: permanent Herobids retention as an explicit exception, complete
Traderton ownership, a deliberate split, or removal/deprecation. See
[004](./004-decision-log.md), [001](./001-parity-ledger.md), and
[011](./011-premerge-backlog.md).

### 3.1 L3 plan (herobids consumes over REST) — decisions locked 2026-09-08

The investigation + proposal are in **herobids** on branch `consume-traderton` (the working spec lives where
the work is; it points back to this brief + [005](./005-consumer-boundary-contract.md)). The seam: herobids
deletes its in-tree trading execution (packages `engine`/`venues`/`market-data`/`strategy`/`backtesting` +
the worker actor/runtime loop + the trading DB, **incl. the `bots` table + all `maxBots` logic** — see §3.2 #4)
and rewires ~5–6 fusion points (the message-broker `handleManageBot`, the decision handler
`handleDecisionSubmit`, the worker composition root, the API bot route, the `ToolContext` type, the read
tools) to signed REST `tools:invoke` calls, keeping the platform grant layer / broker / LLM / (pre-boundary)
approvals and injecting only `ownerId`+`actor` into the 005 envelope.

**Locked decisions (D1–D5):**
- **D1** — work on herobids `consume-traderton`; herobids `main` + all other branches untouchable; merge =
  cutover, human-approved (invariant 5).
- **D2 — venue-account ownership + what crosses the wire (CORRECTED 2026-09-08 to match the 005 contract):**
  **Traderton owns `venue_accounts` + `user_credentials` and RESOLVES the venue account itself** (its
  `subject-resolver.ts` reads its own DB — `getBotById` for bot-scoped tools, `listVenueAccountsByOwner`
  for `submit_decision`/`create_bot`). **herobids injects `ownerId` + `actor` ONLY** — the 005 envelope
  (`TradertonToolInvocationV1`, `.strict()`) has NO `venueAccountId` field, so nothing else can cross the
  wire. *(The earlier D2 wording — "herobids injects `venueAccountId` from `connections.resolvedVenueAccountId`"
  — was the stale pre-extraction in-process mental model; it does not apply on the REST path and is void.)*
- **D3 — `submit_decision` async mapping:** the current synchronous 30s Redis-BLPOP reply maps onto 005 as
  **invoke → poll `GET invocations/:requestId` to the deadline**, preserving all reply statuses. **`pending_approval`
  is NOT a Traderton concept** — Traderton has no approval machinery (the `decision_approvals` table +
  `ApprovalService` were deleted; the `TradertonToolResultV1` outcome union is only `success`|`failure`). The
  herobids approval gate runs **entirely pre-boundary**: if a decision needs approval, herobids produces
  `pending_approval` itself and does NOT call the boundary; on human approve it calls `submit_decision` as a
  plain execute. `pending_approval` never crosses the wire. *(Polling shortcoming + push/webhook alternative:
  backlog B10 ([010](./010-improvement-backlog.md)).)*
- **D4 — sub-phasing:** **L3a** (Traderton REST client + config + signer; no rewire) → **L3b** (rewire the
  read tools) → **L3c** (rewire the side-effecting path) → **L3d** (delete the trading packages + worker
  loop + trading DB) → **L3e** (REST-boundary differential + staging soak + the merge gate). Read-path
  before write-path; delete last (mirrors F1's read-only-first). **P1 (venue-account provisioning, §3.2) is
  its own slice before L3e.**
- **D5 — doc placement + repo-of-record transition (see §5.1).**

### 3.2 L3c investigation — cross-boundary items surfaced + resolved (2026-09-08)

L3c investigation surfaced four things that cross the herobids/Traderton boundary. All resolved with the
human; recorded here (Traderton is the authority until cutover).

- **#1 — D2 wording was stale.** Resolved: see the corrected D2 above. herobids injects `ownerId`+`actor`
  only; Traderton owns+resolves `venue_accounts`. (herobids' own D2 §8 to be corrected on its branch.)
- **P1 — venue-account provisioning into Traderton (a real gap; its OWN slice before L3e).** For
  `submit_decision`/`create_bot` to work end-to-end, Traderton's `venue_accounts` (+ `user_credentials`)
  must already hold the owner's account, or `subject-resolver.ts` returns `precondition.not_ready`. There is
  **no provisioning tool** in the 005 contract/registry today. **Decision:** author a Traderton
  **`provision_venue_account`** boundary tool, **COPIED from the trading half of herobids' holistic
  connection-provisioning endpoint** (herobids keeps the `connection`/`agent_connection` half — the KEEP
  side of the seam; Traderton copies the `venue_accounts` + `user_credentials` half — the OWN side). This is
  **new 005 surface** and carries **`user_credentials` (venue API keys) across the boundary** → it requires
  its own credential-custody design pass (transport, encryption-at-rest, never-logged). **Its own slice
  (L3-P1), sequenced AFTER L3c authoring, BEFORE L3e** (L3c unit-tests against a stub and does not need it).
  Staging may operator-seed accounts in the interim. **APPROVED 2026-09-08 —
  [docs/features/L3-P1-provision-venue-account-proposal.md](./features/L3-P1-provision-venue-account-proposal.md);
  decisions:** **D1** = ONE tool `provision_venue_account` (credential + venue_account in one idempotent
  call, returns `venueAccountId`); **D2** = credentials cross the wire in the payload (HMAC+TLS →
  `encryptCredential` at rest → never logged; result is metadata only); **D3** = the copied per-user
  plan-limit (`checkCredentialLimit`) is DROPPED at the boundary (herobids pre-boundary concern, like #4);
  **D4** = runs now on a Traderton branch, parallel to herobids L3c, before L3e. **Key:** the trading half is
  already COPIED into the quarantine (`crypto.ts`, `_deferred-authoring/api-routes/{credentials,accounts}.ts`,
  the `user_credentials` schema) → L3-P1 is un-quarantine+adapt (JWT-route→HMAC-tool, `userId`→`ownerId`),
  not author.
- **P2 — Traderton `authorizationMode` is vestigial → make it honest.** `packages/boundary/src/bin.ts`
  hardcodes `authorizationMode: 'approval_required'` on the built `TradingToolContext`, but Traderton has no
  approval machinery (deleted). **Decision:** set it to `'direct'` (the boundary executes what it is given;
  approvals are the consumer's pre-boundary job — see D3). One-line `bin.ts` change (a remaining
  Traderton code step, not blocking L3c authoring).
- **#4 — herobids owns NO bot state or maxBots logic; Traderton owns bots + `maxBots` ENTIRELY.** Rationale:
  the legal isolation says trading policy (a bot-count limit) and trading state (a `bots` table) must not
  live on the platform. So herobids has **no `bots` table and no maxBots enforcement**;
  `create_bot`/`start_bot`/`list_bots`/etc. all go to the boundary; Traderton enforces the limit (it already
  has the per-owner `maxBots` advisory-lock primitive from item E). Forward design: `maxBots` **tiered by
  authorization/permission level** (a VALUE herobids may inject, but ENFORCED by Traderton). In L3c,
  `create_bot`/`start_bot` are **boundary-only** (no herobids `bots` write); herobids' `bots` table is
  deleted at L3d (after auditing its consumers).

## 4. Invariants — the law (do not break)

1. **Copy, never author.** Every line of trading behaviour arrives by being **copied** from herobids,
   never authored from a model of how it "should" work. The only authored things are **deletions** and
   **thin seams**. (Extraction is mostly done, so this now mostly governs re-syncs + any remaining
   copies; it still binds.) Full rationale: [004](./004-decision-log.md); vision: [000](./000-vision.md).
2. **Ports carry values, never trading behaviour.** A consumer may inject through a port only
   platform-owned values Traderton does not own (resolved `venueAccountId`, grant validity, `maxBots`,
   `ownerId`/`actor`). A port must never let a consumer inject the risk gate, planner, executors,
   reconciliation, or fill/position accounting. If a proposed port would carry trading logic, the seam
   is mis-drawn.
3. **In-process must always remain a first-class, working consumption path; REST is an adapter over the
   SAME ports, never the only door, and never leaks HTTP/HMAC concerns into the core.** Deployment
   decides which ships; architecture keeps both alive. Do NOT collapse this into "REST-only, delete
   in-process."
4. **`main` holds ONLY production target-state or milestone code we keep for a while — NEVER
   indeterminate, temporary, or scaffolding state.** Verification harnesses and intermediate work live
   on branches until decided. Keep durable fixes SEPARATE from scaffolding.
5. **The merge gate — merge to `main` only when ALL hold:** (1) herobids consumes the Traderton
   library; (2) all tests pass; (3) the setup has been run locally AND on staging for a while (manual,
   visual, black-box); (4) explicit human approval. "Reviewed + green" is NOT license to merge. **Never
   merge to `main` without the human's explicit approval.**
6. **herobids is READ-ONLY — with a coming consumption-phase exception (§5).** Through extraction,
   herobids is never edited: read and copy from it; reshape it only via a **source-fix request** (the
   owner makes/tests/gates/releases it, then Traderton copies). **This rule is about to change for the
   consumption phase — see §5.**
7. **Parity, not liveness.** The bar is feature parity with herobids-today; "it runs" is insufficient.
   Anything not preserved is logged in the ledger [001](./001-parity-ledger.md) as Gap/Deferred/
   Intentional-divergence — never silently dropped. Forced mid-work deviations →
   [003](./003-anomalies-and-deviations.md).

## 5. The consumption-phase rule change (herobids is now editable — IN FORCE, scoped)

Through extraction, invariant 6 held herobids fully READ-ONLY, and [024](./024-verification-and-consumption-roadmap.md)
called the `consume-traderton` branch "herobids-owner territory." **The consumption work (L3) inherently
requires editing herobids** (deleting its trading code, wiring the REST client to `@traderton/*`). So
invariant 6 now carries a scoped exception, **CONFIRMED IN FORCE (2026-09-08, human):**

> **The READ-ONLY rule is lifted for a designated herobids consumption branch ONLY.** On that branch,
> herobids trading code may be deleted and rewired to consume Traderton over the REST boundary (F/005).
> **herobids `main` and every other branch remain untouchable.** The branch's acceptance bar is herobids'
> own trading test suite green + the REST differential; **merging that branch to herobids `main` = cutover
> and requires explicit human approval** (matching the merge gate, invariant 5). Extraction-era copying
> still obeys copy-never-author; this exception is about *consuming*, not *authoring trading behaviour*.

**Working posture (per the human, 2026-09-08):** the work continues *in herobids*, on that branch. Do NOT
edit herobids `main` or any other branch; do NOT treat "herobids is editable" as general — it is the named
consumption branch only.

### 5.1 Doc placement + the repo-of-record transition (D5, locked 2026-09-08)

- **L3 working docs live in herobids** (the branch): the L3 spec + the per-slice implementer prompts are
  authored in herobids `consume-traderton`, where the work is. They point back to this brief +
  [005](./005-consumer-boundary-contract.md) for the invariants/contract.
- **The canonical + invariant/decision docs STAY in traderton for now** — this `CANONICAL-STATE.md` + the
  live docs (001/003/004/005/006/007/010/024) remain the source of truth here **until cutover**, to avoid a
  split-brain mid-migration.
- **Planned repo-of-record transition (record now; execute AT CUTOVER, not before):** herobids becomes the
  **working root** — where day-to-day work / the agent root operates from. This is a *working-location*
  change only: **traderton is NOT absorbed** — it remains a separately-deployed boundary/library service
  (the legal isolation is preserved; its repo persists as that service's home). At cutover (when
  `consume-traderton` merges to herobids `main` and trading genuinely lives behind the boundary), migrate
  `CANONICAL-STATE.md` + the live docs to herobids so authority and working root coincide. Doing the flip
  *before* cutover would leave authority in a repo that still runs trading in-tree — the least-settled
  moment; hence it is deferred to cutover.

## 6. Open decisions (need a human steer before proceeding)

- **O1 — The `f-m2-rest` branch disposition.** F is complete + proven there but unmerged (merge gate
  unmet). It stays a branch until the gate is met; confirm it is not merged early.
- Longer-standing opens (from [000](./000-vision.md) "Open"): the backend→consumer event/streaming
  channel; venue/execution cost reporting across the boundary.

*(Resolved and moved out of this list: the first/cutover consumption path = REST (§3, was O1); who edits
herobids + the read-only exception = agent works on the herobids consumption branch (§5, was O2).)*

## 7. Settled decisions (flat index — the authority for each is in parentheses)

Vision decisions 1–17 ([000](./000-vision.md) "Settled decisions"): 1 own database; 2 own config; 3 own
risk enforcement; 4 no backward-compat obligations (proof discipline still required); 5 usage
metering/payments/caps deferred; 6 M1 in-process first / M2 REST second / MCP+skills later, both paths
supported; 7 bots are mechanical actors; 8 intelligence is the agent's job; 9 `llm` stays agent-side
(no LLM dep/cost center); 10 Traderton is multi-tenant but not the identity/billing authority (opaque
`ownerId`+`actor`); 11 seam sits between `connections` and `venue_accounts`; 12 credential custody
follows the venue caller → Traderton; 13 `bots` re-pointed to soft `ownerId` + `venueAccountId`; 14
`blueprint.ts` stays platform (within-file schema seam); 15 market-assessment splits; 16 mirror
herobids toolchain exactly; 17 rename `@herobids/*`→`@traderton/*`.

Later settled decisions (reasoning in [004](./004-decision-log.md), records where noted):
- **Traderton does not own human approvals** — the consumer asks/holds/expires; Traderton owns only
  `submit_decision` execution. (`decision_approvals` table deleted.)
- **Mechanical-only enforced at two layers**; the config-enum narrowing was done as item A′ (a
  `MechanicalStrategySchema` wrapper; copied `StrategySchema` left byte-verbatim).
- **Soft-reference rule** — no copied table hard-FKs a platform table; every `users` FK → soft `ownerId`.
- **Legal isolation is a DEPLOYMENT constraint, not an architectural law** — trading is
  separately-deployable; REST ships today; in-process stays supported (invariant 3). Latency table +
  full reasoning in [004](./004-decision-log.md).
- **L2 skipped** (no faithful mechanical reference) — [024](./024-verification-and-consumption-roadmap.md).
- **F (M2 REST) decisions D1–D5** ([013 §8.1.1 — archived](../archive/features/013-9b-authoring-plan.md),
  proposal [030 — archived](../archive/features/030-F2-m2-rest-proposal.md)): **D1** idempotency =
  copy-adapt herobids `blueprint-idempotency.ts` + the blueprints route (re-keyed to the 005 4-tuple),
  authoring only the in_progress/status/retention/expiry deltas; **D2** subject→injection = an authored
  resolver reading the target bot/venue-account row; **D3** deadline = pragmatic (pre-check + one
  re-check before `tool.execute`; not threaded into the drive path); **D4** actor-provenance (005 Authz
  item 3) = Option B (operator-config `allowedActorTypes` per consumer; NOT invented per-tool rules);
  **D5** compose = fresh minimal (boundary + Postgres + Redis). Rate-limiting stays out.

## 8. Where things live (pointer map)

**Live docs (authoritative for their scope; stay in `docs/`):**
- [000-vision.md](./000-vision.md) — the goal, the copy-never-author law, "herobids becomes a consumer,"
  the 17 settled decisions. The vision/law. *(Its REST-cutover framing is CORRECT and settled — see §3;
  in-process is a supported non-cutover path, not the shipping shape.)*
- [001-parity-ledger.md](./001-parity-ledger.md) — **the source of truth for capability done-vs-pending
  + the cutover gates.** Acceptance tracking.
- [003-anomalies-and-deviations.md](./003-anomalies-and-deviations.md) — forced deviations + source-fix
  request log. Read/append when you hit a deviation.
- [004-decision-log.md](./004-decision-log.md) — **the *why*** behind every decision. Read when a rule
  seems arbitrary or a case isn't covered.
- [005-consumer-boundary-contract.md](./005-consumer-boundary-contract.md) — the M2 REST/HMAC contract
  (endpoints, envelope, canonical string, failure codes, idempotency, health). The F implementation
  target; read at consumption/cutover.
- [006-source-capability-manifest.md](./006-source-capability-manifest.md) — the static parity
  inventory the ledger scores against.
- [007-operational-readiness.md](./007-operational-readiness.md) — the cutover proof (latency/
  equivalence/restart/rollback). Read at L3/cutover.
- [008-decision-process.md](./008-decision-process.md) — **the outsourced decision process + brief
  template + trigger checkpoint.** Use when a choice risks degrading parity, weakening legal isolation,
  dropping a feature, or changing behaviour/a contract. The implementing agent briefs-and-routes; it does
  not self-rank these.
- [010-improvement-backlog.md](./010-improvement-backlog.md) — deliberate non-blocking later-options
  (B1–B9), graded Value/Effort + Risk-if-deferred. NOT cutover obligations (those → 001/003) or bugs.
- [024-verification-and-consumption-roadmap.md](./024-verification-and-consumption-roadmap.md) — the
  post-M1 level roadmap (L1 done, L2 skipped, F done, L3 next). *(Its REST-only-cutover call is CORRECT
  and settled — §3. Its "L3 ownership = herobids-owner territory" is now superseded by §5: we work the
  consumption branch in herobids ourselves.)*

**Historical (in [`archive/`](../archive/) — reasoning trail; do NOT re-execute):** the extraction
roadmap + phase plans (`archive/002`, `archive/008`, `archive/009`, `archive/features/001-009`), the M1
holistic review (`archive/features/010-012`), the Phase-9b authoring plan + per-item proposals/prompts
(`archive/features/013-023`), the L1/L2 proposals (`archive/features/025,027`), and the F
proposals/prompts (`archive/features/028-033`). These carry the *how we got here* — the landing logs
(e.g. 013 §8.5–§8.8 for F1–F2c) and the item-by-item reasoning. Consult for history; this brief + the
live docs are authoritative for what's true now.

## 9. How work is run (the loop)

Investigate → **[decision checkpoint — route the four-risk choices, [008](./008-decision-process.md)]** →
implement → coordinator loop (Implementer → CodeReviewer → fix-loop → commit → gap-review) → verify
end-to-end → update docs. **The agent runs this continuously to the branch, across slices, without
pausing between them** — the merge to `main` is the ONE hard stop ([008 §6](./008-decision-process.md) —
the autonomy contract). Each level/item on its own branch.

**Decision checkpoint ([008](./008-decision-process.md)):** insert a checkpoint after *investigate*. For
every open choice apply the trigger test — does it risk **degrading parity, weakening the legal isolation,
dropping a feature, or changing externally-visible behaviour / a contract**? If yes, the implementing agent
MUST NOT decide or express a lean — it fills the neutral fact-grounded brief (008 §2) and routes it to a
fresh decision agent; the human ratifies parity/legal-touching outcomes; the decision + reasoning is
recorded in [004](./004-decision-log.md) and any parity impact in [001](./001-parity-ledger.md). Low-stakes
mechanical choices are decided normally. This exists because the implementing agent repeatedly mis-weighted
parity/the top objective — the fix is structural (brief-and-route, never self-rank on the four risks).
