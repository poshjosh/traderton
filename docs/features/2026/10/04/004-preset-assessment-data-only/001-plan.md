# 001 — Preset assessment, data-only, owned by Traderton

**Status:** planned. **Date:** 2026-10-04. **Repos:** traderton (this plan); herobids
counterpart: `herobids/docs/features/2026/10/04/002-preset-assessment-on-traderton/001-plan.md`.
**Decisions:** 004 "Preset assessment is a trading charge", "Preset assessment becomes
data-only and free" (eligibility, review screen, placement), "Agent strategy ownership in
the trading profile". Resolves the 011 §3 "Market-assessment ownership" item.
**Depends on:** Wave E E1-T (`active_strategy`, scan loop, scan persistence) and E3-T
(notifications, for review wakes).
**Referenced by:** herobids' "Eliminate the Parity-Drift Check" epic
(`herobids/docs/features/2026/10/10/001-eliminate-parity-check/000-roadmap.md`, Track D)
treats this plan pair's completion as a dependency for retiring several
`parity-drift-manifest.json` entries. That epic found and fixed two scope gaps in the
herobids counterpart's step H5 (not in this file) — see the herobids plan for detail.

## Goal

`assess_strategy_preset` and `change_strategy_preset` become Traderton tools in the
`crypto-trading` skill:
- The assessment returns **computed data only** (no LLM) and is **free**, protected by
  cooldowns.
- The agent reasons over the data, guided by the skill, and changes its own active
  strategy.
- The creator's policy is enforced by Traderton and can't be overridden by the agent.

## Source to copy (herobids, behaviour-faithful; cite each copy)

- **Identity:** `packages/domain` `resolveAssessmentIdentity` +
  `apps/worker/src/market-intelligence/assessment-identity-resolver.ts`.
- **Evidence:** `evidence-adapters.ts` + `platform-assessor.ts` steps 1–6
  (`collectEvidence`, `generateScorecards`). In Traderton these call the in-process
  equivalents of `check_regime`, `get_volatility` and `score_candidate`, not the boundary.
- **Scorecards:** `preset-scorecard-runner.ts`; `PresetScorecardEntry` (already in
  `@traderton/domain` `market-assessment.ts`).
- **Request/cooldown/cache flow:** `assessment-request-service.ts`, minus every billing
  step.
- **Transition state machine:** `preset-transition-service.ts`
  (`prepared → applying → applied | failed`), re-targeted from herobids
  `agent_preset_bindings` to the profile's `active_strategy`.
- **Scheduled-review pre-check:** `packages/domain/src/review-pre-check.ts` +
  `assessment-review-runner.ts` (peer-outperformance and cooldown predicates).
- **NOT copied:** `llm-ranker.ts`, `assessor-factory.ts` LLM config, the usage-billing
  reservation/capture, and the LLM narrative fields.

## Steps

### S1. Storage
- Existing copied schemas: `market_assessment_runs`, `market_assessment_artifacts`.
  - Drop the LLM-only columns from artifacts: rankings' pros/cons/fitNotes/score,
    confidence, urgency, narrative summaries.
  - Add `presets jsonb` (per-preset data + flags, step S3).
- New `market_assessment_requests` (from herobids, minus billing columns): request
  status and cooldown bookkeeping per (owner, agent, identity).
- New `agent_strategy_changes`: `id`, `ownerId`, `actorId`, `fromStrategy`,
  `toStrategy`, `artifactId`, `reason`, `state`, `createdAt`, `appliedAt`. This is the
  audit trail and the review screen's source.
- Migrations + repositories; integration tests on real Postgres.

### S2. Preset catalog read tool
- `list_strategy_presets({ styleTier? })` (read; agent + consumer visible). Returns
  key, name, description, strategy type, `signalBias`, key params and `behaviorVersion`
  from Traderton's catalog (`config/strategy-presets/*.yaml`). Herobids uses it for agent
  creation, blueprints and pickers (herobids plan).
- Test: "lists every catalog preset for a style tier with its behaviour version".

### S3. `assess_strategy_preset` (data-only, free)
- Params: keep `symbols` (capped by `presetAssessment.maxInstrumentsPerRequest`),
  `venueFamily` and `instrumentKind`. Drop the billing meaning of `idempotencyKey`; it
  becomes a plain replay key or is removed (the implementing agent decides from 005
  rules).
