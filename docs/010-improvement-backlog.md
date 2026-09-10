# Improvement Backlog

**Status:** living
**Created:** 2026-09-08

## Purpose

A list of **deliberate, non-blocking future improvements** — the "later" branch of a fork we took the safe
or simple path on now. Each entry records what it is, why we deferred it, what it would take, and a grade,
so a future agent (or human) can triage without reconstructing the original conversation.

This exists because that class of decision had no home: it is neither a forced deviation nor a parity gap
nor a bug.

## What belongs here (and what does NOT)

**Belongs here** — an optional improvement where skipping it *forever* is acceptable, just not ideal. Usually
created when we chose "safe/simple now" over "better later" and want to remember the better path.

**Does NOT belong here:**
- **Cutover obligations** (must-do before cutover) → [001-parity-ledger.md](./001-parity-ledger.md) +
  [003-anomalies-and-deviations.md](./003-anomalies-and-deviations.md) as `Deferred (required for cutover)`.
  Rule of thumb: if skipping it forever would **degrade parity or block cutover**, it is NOT a backlog item.
- **Bugs / real defects** → fixed, or filed as a bug report. A defect is not an "improvement."
- **In-progress deferrals within an active phase** (e.g. an F1 item deferred to F2) → the phase plan / 003.
  Backlog items outlive any single phase.

## Grading

Each item carries two independent axes plus a risk flag:

- **Value** (High / Med / Low) — what we gain by doing it.
- **Effort** (High / Med / Low) — what it costs to do.
- **Risk-if-deferred** (High / Med / Low) — the danger of never doing it. For a true backlog item this is
  normally **Low** (if it were High it would be a 003 cutover obligation, not a backlog item). A Med/High
  here is a signal to re-home the item.

Triage heuristic: **High value / Low effort** floats to the top; **Low value / High effort** rarely gets done
(and that verdict is itself worth recording so nobody re-opens it).

## Backlog

| # | Item | What it is / why deferred | What it would take | Value | Effort | Risk-if-deferred |
|---|------|---------------------------|--------------------|-------|--------|------------------|
| B1 | **F2 idempotency: author-fresh replacement for the copy-adapted flow** | F2 D1 chose to **copy-adapt** herobids' fingerprint hasher + advisory-lock/dedupe flow (`blueprint-idempotency.ts` + the blueprints route), re-keyed to the 005 4-tuple. Copy-adapt is the safe, parity-honouring, law-abiding path. An author-fresh implementation purpose-built for the 005 4-tuple + `in_progress`/retention semantics *might* read cleaner if the copied shape becomes awkward under those deltas. | Replace the copied hasher + control flow with a purpose-built one; re-verify against the same F2 tests (behaviour must not change). | Low | Med | Low |
| B2 | **F2 deadline: literal per-side-effect re-check** | F2 D3 chose the **pragmatic** deadline check (reject pre-validation + one re-check immediately before `tool.execute`). 005's wording is "re-check before *every* downstream side effect." The literal reading would thread `deadlineAt` down into `create-trading-runtime`/`drive-target` — i.e. into copied-tool territory — for a per-side-effect check. Deferred because it enlarges surface and edges toward authoring in the core, for a benefit that only matters if a single invocation performs multiple sequential side effects past the deadline. | Plumb `deadlineAt` (a VALUE) through the drive path as a port; re-check before each enqueue/venue call; keep it a value, never trading logic. Revisit if a real multi-side-effect-per-invocation tool appears. | Low | Med | Low |
| B3 | **F2 authz: tighten Option B into a per-tool provenance allow-map (Option A)** | F2 D4 chose **Option B** — enforce "the asserted `actor.type` is one the operator configured this consumer to assert" (an operator-config VALUE), NOT an invented per-tool product-rule map. We avoided authoring speculative rules ("a bot can't create bots") because those are product decisions not yet made and have no herobids oracle. Once real per-tool provenance rules exist as a product matter, B can be tightened to a per-tool/per-category allow-map (Option A) — a stricter, tool-granular check. | Define the per-tool (or per-category) `actor.type` allow-map from real product rules; enforce in the dispatcher authz step; add tests. Only worthwhile once the rules are actually decided. | Med | Low | Low |
| B4 | **Boundary: consolidate the duplicated identity extractor** | `identityFor` (`packages/boundary/src/app.ts`) duplicates `identityFromRaw` (`packages/boundary/src/dispatcher.ts`) — both best-effort `{requestId, correlationId}` extractors. F1 CodeReviewer LOW-1. Harmless today; a drift risk if one changes and the other doesn't. | Consolidate into one helper in `result.ts`; point both call sites at it. | Low | Low | Low |
| B5 | **Boundary: `bin.ts` empty `allowedConsumers` should fail-closed** | `packages/boundary/src/bin.ts` warns (rather than refusing to start) when `allowedConsumers` is empty. Not exploitable — every request then fails `unknown consumer`, so the boundary is closed by default — but an operator misconfiguration starts a boundary that accepts nobody, silently. F1 CodeReviewer LOW-3 / 013 §8.5. | Fail-closed at startup (exit non-zero with a clear message) when no consumer is configured, unless an explicit "no-consumers" dev flag is set. Likely folded into F2's composition/config hardening. | Med | Low | Low |

## Log conventions

- Add a row when you take a fork's safe/simple branch and the better branch is worth remembering. Grade it.
- When an item is done, strike it (or move it to a "Done" note) with the commit — do not silently delete it.
- If an item's Risk-if-deferred rises to Med/High, re-home it to 001/003 (it has become an obligation).
