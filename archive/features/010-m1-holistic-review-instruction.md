# Holistic Review of Extracted Trading Aspects of Herobids

## Background

Traderton is being extracted from **herobids**, an existing, working system where trading lives fused with an AI-agent + messaging platform. The goal is a standalone trading library that herobids itself will consume — trading (bots, decisions, execution, the 25 trading tools) moves out to Traderton, while the agent/messaging platform stays behind in herobids.

The extraction follows one governing law: **copy, never author.** Every line of trading behaviour must arrive by being copied verbatim from herobids, never rewritten from a model of how it "should" work; the only things authored are deletions of platform code and the thin seams where platform couplings are cut. The reasoning is that rewriting-from-scratch silently loses hard-won detail and then writes tests that assert the loss, whereas copy-and-delete starts from real behaviour and makes any omission visible as a broken build or test. The bar is **feature parity with herobids**, tracked capability-by-capability in the parity ledger — nothing is silently dropped.

The work has run as a sequence of phases, each extracting one slice by copy-and-delete: the domain model, the database layer, the engine (risk gate, planner, executors), market-data, venue adapters, the mechanical strategies, backtesting, and the worker's mechanical trading loop. Where a platform coupling could not be cut by a clean deletion without authoring non-trivial logic, we did not improvise — we requested a behaviour-preserving change in herobids (the owner made, tested, and released it), then copied the improved source. Three such source-fixes have been made and verified. Everything extracted so far compiles under strict TypeScript, passes its copied tests, and is free of platform/LLM imports.

How the end state is sequenced then shaped what gets built when. herobids will consume Traderton in **two milestones over the same ports**: first **M1**, as an in-process library via dependency injection — herobids replaces its own trading by calling Traderton directly, still supplying the things Traderton deliberately doesn't own (the platform grant layer, the message-broker drive, the per-agent bot limit) by injecting them at the call site; then **M2**, where a REST/API boundary is added as a second adapter over those same ports. Because reaching M1 requires no authored boundary code, everything that must be *authored* rather than copied — a Traderton-owned config shape, the trading composition root that wires the loop together, the decision-intake/approval surface, the per-owner bot limit, and eventually the REST layer — was deliberately deferred into a single authoring pass (**Phase 9b**, referred to as "9b" throughout the rest of this document).

We have now extracted everything copy-and-delete can reach: every package plus 18 of the 25 trading tools, all green. That leaves us standing precisely at the boundary between the copied foundation and the deferred authoring pass — and authoring is the one place the copy-never-author safety net is off, where a mistake is invisible in exactly the way this project exists to avoid. Crossing that boundary blind is the risk, and it is that risk that has **necessitated a review** before any authoring begins.

**This review** is that gate. Its job is to confirm the pre-authoring library is a sound, faithful, and complete-as-possible foundation: that everything copied is a faithful copy, that everything copyable has been copied, that every source capability is honestly accounted for, that the pieces cohere as a usable in-process library at the M1 boundary, and that the remaining authoring work is precisely bounded and understood — so that when authoring does begin, its scope is known and the base beneath it is trustworthy.

---

## 0. Orient yourself first (mandatory — read before auditing)

Read, in order, the project memory (they explain the law, the model, and the state):
1. `AGENTS.md` — the copy-never-author law; source-fix rule; where-to-start.
2. `docs/000-vision.md` — goal; the **M1 (in-process library) → M2 (REST/API) two-milestone model**;
   the **"ports carry values, never trading behaviour"** invariant; the two kinds of Deferred.
3. `docs/001-parity-ledger.md` — the live status of every capability (the source of truth for done vs pending).
4. `docs/004-decision-log.md` — the *why* behind the ownership seam, mechanical-only bots, the
   herobids-becomes-a-consumer classification model, the soft-reference rule.
