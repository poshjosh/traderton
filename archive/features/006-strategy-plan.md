# Phase 6 Plan (FINAL) — `@traderton/strategy` (mechanical slice)

**Phase:** 6 of the roadmap ([009](../009-extraction-roadmap.md)).
**Shape:** clean-package (split) — copy the mechanical slice, drop the llm/hybrid slice.
**Depends on:** `@traderton/domain` + `@traderton/market-data` (both done). NOT engine/db/venues.
**Status:** FINAL — investigated (step 1) against real herobids `packages/strategy` on 2026-09-06.

## The split (decisions 7–9: bots are mechanical-only; llm stays agent-side)
herobids `packages/strategy/src` has 13 files. The split is clean and file-level:

**COPY (mechanical slice — llm-free):**
- `mechanical-strategy.ts` (+ `.test.ts`) — imports only `@herobids/domain` (+ `MechanicalParamsSchema`).
- `dca-strategy.ts` (+ `.test.ts`) — imports only `@herobids/domain` + `zod`.
- `scan-engine.ts` (+ `.test.ts`) — imports `@herobids/market-data` (`PriceCandle`) + `@herobids/domain`
  (`HybridPricingIdentity`, `ScannerCandleTarget`, `SwapExecutionIdentity`).
- `index.ts` — copied, barrel-trimmed (see below).

**DROP (llm/hybrid slice — agent-side, Intentional Divergence, same seam as the mechanical-only
registry from Phase 1):**
- `llm.ts` (+ `.test.ts`), `llm-provider.ts` (+ `.test.ts`), `hybrid-strategy.ts` (+ `.test.ts`).
- The `@herobids/llm` dependency is dropped entirely (decision 9: no LLM package, no cost center).

## Step-1 confirmations
- **The mechanical files do NOT import `./llm` or `./hybrid`** — the slice is llm-free; dropping the
  llm/hybrid files leaves the mechanical slice compiling (guard: re-verify at implement time).
- **Per-symbol domain diff:** the mechanical slice imports `HybridPricingIdentity`, `ScannerCandleTarget`,
  `SwapExecutionIdentity`, `MechanicalParamsSchema` from domain — **all present** in the Traderton
  domain barrel; `PriceCandle` is exported from `@traderton/market-data`. No missing type.
  - **NOTE (naming trap):** `HybridPricingIdentity` is a domain **pricing-identity** type (swap pricing),
    NOT the `HybridStrategy`. It is trading, survived Phase 1, and IS needed by `scan-engine.ts`. Do NOT
    delete it or mistake it for the dropped hybrid strategy.
- **Barrel trim:** `index.ts` currently exports (in order): `LlmStrategy` + `clearLlmResponseCache` +
  `LlmStrategyConfig`/`LlmDecisionArtifact`/`ArtifactCallback` (from `./llm` — DROP, 3 lines);
  scan-engine exports (KEEP); the `ScannerCandleTarget`/`SwapExecutionIdentity` domain re-export (KEEP);
  `MechanicalStrategy` (KEEP); `HybridStrategy` (from `./hybrid-strategy` — DROP, 1 line);
  `DcaStrategy`/`DcaParamsSchema`/`DcaParams` (KEEP). So remove exactly the 3 `./llm` lines + the 1
  `./hybrid-strategy` line.

## Method (copy-and-delete / split)
1. Scaffold `@traderton/strategy` (deps `@traderton/domain` + `@traderton/market-data` workspace:* +
   `zod: ^3.25.0`; **NO `@herobids/llm`/`@traderton/llm`**; devDep `@types/node`; tsconfig references
   `../domain` + `../market-data`). Wire root tsconfig ref + vitest alias `@traderton/strategy`. `pnpm install`.
2. Copy ONLY the mechanical-slice files (mechanical-strategy, dca-strategy, scan-engine + their tests,
   and index.ts) verbatim; namespace-rename `@herobids/*`→`@traderton/*`. Do NOT copy llm.ts/llm-provider.ts/
   hybrid-strategy.ts or their tests.
3. Trim `index.ts`: remove the 3 `./llm` export lines + the 1 `./hybrid-strategy` export line. Nothing else.
4. Build + copied mechanical tests green.

(This is a copy-of-a-subset, not copy-whole-then-delete, because the dropped files are a clean file-level
slice with no mechanical→llm imports — copying then deleting would be equivalent but noisier. Either is
valid; the discipline is that only the mechanical files are copied verbatim and the llm/hybrid files never
enter Traderton.)

## Stop-gates (per 009)
- If a mechanical file turns out to import a `./llm`/`./hybrid` symbol (contradicting step 1) → STOP:
  the split isn't clean; classify before proceeding.
- If the mechanical slice needs a domain symbol not in the Traderton barrel → source-fix request.
- Any behavioural divergence in mechanical/dca/scan logic → consequential, STOP.

## Deliverables / acceptance
- `@traderton/strategy` (mechanical) compiles strict against domain + market-data; lint clean; NO llm dep.
- All copied mechanical tests green (`mechanical-strategy`, `dca-strategy`, `scan-engine`).
- Forbidden-import sweep: no `@herobids/*`, no `@traderton/llm`/`@herobids/llm`, no platform/db/engine/venues.
- Ledger updated: "Mechanical strategies" row → Met (now `Dca`+`Mechanical`+`scan-engine` landed, joining
  the Phase-4 `regime`+indicators); add/confirm the llm/hybrid-strategy Intentional Divergence (already
  covered by the "Bots could run LlmStrategy/HybridStrategy" divergence row — extend its evidence).
- Mark Phase 6 Done in 009; seed Phase 7 (`backtesting`) plan.

## Review checklist (from 009 lessons)
- Confirm the dropped llm/hybrid files never entered the tree (no llm.ts/hybrid-strategy.ts under src).
- Per-symbol domain-import diff clean; `HybridPricingIdentity` kept (not confused with HybridStrategy).
- Sweep ROOT config (vitest aliases, tsconfig refs, package.json — no llm dep, pnpm-workspace).
- Kept files byte-identical modulo namespace rename; index.ts diff = exactly the 4 removed export lines.
- Verbatim comments stay verbatim.
