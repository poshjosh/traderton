# `_deferred-config/` — quarantined worker files (Deferred)

These files are **verbatim copies** from the herobids source worker (`@herobids/*`
→ `@traderton/*` namespace rename only — no content edits). They are **not
authored**; they are the copied parity harness for capabilities that cannot yet
compile in Traderton.

## Config shape — RESOLVED (Phase 9b item A, 2026-09-07)

The Traderton-owned config shape has now landed (copy-and-delete / fused-file trim of
the herobids `AppConfigSchema` + `AgentRiskDefaultsSchema` into `@traderton/domain` —
re-opening the Phase-1 over-deletion). The following files were **un-quarantined**
(moved back to `packages/worker/src/`) and are green:

- `config.ts` / `config.test.ts` — un-quarantined; the platform `ENV_OVERRIDES`
  (alerts/telegram/email/llm/billing/auth/evaluation/gmail/sharedServices/
  platformAssessor/nomad) + billing prod/staging guards were deleted (fused-file
  line-trim); the copied test was trimmed to trading-only (platform describe/it blocks
  removed whole; `BASE_YAML` platform block dropped) — line-traceable to source, logged
  in [013 §A](../../../../archive/features/013-9b-authoring-plan.md).
- `agent-risk-limits.ts` / `.test.ts` / `.parity.test.ts` — un-quarantined (needed only
  `AgentRiskDefaultsConfig`, now present); moved verbatim.
- `public-stream-routing.ts` / `.test.ts` — un-quarantined (needed only
  `AppConfig['venues']`); moved verbatim.

See [docs/001-parity-ledger.md](../../../../docs/001-parity-ledger.md) (config-shape row)
+ [docs/features/013-9b-authoring-plan.md](../../../../archive/features/013-9b-authoring-plan.md) item A.

## Quarantined test files (source stays in the build)

These are **test files only** — their source-under-test remains in
`packages/worker/src/` and compiles clean under the build. They are quarantined
verbatim (no in-file editing) because they import subjects that were deleted or
deferred in Traderton. The whole file is moved rather than pruned to preserve
*copy, never author*.

- `tick-gates.test.ts` — imports `computeMarketEventDigest` from
  `./runtime-composition.js` (a DELETE'd module). The market-event digest and the
  `PendingMarketEvent` / `MarketDiscoveryDetectedPayload` /
  `MarketRegimeChangedPayload` types are not yet in Traderton; deferred until those
  market-event types land. Its source `tick-gates.ts` stays in the build.
- `validate-trade-instrument.test.ts` — imports `SubmitDecisionParamsSchema` from
  `./tools/trading.js`; the `tools/` trading modules are **Phase 9**. Its source
  `validate-trade-instrument.ts` stays in the build.

## Quarantine mechanism

- Excluded from the package build: `packages/worker/tsconfig.json` `exclude`
  (`src/_deferred-config/**`).
- Excluded from the test run: root `vitest.config.ts` `test.exclude`
  (`**/_deferred-config/**`).

The two remaining files stay on disk (retained, not deleted) so that when their
deferred subjects land (market-event types for `tick-gates.test.ts`; `tools/trading.ts`
for `validate-trade-instrument.test.ts`) they can be un-quarantined with a move.

**Do not edit these files** — they must stay verbatim copies for the eventual
un-quarantine.