5. `docs/003-anomalies-and-deviations.md` — every forced deviation + the 3 herobids source-fixes (#1 strategy
   registry, #2 trading-protocol types, #3/#3b tool contract) and their resolutions.
6. `docs/009-extraction-roadmap.md` — the phase chain, stop-gates, per-phase lessons, and the 9a/9b split.
7. `docs/006-source-capability-manifest.md` — the static inventory the ledger tracks against.
8. `docs/005-consumer-boundary-contract.md` — the M2 adapter contract (context for the deferred boundary).
9. The per-phase plans in `docs/features/` (esp. `008-worker-*`, `009-api-plan.md`) for the deferral rationale.

**What is deliberately NOT in M1** (the Background defines M1; this is the concrete deferred list you must
hold in mind while auditing — all `Deferred (required for cutover)`, authored in 9b after this review): the
Traderton-owned config shape, the trading composition root, the decision-intake/approval surface,
per-`ownerId` maxBots, the 7 drive-path tools (`submit_decision`/`create_bot`/`start_bot`/`stop_bot`/
`list_bots`/`get_bot_status`/`adjust_bot_config`), the API routes, and the M2 REST boundary.

## 1. Purpose of this review

Confirm that the **pre-authoring library is a sound, faithful, complete-as-possible foundation** before any
authoring begins — because authoring is the one place the copy-never-author safety net is off, so we want the
copied base maximally trustworthy and the authored scope precisely bounded first. Concretely, answer:

1. **Fidelity** — is everything that was copied a faithful copy (not silently authored/degraded)?
2. **Completeness** — is everything copyable actually copied? Is anything deferred that could have been copied?
3. **Accounting** — does every 006 inventory row have an honest 001 disposition (Met / Deferred-required /
   Deferred-optional / Intentional Divergence / Gap) — nothing silently dropped?
4. **Coherence** — do the extracted packages fit together as a usable library at the M1 boundary (the ports
   the consumer will inject into), and is the ports-carry-values invariant intact?
5. **Authoring scope** — is the deferred 9b work fully enumerated, each item tagged, with its invariant
   checks stated, so 9b is bounded and reviewable?

## 2. Method (delegate breadth; keep judgment central)

Prefer delegating the mechanical/broad passes to sub-agents (semantic_reviewer / a context-gatherer) to
preserve your context, then adjudicate their findings yourself. Do the audit READ-ONLY. For every claim,
**verify against the actual source and the built/tested state — never trust a self-report or a doc alone**
(this discipline has repeatedly caught real errors, including in prior reviews).

Baseline to (re-)establish and record: `pnpm build`, `pnpm lint`, `pnpm test` across the repo — capture the
pass/skip counts and note which skips are credential-gated integration suites.

## 3. The audit — what to check

### A. Fidelity of the copy (per extracted package: domain, db, engine, market-data, venues, strategy, backtesting, worker + the 18 tool modules)
- Spot-diff surviving files against their herobids sources modulo the `@herobids/*`→`@traderton/*` rename.
  Flag ANY authored trading logic, reformat, or altered test assertion as a fidelity defect.
- Confirm the sanctioned seams are verbatim relocations, not authored shapes: `scan-types.ts`,
  `watch-summary.ts`, `trading/trading-protocol.ts`, `trading/tool-contract.ts`, `tool-schemas.ts`.
- Confirm copied tests are unmodified except the namespace rename (+ removed deleted-subject blocks /
  whole-file quarantines — never weakened assertions).
- **Forbidden-import sweep across ALL live (non-quarantined) code:** no `@herobids/*`, no `@herobids/llm`/
  `@traderton/llm`, no `documents`/`ses`/platform-tool/`capability-policy`/`agentConfigOps`/`runtime-composition`
  imports. Verbatim source-citing COMMENTS are allowed; imports are not.

### B. Completeness — did we copy everything copyable?
- Walk `docs/006` + the herobids trading source; confirm each subsystem/tool is either copied or has a
  recorded reason it is deferred. **Challenge every deferral:** is it deferred because it genuinely needs
  authoring / a platform dependency, or was it just not reached? Anything copyable-but-not-copied is a
  completeness gap to fix before 9b (or to record with a reason).
- Specifically re-examine the 9a deferrals: the 7 drive-path tools (`AGENT_MESSAGE_TYPES`), the 10 quarantined
  API routes, and the `_deferred-config/` worker files — confirm each is blocked on authoring, not on a
  missed copy or an un-requested source-fix. (If a further behaviour-preserving herobids source-fix would make
  more of it copyable, that is a finding — propose it; the human has said 2+ consecutive source-fixes are fine.)
- **Phase 10 (infra) is out of scope for the "did we copy everything?" test — do NOT flag it as a completeness
  gap.** Infra does not follow copy-and-delete: it is a shared, versioned Terraform module library extracted
  herobids-side and consumed by Traderton at a pinned version (`enable_nomad = false`). See
  [../004-decision-log.md](../../docs/004-decision-log.md) ("Why Phase 10 (infra) is a shared versioned module…") and
  [012-shared-infra-module-decision.md](./012-shared-infra-module-decision.md). It is authored/consumed, not
  copied, by design — the review covers the trading library (Phases 1–9a), not infra.

### C. Accounting — the ledger is honest
- Cross-check `docs/001` against `docs/006`: every inventory row has a disposition; every `Met` is backed by
  copied code + green copied tests (not partial evidence); every `Deferred (required for cutover)` is
  cross-referenced to its owning phase and the cutover gate; every Intentional Divergence names the platform
  seam. Flag any status not supported by the actual code/tests.
- Confirm the credential-gated integration tests (db, venues) are noted as a CI/Phase-10 obligation, not
  silently counted as Met runtime validation.

### D. Coherence at the M1 boundary (the ports the consumer injects)
- Enumerate the **ports/seams** the M1 consumer (herobids) must satisfy in-process: injected `venueAccountId`
  (startup-context divergence), the trading `ToolContext` (`TradingToolContext`) fields + the `executionConfig`
  port, the actor/intake drive point left open in the worker, the `ownerId`/`actor` boundary, the connection-
  grant guards that stay consumer-side. For each, confirm: it carries **values, not trading behaviour**
  (000/004 invariant); Traderton owns the trading logic behind it; the consumer supplies only what it owns.
- Confirm the package dependency graph is acyclic and matches the intended layering (domain ← engine/db/
  market-data ← venues/strategy/backtesting ← worker); no package reaches around a port into another's internals.
- Sanity-check that the library is actually consumable in-process (exports/barrels resolve; the worker loop
  modules + tools are reachable) even though the composition root is 9b.

### E. Authoring scope for 9b (bound it precisely)
- Produce the definitive, itemized list of 9b authored work, each with: what it is, why it must be authored
  (not copyable), which `Deferred (required for cutover)` ledger row(s) it resolves, and the invariant(s) it
  must honor (esp. ports-carry-values; risk gate / planner / executors stay Traderton's and are not
  overridable through a seam; per-`ownerId` limit key; M1-in-process before M2-REST).
- Note where each authored piece un-quarantines a `_deferred-config/` or `_deferred-authoring/` file.

## 4. Deliverable

Write `docs/features/011-m1-holistic-review-report.md` (git-tracked) containing:
- **Verdict:** is the M1 library sound and complete-as-possible? (proceed to 9b / fix findings first).
- **Findings by severity** (CRITICAL/HIGH/MEDIUM/LOW), each concrete (file + what + why + recommended action).
  Cardinal sins: authored logic where a copy belongs; a silently dropped/degraded capability; a ledger status
  unsupported by code; a port that carries trading behaviour.
- **Inventory reconciliation table:** every 006 row → 001 disposition → evidence, with any gaps called out.
- **The bounded 9b authoring list** (from §3E).
- **Evidence:** the build/lint/test counts you actually ran.
- Update `docs/001` / `docs/003` only if the review uncovers an inaccuracy to correct (record, don't silently fix).

## 5. Guardrails for the review itself
- READ-ONLY on product code. The only writes are the report + (if needed) ledger/anomaly corrections.
- Do not start 9b. Do not author. If a completeness gap needs a herobids source-fix, propose it (draft the
  request per the established `.ignore/source-fix-request/` + `docs/003` tracking pattern) — do not implement past it.
- Verify every claim against source/tests. Prefer "I checked X and it holds / fails" over "the docs say X."
- If the review surfaces a crux/shape question (e.g. a deferral that is really a hidden authored divergence,
  or an invariant at risk), STOP and surface it to the human — do not resolve it unilaterally.
- Hand back to the human with the verdict + the bounded 9b scope; 9b proceeds only on their go-ahead.
