# Phase 8 Plan (SEED) — `apps/worker` (trading loop)

**Phase:** 8 of the roadmap ([009](../009-extraction-roadmap.md)).
**Shape:** subtraction (LARGE) — mixed trading + platform within the app; formal written keep/delete
classification REQUIRED before any code moves (same shape as the domain slice, but bigger).
**Depends on:** all extracted packages (domain, db, engine, market-data, venues, strategy, backtesting).
**Status:** SEED — to be finalized (step 2) after a full context-gatherer classification (step 1).
The interior is NOT knowable from this seed; the code must be read.

## Why this is the hardest phase
Per 009: `apps/worker` is ~173 files with ~45 `agent-*` (platform agent-session machinery). It fuses the
mechanical trading loop (KEEP) with agent-session/evaluation/messaging/wake/LLM/assessment runtime (DELETE).
Expect ownership questions, fused seams, and possibly source-fix requests. The consumer-boundary seam
(decisions 2–3, [005](../005-consumer-boundary-contract.md)) starts to matter here.

## Method (subtraction — investigate → CLASSIFY → draft → implement)
1. **Investigate + classify (mandatory formal step).** Delegate a context-gatherer to produce a written,
   reviewable keep/delete classification of every `apps/worker/src` file (and any app-local ports/services):
   - KEEP (trading-loop runtime): trading actors, stream pool wiring, scan loops, executor wiring,
     reconciliation loop, actor health, the mechanical trading cycle, and their tests.
   - DELETE (platform): agent-session machinery, agent evaluation, messaging/alerting, agent wake scheduler,
     LLM/assessment loops, `agent-*` runtime (~45 files).
   - SEAM: files that fuse both (classify the within-file cut, or the port stub).
   - For each KEEP file, list its imports (which extracted packages it needs) and confirm those symbols exist
     in the Traderton barrels (the per-symbol diff lesson). For each fused edge, check consumers across all of
     herobids before escalating (004 corollary).
2. **Finalize this plan** with the full classification + expected Intentional Divergences + suspected
   stop-gates. Review the plan before implementing (subtraction phases get a plan review).
3. **Implement** copy-and-delete leaf-first; build + copied tests green after each step; small commits.
4. Cut seams by deletion/narrow stub; a seam needing authored non-trivial logic → **stop-gate** (source-fix).

## Scaffolding notes (decide at finalize)
- This is an APP, not a library. Determine how Traderton runs the worker: an `apps/worker` workspace package
  with deps on the extracted `@traderton/*` packages. Mirror herobids worker's toolchain shape retargeted to
  Traderton (decision 16); operator config (service names, Redis/DB URLs) retargeted, not copied (decision 1).
- The worker likely wires the trading cycle to venues + db + engine + strategy + market-data via DI. Confirm
  it reaches them through the package barrels (not deep imports).

## Likely stop-gates (per 009 — state the guard, not "expected clean")
- The consumer-boundary seam (how the worker receives decisions / is driven) may be partly authored
  infrastructure, not copied trading logic — clarify what is copied vs. what the boundary contract (005)
  legitimately requires as new seam code. If it needs non-trivial authored logic → stop-gate.
- A trading-loop file that hard-depends on agent-session/LLM runtime in a way deletion can't cleanly sever →
  source-fix request or a Deferred-required ledger entry (herobids-becomes-a-consumer model).
- The bot-lifecycle limit capability (`create_bot`/`start_bot` — Deferred-required from Phase 2) may surface
  here: this is where the limit KEY (per-owner / per-venue-account / operator config) is decided. If building
  it requires authoring non-trivial trading logic beyond a copy → stop-gate; otherwise copy the mechanical
  path and record the limit-enforcement capability against its ledger row.
- Ownership ambiguity on any shared worker runtime file → surface, don't guess.

## Deliverables / acceptance (refine at finalize)
- A Traderton worker that runs the mechanical trading loop against the extracted packages; compiles strict;
  copied trading-loop tests green (incl. `agent-risk-limits.parity.test` and cross-venue-lifecycle where
  trading-owned — confirm ownership at classify time).
- Forbidden-import sweep: no `@herobids/*`, no llm, no platform agent-session imports.
- Ledger updated: trading-loop / bot-lifecycle / actor rows → Met or Deferred-required with evidence; every
  deleted platform subsystem recorded as Intentional Divergence; the 25-tool rows that the worker backs
  advanced where applicable.
- Mark Phase 8 Done in 009; seed Phase 9 (`apps/api`) plan.

## Review checklist (subtraction — heavier)
- The written classification is the checkpoint: reviewed before implementation.
- Forbidden-import sweep + diff surviving files against source (copies, not authored).
- Copied tests unmodified except namespace rename + removed deleted-subject blocks.
- Sweep ROOT config for stale refs; confirm no stray files.
- Every deleted platform capability has an Intentional Divergence (or Deferred) ledger row — nothing silently dropped.
