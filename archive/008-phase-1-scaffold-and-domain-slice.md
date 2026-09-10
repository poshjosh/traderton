# Phase 1 — Scaffold And Domain Slice

> **ARCHIVED / HISTORICAL — do NOT re-execute.** For what is true now, see
> [docs/CANONICAL-STATE.md](../docs/CANONICAL-STATE.md). See also [archive/README.md](./README.md).

**Status:** DONE (2026-09-06) — historical record.
**Created:** 2026-09-05

> **This phase is complete.** The `@traderton/domain` slice is extracted, compiles
> under strict TS, lint clean, 230 copied tests green. Do **not** re-execute this doc.
> Current/remaining work is governed by
> [009-extraction-roadmap.md](./009-extraction-roadmap.md); the live status is in
> [001-parity-ledger.md](../docs/001-parity-ledger.md). The "Execution Gate" and task list
> below are the original Phase 1 instructions, kept for the historical record.

**Depends on:** [000-vision.md](../docs/000-vision.md),
[001-parity-ledger.md](../docs/001-parity-ledger.md),
[002-phase-0-subtraction-plan.md](./002-phase-0-subtraction-plan.md),
[003-anomalies-and-deviations.md](../docs/003-anomalies-and-deviations.md),
[004-decision-log.md](../docs/004-decision-log.md),
[005-consumer-boundary-contract.md](../docs/005-consumer-boundary-contract.md),
[006-source-capability-manifest.md](../docs/006-source-capability-manifest.md), and
[007-operational-readiness.md](../docs/007-operational-readiness.md)

## Purpose

Turn the approved planning set into the first executable implementation slice in
Traderton: scaffold the repo, copy the trading-owned domain slice, rename the
package namespace, and get that slice compiling and testable without widening
into engine, venues, or runtime wiring yet.

## Execution Gate

