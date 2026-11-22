# Bug Report: `list_strategy_presets` and `change_strategy_preset` always answer "preset assessment not available in this context" for a consumer call
- **Status:** FIXED in the working tree (2026-11-21, uncommitted). Unit and boundary-level tests pass. Not deployed. Not verified against a live boundary or a live herobids agent.
- **Severity:** Medium. Two of the three strategy-preset tools in the `crypto-trading` skill could never succeed over the boundary, so an agent could neither list the presets nor switch its own preset. `assess_strategy_preset` was not affected.
- **Date:** 2026-11-21
- **Environment:** found by reading the code (traderton at `9d1905f`, herobids). Not reproduced live.
- **Companion report (herobids side):** `herobids/docs/bug-reports/2026/11/21/001-preset-tools-dropped-no-local-registry-entry.md`. Herobids was not even exposing the three tools to agents until that was fixed, which hid this problem. The herobids fix is only complete end to end once this fix is deployed.
- **Related:**
  - `docs/bug-reports/2026/09/17/001-submit-decision-schema-strips-venue-account-id.md`. Same mechanism: an undeclared payload key is stripped before the subject resolver reads it.

## Summary
The boundary builds `ctx.presetAssessment` only for an agent subject whose request resolves a non-empty venue account. For a tool that skips venue resolution (read-only categories, or `ownerScopedNoVenue`), the account comes only from the payload's `venueAccountId`. The dispatcher validates the payload with the tool's Zod schema and forwards the parsed result, so a key the schema does not declare is stripped.

- `list_strategy_presets` declares no `venueAccountId`, and no consumer can usefully give it one, so `presetAssessment` was never built and the tool returned "preset assessment not available in this context".
- `change_strategy_preset` (`ownerScopedNoVenue`) declared no `venueAccountId` either, so the account the consumer sent was stripped and the tool returned the same error.
- `assess_strategy_preset` already declares `venueAccountId`, so it worked.

## Root Cause
- `packages/boundary/src/dispatcher.ts` (`payloadParse.data` is forwarded to the context factory) and `packages/boundary/src/bin.ts` (`skipVenueResolution`, and `presetAssessment` built only when `injection.venueAccountId` is truthy).
- `packages/boundary/src/subject-resolver.ts`, skip path: reads `venueAccountId` from the (already stripped) payload, validates the owner owns it, and returns it.
- `packages/worker/src/tools/preset-assessment.ts`: `list_strategy_presets` required `ctx.presetAssessment` although the preset catalog is venue-independent and `ctx.presetCatalog` (used by `get_strategy_presets`) is always present.
- `packages/domain/src/preset-assessment.ts`: `ChangeStrategyPresetParamsSchema` omitted `venueAccountId`.

## Fix
1. **`list_strategy_presets` (T1).** Read `ctx.presetCatalog` only, with the same guard as `get_strategy_presets`. There is no fallback to `ctx.presetAssessment`: `bin.ts` is the only place that builds either context (checked across the traderton and herobids source), and it always sets `presetCatalog`. No account is needed, so the tool also works before the owner has a venue account. The missing-context message is now "preset catalog not available in this context" (the same as `get_strategy_presets`). The response shape and `behaviorVersion` are unchanged. If a runtime ever builds `presetAssessment` without `presetCatalog`, it must set the catalog too.
2. **`change_strategy_preset` (T2).** Declare an optional `venueAccountId` (`z.string().min(1).optional()`, the same declaration and description as `assess_strategy_preset`) in `ChangeStrategyPresetParamsSchema`. The tool still never reads it. The LLM-facing `get_schema` entry omits it, because it is a consumer-injected binding and never an LLM input. The tool's own `parameters` JSON schema, which MCP `tools/list` serves, still lists the field, described as "Never an LLM input". That matches `assess_strategy_preset`. Herobids reads only tool names and skill tags from `tools/list` and shows agents its own proxy schema, so agents never see the field. Traderton has no in-tree code that gives its tool schemas to an LLM. A value supplied by a consumer is checked by the boundary: it must belong to the signed owner (`authorization.denied` otherwise).

Both changes are additive. An older consumer that never sends the key behaves as before.

