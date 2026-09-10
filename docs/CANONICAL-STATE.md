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

**⚠️ OPEN DECISION — which path herobids consumes FIRST (REST vs in-process) is NOT yet settled.** The
existing docs (000/004/024) over-committed to "REST is the only cutover shape"; that overstates it. The
*settled* facts are: (a) both paths are permanently supported; (b) REST is today's legal *shipping*
posture. What is *open* is which path we build the herobids-consumption work against first. **Do not
treat the first-path choice as decided.** (Awaiting the human's call — see §6 Open Decisions.)

**Immediate next work: herobids consumes Traderton** (the merge-gate work). This is governed by the
verification & consumption roadmap [024](./024-verification-and-consumption-roadmap.md); the
level structure there is L1 (done) → L2 (skipped) → **F (done)** → **L3 (herobids consumes → cutover)**.
L3 is the next milestone. See §5 for the ownership-rule change L3 forces.

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

## 5. The consumption-phase rule change (herobids becomes editable — PENDING confirmation)

Until now the roadmap [024](./024-verification-and-consumption-roadmap.md) drew a hard line: the
herobids `consume-traderton` branch is *herobids-owner territory* — not ours to edit — because editing
herobids violates invariant 6. **The consumption work (L3) inherently requires editing herobids**
(deleting its trading code, wiring `@traderton/*`). So invariant 6 needs a scoped exception for this
phase:

> **Proposed (pending explicit human confirmation): the READ-ONLY rule is lifted for a designated
> herobids consumption branch only.** On that branch, herobids trading code may be deleted and rewired
> to consume `@traderton/*`. herobids `main` and all other branches remain untouchable. Extraction-era
> copying still obeys copy-never-author; this exception is about *consuming*, not *authoring trading
> behaviour*.

**This is not yet confirmed.** Two things must be settled with the human before any herobids edit
(§6): (a) whether the agent edits herobids on that branch or the human drives it; (b) which consumption
path (REST vs in-process) that branch targets first. Until then, treat herobids as READ-ONLY.

## 6. Open decisions (need a human steer before proceeding)

- **O1 — First consumption path: REST (M2) or in-process (M1)?** Both are supported; which does the
  herobids-consumption work build against first? (§3.) In-process needs a package-linkage mechanism
  (workspace/file/pin); REST needs only a base URL + signing secret + the running boundary. Not decided.
- **O2 — Who edits herobids for L3, and confirm the read-only exception (§5)?** Agent-on-a-branch vs
  human-driven. Until confirmed, herobids stays READ-ONLY.
- **O3 — The `f-m2-rest` branch disposition.** F is complete + proven there but unmerged (merge gate
  unmet). It stays a branch until the gate is met; confirm it is not merged early.
- Longer-standing opens (from [000](./000-vision.md) "Open"): the backend→consumer event/streaming
  channel; venue/execution cost reporting across the boundary.

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
  the 17 settled decisions. The vision/law. *(Note: its REST-only-cutover framing is superseded by §3
  here — the first-path choice is open.)*
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
- [010-improvement-backlog.md](./010-improvement-backlog.md) — deliberate non-blocking later-options
  (B1–B9), graded Value/Effort + Risk-if-deferred. NOT cutover obligations (those → 001/003) or bugs.
- [024-verification-and-consumption-roadmap.md](./024-verification-and-consumption-roadmap.md) — the
  post-M1 level roadmap (L1 done, L2 skipped, F done, L3 next) + the L3 ownership boundary. *(Its
  "REST is the only cutover shape" is superseded by §3/§5 here.)*

**Historical (in [`archive/`](../archive/) — reasoning trail; do NOT re-execute):** the extraction
roadmap + phase plans (`archive/002`, `archive/008`, `archive/009`, `archive/features/001-009`), the M1
holistic review (`archive/features/010-012`), the Phase-9b authoring plan + per-item proposals/prompts
(`archive/features/013-023`), the L1/L2 proposals (`archive/features/025,027`), and the F
proposals/prompts (`archive/features/028-033`). These carry the *how we got here* — the landing logs
(e.g. 013 §8.5–§8.8 for F1–F2c) and the item-by-item reasoning. Consult for history; this brief + the
live docs are authoritative for what's true now.

## 9. How work is run (the loop)

Investigate → propose → **pause for the human** → write a self-contained implementer prompt →
coordinator loop (Implementer → CodeReviewer → fix-loop → commit → gap-review) → update docs → pause at
each milestone. Each level/item on its own branch. This loop is unchanged and is how L3 will run.