This doc is implementation-ready but gated. It does **not** authorize code
movement until [002-phase-0-subtraction-plan.md](./002-phase-0-subtraction-plan.md)
is accepted, its gates are marked `Met`, and its sign-off record is filled in
by the repo owner or the delegated approver named in Phase 0's `Approver
Designation` section. Phase 0 sign-off then explicitly hands execution to this
phase.
Until then, treat this as the next queued task doc, not active work authority.

## Scope

This phase includes:

1. the root workspace and toolchain shell needed to host copied packages
2. the `packages/domain` trading slice plus only the supporting leaf modules
   named in Phase 0
3. copied tests for the domain slice as the parity harness for this phase
4. namespace renames from `@herobids/*` to `@traderton/*` for touched files
5. live parity-status updates in
   [001-parity-ledger.md](../docs/001-parity-ledger.md) for the copied slice

This phase does not include:

1. `packages/engine`, `packages/venues`, `packages/market-data`,
   `packages/backtesting`, or mechanical strategy extraction beyond what the
   copied domain slice strictly requires to compile
2. API or worker runtimes, consumer boundary handlers, or deployment wiring
3. infrastructure, compose, or production cutover work
4. authored replacements for source trading logic when a deletion or thin seam
   would suffice

## Start Here

Read [000-vision.md](../docs/000-vision.md) through
[007-operational-readiness.md](../docs/007-operational-readiness.md), then execute
the tasks below in order. Do not jump to engine, venues, or DB extraction until
this phase is green.

## Execution Rules

1. Work only in Traderton; herobids is read-only source.
2. Copy first; author only deletions, namespace renames, and thin seams needed
   to keep the copied slice compiling.
3. Bring copied tests across before trusting the slice.
4. If a domain file pulls in `llm`, agent runtime, documents, billing, or
   another platform-owned dependency, either cut the narrowest seam or log an
   entry in [003-anomalies-and-deviations.md](../docs/003-anomalies-and-deviations.md).
5. After each task, run the narrowest validation before widening scope.
6. Update [001-parity-ledger.md](../docs/001-parity-ledger.md) as the live acceptance
   tracker. Do not mutate
   [006-source-capability-manifest.md](../docs/006-source-capability-manifest.md)
   unless the source inventory itself was wrong.

## Task List

### T1. Scaffold the workspace shell

**Status:** `not-started`

Touchpoints:

1. root package-manager and TypeScript or Vitest config files
2. minimal `packages/domain/` package shell
3. root scripts needed for narrow package validation

Work:

1. copy the root toolchain and config files needed to host copied packages
   without version drift
2. create the minimal package manifest and config surface for `@traderton/domain`
3. keep Node, pnpm, ESM, and strict TypeScript settings aligned with
   [000-vision.md](../docs/000-vision.md)

Validation:

1. run the narrowest install or bootstrap command needed for workspace metadata
2. run a narrow typecheck or `pnpm lint` once the package shell exists
3. fix shell or config failures before copying source files

### T2. Copy the domain package boundary

**Status:** `not-started`

Touchpoints:

1. `packages/domain/package.json`
2. `packages/domain/src/index.ts`
3. domain-local package config or test config files

Work:

1. copy the package manifest, exports, and entrypoints from herobids
2. rename package namespace references to `@traderton/*`
3. remove or stub only the imports that cross into platform-owned packages

Validation:

1. run a targeted typecheck for `packages/domain`
2. inspect unresolved imports locally; if a seam is non-trivial, log it in 003
3. rerun the same typecheck after each seam change

### T3. Copy the trading-owned domain slice

**Status:** `not-started`

Touchpoints:

1. the trading-owned `packages/domain` files named in
   [002-phase-0-subtraction-plan.md](./002-phase-0-subtraction-plan.md)
2. any thin seam needed around the `blueprint.ts` risk, execution, and
   token-safety schema slice

Work:

1. copy exactly the trading-owned leaf modules identified in Phase 0
2. copy only the `blueprint.ts` risk, execution, and token-safety schema slice,
   not the full platform policy file
3. exclude LLM-owned and platform-owned slices
4. preserve copied names and types unless
   [000-vision.md](../docs/000-vision.md) explicitly authorizes the rename

Validation:

1. run a targeted domain typecheck
2. run a narrow forbidden-import check over `packages/domain` for platform-only
   dependencies
3. fix local seams before widening scope

### T4. Bring the copied domain tests across

**Status:** `not-started`

Touchpoints:

1. source domain test files that cover the copied slice
2. local Vitest wiring for `packages/domain`

Work:

1. copy the source tests that cover the domain slice without re-authoring their
   assertions
2. rename imports to `@traderton/*`
3. delete or skip only tests blocked by a known Deferred capability, and record
   that explicitly in 001 or 003

Validation:

1. run only the copied `packages/domain` tests
2. if a test fails, fix the seam or log an anomaly; do not rewrite the trading
   behavior to match a new assumption
3. if a test is skipped because of an accepted Deferred or Gap item, the
   affected capability row must stay `Deferred` or `Gap` in 001; do not mark
   that slice `Met` on partial evidence

### T5. Normalize exports and close local seams

**Status:** `not-started`

Touchpoints:

1. `packages/domain/src/index.ts`
2. any local helper or schema export files touched in T2-T4

Work:

1. expose only Traderton-owned domain modules from the public package boundary
2. remove dead or platform-only exports introduced by the copy
3. keep the slice compilable from a clean package import graph

Validation:

1. rerun the targeted `packages/domain` typecheck
2. rerun the copied `packages/domain` tests
3. repair export-surface regressions before updating status docs

### T6. Update parity evidence and hand off

**Status:** `not-started`

Touchpoints:

1. [001-parity-ledger.md](../docs/001-parity-ledger.md)
2. [003-anomalies-and-deviations.md](../docs/003-anomalies-and-deviations.md) when
   needed

Work:

1. update the domain-slice statuses in
   [001-parity-ledger.md](../docs/001-parity-ledger.md)
2. record any remaining blockers or forced deviations in 003
3. note what the next phase may assume is green

Validation:

1. run `pnpm lint`
2. rerun the copied `packages/domain` tests
3. confirm the ledger reflects the actual validation state before handing off

## Stop And Escalate

Stop and escalate instead of widening scope when:

1. the copied domain slice needs non-trivial authored trading logic to compile
2. a copied test cannot pass without inventing new behavior rather than cutting
   a narrow seam
3. the slice forces `@herobids/llm` or another platform-owned dependency into
   Traderton with no clear deletion or seam path
4. the source inventory in
   [006-source-capability-manifest.md](../docs/006-source-capability-manifest.md)
   appears wrong or incomplete

## Completion Check

This phase is complete only when:

1. the workspace shell exists and supports narrow package validation
2. `@traderton/domain` compiles under strict TypeScript
3. all in-scope copied `packages/domain` parity tests pass; any skipped or
   deleted tests are explicitly tied to an accepted `Deferred` or `Gap` entry
   in [001-parity-ledger.md](../docs/001-parity-ledger.md)
4. no platform-only imports remain in the copied domain slice unless explicitly
   logged as a deviation
5. the relevant statuses in
   [001-parity-ledger.md](../docs/001-parity-ledger.md) are updated to match reality
6. the next extraction phase can start from a green domain base rather than
   from planning docs alone