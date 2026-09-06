# Phase 3 Plan (FINAL) — `@traderton/engine`

**Phase:** 3 of the roadmap ([009](../009-extraction-roadmap.md)).
**Shape:** clean-package (+ one internal seam).
**Depends on:** `@traderton/domain` (done). NOT db/venues/market-data (engine is domain-only).
**Status:** FINAL — investigated (step 1) against real herobids `packages/engine` on 2026-09-06
and finalized below. Supersedes the seed.

## Investigation findings (step 1 — read-only against herobids)

- `packages/engine/package.json` has exactly one production dependency: `@herobids/domain`.
  No db/venues/market-data/llm/platform imports. Confirmed by an import sweep of `src/**`:
  the only non-relative imports are `@herobids/domain`, `node:crypto`, `vitest`, and (in two
  **test** files only) `@herobids/tests/fixtures/venue-capabilities.js`.
- **35 source files** in `src/` (incl. `src/reconciliation/` with 4 source files + tests).
  Test files sit beside their subjects (`*.test.ts`, plus `risk-gate.parity.test.ts`).
- **All domain symbols the engine imports survive in Traderton's domain slice EXCEPT one:**
  `WakeGateConfig`. Verified every imported symbol against `@traderton/domain` — the only
  missing export is `WakeGateConfig` (dropped in Phase 1 as platform preset-review config,
  see [003](../003-anomalies-and-deviations.md) config-monolith deletion list). The
  types the wake-gate also uses (`MarketAssessmentArtifact`, `MarketAssessmentPresetRanking`)
  DID survive.

### The one seam — `wake-gate.ts` (platform preset-review wake → Intentional Divergence)

`src/wake-gate.ts` (`evaluateWakeGate`) is the **platform agent preset-review wake**, not the
trading fill/mark-driven wake. Evidence it is platform, not trading:

1. It imports `WakeGateConfig` from `@herobids/domain` — a type Phase 1 already classified as
   platform and **deleted** from the domain slice.
2. Its entire vocabulary is agent-preset reasoning: `agentId`, `agentStyleTier`,
   `agentCurrentPreset`, preset rankings, "should this agent switch preset", per-agent
   `maxWakesPerAgentPerDay`. It decides preset-review wakes for a reasoning agent — the exact
   concern relocated agent-side by decisions 7–9.
3. **Consumer check across ALL of herobids (read-only, per the 004 corollary):**
   `evaluateWakeGate` / `WakeGateInput` / `WakeGateResult` appear ONLY as re-exports in
   `packages/engine/src/index.ts`. No file in `apps/` or elsewhere imports them. It is orphaned
   at the barrel; no trading consumer needs it.

**Classification:** the wake-gate is platform coupling, not a trading capability. It is cut by
**deletion** (`wake-gate.ts` + `wake-gate.test.ts` + the two barrel exports). This is a clean
Intentional Divergence, consistent with Phase 1 dropping `WakeGateConfig` — **not** a stop-gate
(it authors nothing; it needs a dropped platform type; only the platform barrel referenced it).

> Note the distinction for the ledger: the "Wake gate" row under Engine subsystems refers to
> **this** platform preset-review wake. The **trading** mark-source / fill-first mark selector
> (`mark-source.ts`, `MarkSelector`, `createFillFirstMarkSource`) is separate, trading-owned,
> and IS copied. Do not conflate the two.

### The test-harness seam — `@herobids/tests` fixture (bring the fixture across)

Two engine **test** files (`live-executor.test.ts`, `reconciliation/venue-state-loaders.test.ts`)
import `FULL_CAPABILITIES` from `@herobids/tests/fixtures/venue-capabilities.js`. In herobids
`@herobids/tests` is a root vitest alias → the repo-root `./tests` dir (not a published package).
`tests/fixtures/venue-capabilities.ts` depends only on the domain type `VenueCapabilities`
(present in Traderton).

These are part of the **parity harness** (copied tests). To keep them running verbatim we mirror
herobids' structure: copy `tests/fixtures/venue-capabilities.ts` to Traderton's repo-root
`tests/fixtures/`, and add a `@traderton/tests` vitest alias → `./tests`. The import in the two
copied tests changes `@herobids/tests` → `@traderton/tests` (the decision-17 namespace rename,
not authoring). The fixture itself is copied verbatim (only the `@herobids/domain` type import is
renamed to `@traderton/domain`).