## Tests
- `packages/worker/src/tools/preset-assessment.test.ts`: list with the catalog only (the bug shape), all tiers, a single tier, the entry shape, the preset-assessment context ignored when both exist, clean failure when the catalog is absent even if a preset-assessment context exists, invalid tier rejected, no `venueAccountId` in the list schema. Change: schema accepts, keeps and validates `venueAccountId`, required fields stay required, JSON schema lists it as optional, the apply seam never receives it, and the "no context" refusal is unchanged.
- `packages/domain/src/preset-assessment.test.ts`: `ChangeStrategyPresetParamsSchema` keeps and validates `venueAccountId`, matches the declaration on the assess schema, and the `get_schema` entry does not expose it.
- `packages/boundary/src/preset-tools-venue-account.test.ts` (new): signed requests through the real dispatcher and the real `resolveSubjectInjection`, with the real preset tools. List succeeds with no account and with an owner who has none. A `venueAccountId` sent to list is stripped. Change keeps the account through the payload parse, builds the preset-assessment context for the owned account and applies the change, fails with the existing message when no account is sent, refuses an account the owner does not own and applies nothing, and still rejects a bad mode or an empty account. The test's context factory applies the same two rules as `bin.ts`'s factory by calling the shared helpers in `context-rules.ts` (see below), so it cannot drift from them. The rest of that factory (profile load, actor ensure, the real `presetAssessmentOps.buildContext`) is not exercised by this test.
- `packages/boundary/src/context-rules.test.ts` (new): truth tables for the two helpers, including every tool category, an unregistered tool, non-agent subjects, and the real registry (the three preset tools skip venue resolution, `submit_decision` does not).

## Shared context rules
Two rules in `bin.ts`'s context factory decide whether a tool gets a venue-bound context: whether to skip venue resolution (read-only or `ownerScopedNoVenue` tools), and whether the preset-assessment context may be built (agent subject with a non-empty resolved venue account). Both are now small exported helpers in `packages/boundary/src/context-rules.ts` (`skipsVenueResolution`, `canBuildPresetAssessment`). `bin.ts` and the boundary test both call them. The `bin.ts` change is a like-for-like swap of two expressions and one now-unused import; behaviour is unchanged. The same `agent && venueAccountId` expression also decides the profile load at `bin.ts` (`profileRepo.getByOwnerActorVenueAccount`); it was left as it is.
- Mutation check: with the original `preset-assessment.ts` files restored, 22 of the new tests fail. With the fix they pass.

## Verification (2026-11-21)
- Focused suites (worker, domain, boundary): all pass.
- `pnpm test` (whole repo): 171 files passed, 22 skipped; 3024 tests passed, 108 skipped; 0 failed.
- `pnpm build`: pass.
- `pnpm lint`: pass. Note that `pnpm lint` and `pnpm build` both exclude `*.test.ts`, so the new and edited test files were type-checked separately with a throwaway tsconfig. The new boundary test file is clean. Existing type errors in lines this change did not touch remain (worker `preset-assessment.test.ts` lines 42-44 and 183, domain `preset-assessment.test.ts` line 89). They are not caused by this fix and were left alone.
- Not run: `pnpm test:integration`, anything against a live boundary, anything against staging.

## Not verified
- Behaviour against a deployed boundary and a real herobids agent. The herobids canary check (`toolCount: 22, taggedToolCount: 22`, then one `list_strategy_presets` call) is the end-to-end proof.
- For a swap venue account, the skip path always injects `venueType: 'orderbook'` (`subject-resolver.ts`). That is existing behaviour shared with `assess_strategy_preset` and is not changed here. `change_strategy_preset` does not use `venueType`.

## Rollout
Deploy Traderton first, then herobids (see the herobids bug report and its spec). The change is additive and can stay deployed if herobids is rolled back.

## Files Changed
- `packages/worker/src/tools/preset-assessment.ts`
- `packages/domain/src/preset-assessment.ts`
- `packages/domain/src/tool-schemas.ts`
- `packages/worker/src/tools/preset-assessment.test.ts`
- `packages/domain/src/preset-assessment.test.ts`
- `packages/boundary/src/preset-tools-venue-account.test.ts` (new)
- `packages/boundary/src/context-rules.ts` (new)
- `packages/boundary/src/context-rules.test.ts` (new)
- `packages/boundary/src/bin.ts` (two expressions replaced by the helpers; one unused import removed)
- `CHANGELOG.md`