- Response per symbol:
  - `canonicalIdentity`
  - `evidence`: regime result, volatility evidence, candle window; unavailable inputs are
    marked `unavailable`
  - `currentStrategy`: from `active_strategy`
  - `presets[]`, each with `presetKey`, `name`, `signalBias`, `behaviorVersion`,
    `scorecard`, and `flags`:
    - `creatorAllowed`
    - `evidenceFresh` (scorecard `scanHealth !== 'stale'`)
    - `regimeMatch`: deterministic mapping from preset `signalBias` to the regime result;
      the mapping table lives in code with its own test. The implementing agent
      enumerates every `signalBias` value in the catalog first.
    - `signalsVsCurrent` (signals ÷ current preset's signals, null-safe)
  - `artifactId`, `assessedAt`, `expiresAt`, `freshnessNote` (deterministic, copied
    `computeFreshnessNote`)
- **No free text from third parties.** Return identifiers and enums only. Sanitize or
  omit venue/DEX names (prompt-injection surface).
- **Cooldown + cache (free):**
  - A fresh artifact for the same identity and style tier is returned as-is (cache).
  - A new computation is allowed once per `presetAssessment.minRequestIntervalMs` per
    (agent, identity). The creator may lengthen it via the profile's preset policy (S5),
    never shorten it below the operator floor.
  - Inside the cooldown with no fresh artifact → `assessment.cooldown_blocked` with
    `nextEligibleAt`.
  - Copied from herobids step 4; config names and defaults chosen by the implementing
    agent from the herobids `platformAssessor` block (`minReviewIntervalMs`,
    `cacheFreshnessMs`, `maxInstrumentsPerRequest`, evidence policies).
- Tests:
  - "returns computed evidence and every preset with flags, without narrative fields"
  - "returns the cached artifact while it is fresh"
  - "blocks a recompute inside the cooldown"
  - "marks a preset whose scan was stale as not evidence-fresh"
  - "never returns venue-supplied free text"

### S4. `change_strategy_preset`
- Params: `assessmentArtifactId`, `targetPreset`, `reason` (**required** now, because the
  review screen shows it), and `mode` (`entries_only`; other modes stay rejected as
  today).
- Hard gates (004 eligibility ruling):
  1. the artifact exists, belongs to this owner/agent identity, and is fresh
  2. `targetPreset` is in the artifact with `evidenceFresh: true`
  3. the creator policy allows it (`creatorAllowed`, and preset changes enabled)
  4. the preset-change cooldown has passed (S6)
- Regime match and signal counts are **not** gates.
- Apply: transition state machine → write `active_strategy` (`source:'agent'`) through
  the profile repository, so the revision bumps and the actor rebuilds (E1) → record
  `agent_strategy_changes`.
- Tests:
  - "applies a preset change and records the agent's reason"
  - "rejects a preset the creator policy forbids"
  - "rejects a preset without fresh evidence"
  - "rejects an expired artifact"
  - "rejects a change inside the cooldown and returns the next eligible time"
  - "keeps the agent's choice when herobids resends unchanged creator inputs"

### S5. Creator preset policy in the profile (herobids-written creator input)
- Profile gains `preset_policy jsonb NULL`:
  `{ changesAllowed, allowedPresets[], styleTier, minRequestIntervalMs?, changeCooldownMs? }`.
  It's written by herobids from creator config (today `unifiedConfig.platformAssessment`
  + `allowedPresets`) and is read-only to the agent. The `active_strategy` ownership rule
  is unchanged.
- Test: "the agent cannot change the creator's preset policy".

### S6. Preset-change cooldown (new; none exists today)
- Per 004: the implementing agent **analyses the existing cooldown/config patterns
  before choosing** the home and default. Study `reviewIntervalMs` + operator floor,
  `preCheck.identityCooldownMs`, `stopLossCooldownMs`, and the Agent Mode Purity risk
  rules (user-configured = immutable; operator default = agent-mutable within operator
  bounds).
- No magic numbers. The effective value is readable by the agent (in the assess
  response and/or `get_risk_limits`).
- Record the chosen design in 004 before implementing.

### S7. Scheduled review (pre-check) moves to Traderton
- Copy the deterministic pre-check over Traderton's `agent_scan_candidates` /
  `agent_scan_metrics` (E1).
- On a positive result, write an `agent_wake` notification (E3 table) with a
  review-advice payload: identity, reason codes, and the current vs peer preset numbers.
  Herobids delivers it and builds the wake text.
- Cadence/lease: the implementing agent decides. It must be single-flight across replicas
  (consistent with the E4 lease plan).
- Tests: "emits review advice when a peer preset clearly outperforms"; "respects the
  identity cooldown".

### S8. Read tool for the review screen
- `list_agent_strategy_changes({ actorId, since?, limit })` (read; owner-scoped).
- `get_assessment_artifact({ artifactId })` (read; owner-scoped).
- Together they give herobids the data table plus the agent's decision and reason.

### S9. Tool surface + skill
- Register all tools:
  - `registry.ts`, `tool-schemas.ts` (update `change_strategy_preset` to v3: `reason`
    required, modes)
  - `skill-tool-map.ts`: add `assess_strategy_preset`, `change_strategy_preset` and
    `list_strategy_presets` to `crypto-trading`. The read tools in S8 are consumer-only.
  - MCP `tools/list` conformance
- `traderton-skills` `crypto-trading/SKILL.md`: how to read the evidence, scorecards and
  flags; the "more signals ≠ better fit" warning; switch only when clearly better, and say
  why; respect cooldowns.
- A test that every response field the skill names exists in the schema.
- **Coordinated release with herobids:** once Traderton lists these names, they become
  visible to herobids agents through the descriptor intersection. Herobids must remove its
  local tools in the same release (herobids plan H1); otherwise names collide.

## Verification
`pnpm build && pnpm lint && pnpm test`; package-level type-check of new tests;
`scripts/shell/tests/run-integration.sh`. Cross-stack, with herobids:
1. A `scanner_gated` paper agent assesses BTC.
2. It changes its preset with a reason.
3. The actor rebuilds with the new technical config.
4. The review screen shows the data and the reason.

## Docs on completion
- 001: record the Intentional divergences: LLM ranking removed (004), assessment free,
  bindings → `active_strategy`, pre-check moved to Traderton.
- 011 §3 item → resolved.
- 005: the new tools, the `preset_policy` field, and cooldown semantics.
- CANONICAL-STATE "Open decision — market-assessment ownership" → settled.

## Risks
- **Recommendation quality now depends on each agent's model.** Mitigated by the flags and
  the skill text. Watch agent-evaluation reports for preset churn.
- The scorecards are thin (one symbol, one dry run), and the skill must warn against
  "most signals wins".
- Changing a preset rebuilds the actor, which resets the equity peak (existing E1
  semantics). The cooldown limits how often that happens.
- Release coupling with herobids (S9). Ship both together, behind a deploy order checklist.