## Highest-stakes surface — RISK GATE
`packages/engine/src/risk-gate.ts` `checkRisk()` is the highest-stakes parity surface
([001](../001-parity-ledger.md) risk-gate table). Its exact rules + error codes must reproduce
verbatim; risk-reducing plans (`close`/`reduce`) bypass entry-side checks. **The copied risk-gate
parity tests (`risk-gate.parity.test.ts` + `risk-gate.test.ts`) are the acceptance gate — they
must pass unmodified.** Any divergence here is consequential (stop-gate). Do not touch risk logic
beyond the `@herobids/*` → `@traderton/*` namespace rename.

## Method (copy-and-delete)
1. Scaffold `@traderton/engine` (package.json mirroring herobids engine — dep `@traderton/domain`;
   tsconfig referencing `../domain`). Wire into root `tsconfig.json` refs, `vitest.config.ts`
   aliases (`@traderton/engine`, `@traderton/tests`), and pnpm workspace (already `packages/*`).
2. Copy `packages/engine/src/**` verbatim into `packages/engine/src/`. Copy the venue-capabilities
   fixture to root `tests/fixtures/`. Namespace-rename `@herobids/*` → `@traderton/*` throughout
   (imports only — no logic touched). Get it compiling as a copy (build + tests green as the
   verbatim baseline BEFORE any deletion).
3. Delete the wake-gate seam: `src/wake-gate.ts`, `src/wake-gate.test.ts`, and the two
   `wake-gate` exports in `src/index.ts`. Build + copied tests green after the deletion.

Build + copied tests green after every step. Small diffable commits.

## Stop-gates (per 009) — none expected, but the guards
- **Risk-gate behavioural divergence** → consequential, STOP and escalate. (Guard: parity tests
  must pass byte-for-byte unmodified; if they can't, do not adjust them — escalate.)
- An engine file needing a domain type Phase 1 deleted, where deletion/seam can't cut it without
  authoring → source-fix request. (Only `WakeGateConfig` is missing, and its file is deletable —
  so this is not expected to fire. If a NON-wake-gate file turns out to need `WakeGateConfig` or
  any other dropped type, STOP.)
- Any capability herobids will rely on Traderton for that can't be cleanly copied →
  Deferred-REQUIRED ledger entry. (Not expected: the wake-gate is orphaned platform, not a
  herobids-on-Traderton dependency.)

## Deliverables / acceptance
- `@traderton/engine` compiles strict against `@traderton/domain`; lint clean (`tsc --noEmit`).
- All copied engine tests green — **risk-gate parity tests especially** — unmodified except the
  `@herobids/*` → `@traderton/*` rename.
- Forbidden-import sweep: no `@herobids/*`, no llm, no platform, no db/venues/market-data imports.
- Ledger ([001](../001-parity-ledger.md)) updated: risk-gate exact-rules table → Met with the
  parity-test evidence; engine-subsystems rows → Met (except the platform "Wake gate" row →
  Intentional divergence); a new Intentional Divergence row for the platform preset-review wake.
- Phase 3 marked Done in [009](../009-extraction-roadmap.md) with commit range + green evidence.
- Seed the Phase 4 (`market-data`) plan.

## Review checklist additions (from Phase 1/2 lessons — 009)
- Sweep ROOT config (vitest aliases, tsconfig refs, package.json, pnpm-workspace) for
  stale/added references.
- Check for stray/0-byte/untracked files in the package.
- Verify kept tests are unmodified except for the namespace rename (and no deleted-subject blocks
  besides wake-gate).
- Confirm the plan stated guards, not optimistic "expected clean".

## Expected Intentional Divergences (log in ledger)
- **Platform preset-review wake gate** (`wake-gate.ts`): not copied. Agent preset-review reasoning,
  needs the dropped `WakeGateConfig`, orphaned at the barrel — relocated agent-side (decisions 7–9).

## Outstanding Issues (from code review — no CRITICAL/HIGH/MEDIUM)

Grouped by item. The review verified copies-not-authored (all 58 src files byte-identical
to source modulo the `@herobids/*` → `@traderton/*` rename; `risk-gate.ts` byte-identical),
tests unmodified, seam cut correctly, forbidden-import sweep clean, root-config sweep clean.

- **[Copy verbatim]** LOW-1: `packages/engine/src/instrument-executor.ts` lines 19/24/30 retain
  verbatim `@herobids/db` references in JSDoc comments ("Structurally compatible with @herobids/db
  FillRepository/OrderRepository/PositionRepository"). Adjudication: leaving them verbatim is
  CORRECT under copy-never-author (non-executable prose, no import coupling, faithful to source);
  changing them would be an authored edit. Optional future doc cleanup only — not a blocker.
