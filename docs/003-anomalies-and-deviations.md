# Anomalies & Deviations

**Status:** living
**Purpose:** log things discovered **during** copy-and-delete that force an
unplanned deviation from pure copy — genuinely broken source behaviour, or a
seam that cannot be preserved without authoring non-trivial logic.

## When to add an entry

Add an entry when, mid-extraction, you hit any of:

1. source behaviour that appears genuinely broken;
2. a seam that cannot be stubbed narrowly and would require authoring
   non-trivial logic to keep the build/tests green;
3. a copied test that cannot pass without a real (non-stub) change.

**Do not improvise a fix.** Stop, log it here, and surface it. A silent
authored fix is the exact failure mode this project exists to avoid.

## Not for this doc

- **Deliberate up-front design decisions** → [000-vision.md](./000-vision.md)
  decisions list + [001-parity-ledger.md](./001-parity-ledger.md) (Intentional
  divergence). Example: bots being mechanical-only is a planned decision, not an
  anomaly.

## Log

| Date | Where (file / seam) | What | Decision / status |
|------|---------------------|------|-------------------|
| 2026-09-05 | **herobids SOURCE-CHANGE REQUEST #1** — `packages/domain/src/config/strategy-parameters.ts` + `config/schema.ts` strategy registry | **Fused edge: the trading strategy registry hard-wires the LLM/hybrid schemas.** `config/schema.ts` calls `initStrategyRegistry({ mechanical: MechanicalParamsSchema, hybrid: HybridParamsSchema, llm: LlmParamsSchema, empty })` (schema.ts ~2159–2165). `strategy-parameters.ts`'s `initStrategyRegistry` signature *requires* all four keys and registers `momentum:hybrid` and `momentum:llm` entries. `StrategyIdentitySchema` (trading-KEEP) validates params through this registry. So the platform `LlmParamsSchema`/`HybridParamsSchema` cannot be deleted in-place without breaking the call site and leaving `strategy-parameters.ts` expecting them — a fused edge, not a leaf. In-place deletion would require authoring a reshaped registry (forbidden). **Requested behaviour-preserving herobids change:** make `initStrategyRegistry` accept mechanical modes without requiring `llm`/`hybrid` (e.g. optional keys, and register llm/hybrid only when provided), so herobids behaviour is unchanged (its call still passes all four) but Traderton can copy a registry that compiles mechanical-only. Also relates to `StrategySchema.decisionMode` enum still listing `'llm'`/`'hybrid'` (string enum — a behavioural-parity note, decide at source). | **BLOCKED — awaiting herobids change + release.** Per the source-fix rule (AGENTS.md), requesting the source reshape rather than authoring a Traderton-only fix. Do not edit herobids from Traderton. |
| 2026-09-05 | **herobids SOURCE-CHANGE REQUEST #2** — `packages/domain/src/blueprint.ts` agent/bot discriminated union | **Fused edge: the blueprint revision payload fuses the agent (platform) and bot (trading) payloads in one discriminated union.** `_AgentBlueprintRevisionPayloadRawSchema` (platform: uses `IntelligenceConfigSchema`, `AllowedPresetsPolicySchema`, `PresetTransitionPolicySchema`, `PlatformAssessmentOptInSchema`, `AgentRuntimePolicyOverridesSchema`) and `_BotBlueprintRevisionPayloadRawSchema` (trading) are both members of `BlueprintRevisionPayloadSchema = z.discriminatedUnion('kind', [...])`, which the entire rest of `blueprint.ts` (Create/Preview/Detail/Browse/partial-edit) depends on. Deleting the agent side is not a leaf deletion — it requires restructuring the discriminated union the whole file hangs off (authoring, forbidden). Doc 002/004 pre-flagged `blueprint.ts` as a delicate within-file seam. **Requested behaviour-preserving herobids change:** split the blueprint payload so the agent-blueprint and bot-blueprint concerns are separable (e.g. extract the bot payload + its downstream bot-only schemas into a module/exports that don't transitively require the agent/platform schemas), keeping herobids behaviour identical (validated by herobids' blueprint.test.ts). Traderton then copies the already-separated bot slice. | **BLOCKED — awaiting herobids change + release.** Requesting source reshape per the rule; not authoring in Traderton. |
| 2026-09-05 | `packages/domain/src/config/schema.ts` (+ `config/index.ts`, `agent-protocol.ts`) | **The config schema is a fused monolith.** `config/schema.ts` is 2598 lines / 212 exported symbols — roughly 90 clearly-platform (billing, auth, plans, LLM runtime, alerts, telegram, gmail, browser-pool, services, platform-assessment) and ~54 trading-core (Risk*, Bot*, TokenSafety*, Strategy*, Execution*, Technical*, indicator params, venue/permission consts), interleaved line-by-line. Some single symbols fuse both concerns (e.g. `AGENT_STYLE_RUNTIME_DEFAULTS` mixes LLM token budgets with trading tick/risk defaults; `WakePreferencesSchema` pulls `AgentWakeSourceSchema` from the platform `agent-protocol.ts`, which in turn imports the deleted platform `tool-schemas.ts`). Reducing this file to trading-only is done by **leaf-first in-place deletion of platform blocks** (line-level deletions, diff-visible against source), keeping the file 1:1 with the source in identity/structure. Most platform schemas delete cleanly this way. The two edges that a deletion CANNOT cut without authoring are pulled out as their own entries above (source-change requests #1 and #2). | **IN PROGRESS.** Resolved so far via clean in-place deletion: the `WakePreferences`/`AgentWakeSourceSchema` seam (deleted the platform wake schema + `agent-protocol.ts` + `config/load-providers.ts` + `config/assessment-config.ts`; barrels trimmed; build+tests green at 512). Remaining platform-schema deletions (LLM, billing, plans, auth, alerts, agent-runtime-policy, infra aggregators) are clean leaf-first deletions to be executed once the two fused edges (#1, #2) are unblocked by the herobids releases, since the agent-runtime-policy schemas are referenced by the blueprint agent-payload (#2) and the LLM schemas by the strategy registry (#1). |
