# `_deferred-config/` — quarantined worker files (Deferred, required for cutover)

These files are **verbatim copies** from the herobids source worker (`@herobids/*`
→ `@traderton/*` namespace rename only — no content edits). They are **not
authored**; they are the copied parity harness for capabilities that cannot yet
compile in Traderton.

## Why quarantined

They depend on a **Traderton-owned config shape that has not been authored yet**:

- `config.ts` / `config.test.ts` — need `AppConfig` / `AppConfigSchema` from
  `@traderton/domain`.
- `agent-risk-limits.ts` / `agent-risk-limits.test.ts` /
  `agent-risk-limits.parity.test.ts` — need `AgentRiskDefaultsConfig`.
- `public-stream-routing.ts` / `public-stream-routing.test.ts` — depend on the
  same config surface.

That config shape is tracked as **`Deferred (required for cutover)`** and is owned
by **Phase 9 / M1-integration** (see `docs/003-anomalies-and-deviations.md` and
`docs/features/008-worker-plan.md`). The extraction law is *copy, never author*, so
the config shape is not stubbed here — it is authored deliberately in Phase 9, at
which point these files move back into `packages/worker/src/` and rejoin the build
and test run.

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

The files remain on disk (retained, not deleted) so that when the config shape
lands they can be un-quarantined with a move and the exclude entries removed.

**Do not edit these files** — they must stay verbatim copies for the eventual
un-quarantine.
