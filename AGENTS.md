# AGENTS.md

Rules for AI agents working on **Traderton** — trading infrastructure for
AI/LLM agents (crypto now; forex, commodities, equities, and more later),
exposed over API now and MCP/skills later.

## Read first — MANDATORY at session start

These files ARE the project's memory. A fresh session knows nothing of the
reasoning that produced this plan unless it reads them. **Before doing anything
— any investigation, any edit, any command — read all nine, in order:**

1. **[docs/000-vision.md](./docs/000-vision.md)** — goal, method, and the
   settled decisions. Source of truth.
2. **[docs/001-parity-ledger.md](./docs/001-parity-ledger.md)** — the live
   parity status and sign-off gate. This is the working acceptance tracker;
   update it as you work against the static inventory in 006.
3. **[docs/002-phase-0-subtraction-plan.md](./docs/002-phase-0-subtraction-plan.md)**
   — what to copy / keep / cut-seam / defer, and the delete order.
4. **[docs/003-anomalies-and-deviations.md](./docs/003-anomalies-and-deviations.md)**
   — where to log forced deviations. Add to it when you hit one.
5. **[docs/004-decision-log.md](./docs/004-decision-log.md)** — the *why* behind
   the decisions. Read this when a rule seems arbitrary or a case isn't covered;
   the reasoning tells you which way to lean.
6. **[docs/005-consumer-boundary-contract.md](./docs/005-consumer-boundary-contract.md)**
   — the boundary contract consumers must use to invoke Traderton safely.
7. **[docs/006-source-capability-manifest.md](./docs/006-source-capability-manifest.md)**
   — the exhaustive source capability inventory. This is the static parity
   target; the ledger records live status against it.
8. **[docs/007-operational-readiness.md](./docs/007-operational-readiness.md)**
   — the cutover proof: latency, equivalence, restart resilience, and rollback
   discipline.
9. **[docs/008-phase-1-scaffold-and-domain-slice.md](./docs/008-phase-1-scaffold-and-domain-slice.md)**
   — the queued Phase 1 task doc. It becomes executable only after Phase 0
   sign-off.

Do not rely on prior chat context — assume you have none. If a decision isn't in
these docs, it does not exist yet: decide it deliberately and record it here.

## The rule you must not break

We are extracting Traderton from the existing [herobids](../herobids/) system by
**copy-and-delete**, not rewriting from scratch.

> **Copy, never author.** Every line of trading behaviour must arrive by being
> copied from the source system. The only things you author are **deletions**
> and the **thin seams** where platform couplings are cut.

- Do not reimplement trading logic from your own model of how it "should" work.
- Do not write new tests that assert your assumptions. Bring the source tests
  across; they are the parity harness.
- After every deletion: the build compiles and the copied tests pass. If not,
  you found a real dependency or cut a seam wrong — fix it there before moving on.
- The bar is **feature parity** with the source, not "does it run." We may
  improve; we must not degrade. Anything you can't preserve goes in the ledger
  as **Gap** or **Deferred** — never silently dropped.

### Source-fix requests

When the cleanest seam requires reshaping the source, you may *request* a
behaviour-preserving change in herobids — you must never edit herobids yourself.
The change is made, tested, gated, and released in herobids by the owner; then
you copy from the improved source. Requests must be behaviour-preserving
(validated by herobids' existing tests) — they may not alter trading behaviour.
Log each request and the resulting herobids version in
[docs/003-anomalies-and-deviations.md](./docs/003-anomalies-and-deviations.md).
Prefer a clean in-Traderton deletion when one exists; reserve source requests
for seams a deletion cannot cut without authoring non-trivial logic.

## Source system — READ-ONLY

`../herobids` relative to this repo — the `herobids` monorepo, where
trading currently lives fused with an agent + messaging platform.

**Work only in this repo (`.` / `../traderton` when viewed from the sibling
checkout). Treat
herobids as read-only source — read and copy from it, never modify it.** All
builds, tests, and git operations run in this repo.
