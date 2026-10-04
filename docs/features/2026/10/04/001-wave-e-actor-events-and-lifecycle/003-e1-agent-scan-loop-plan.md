# 003 — E1: agent technical scan loop + agent-actor lifecycle

**Status:** E1-T DONE (T1 DONE, T2 DONE, T3 DONE, T4 DONE, T5 DONE);
E1-H GATED (herobids, awaiting human go).
**Depends on:** E3-T (scan results reach agents only through
the E3 `consumer_notifications` channel), and E2 (loader + status callbacks). **Repos:** traderton (E1-T), then
herobids (E1-H, gated on human go).
**Source behaviour:** `git -C ../herobids show 45271d28^:apps/worker/src/index.ts`:
- scanner singletons: `scannerCapacity` ~L288, `candleFetchRetry` ~L339,
  `candleFetchBreaker` ~L326, `buildDiscoverCandidates` ~L354
- agent actor technical config: strict/lenient parse by `hybridMode` + swap scanner
  validation ~L1240–1315
- actor deps ~L1316–1510: `discoverCandidates`, `fetchCandles`, `signalFingerprintStore`,
  `scannerSignalDedup`, `onPersistScanCandidates` (mark-coverage / DEX pricing filter),
  `onPersistScanMetrics`
- cascade stop ~L502 + call sites ~L708/1566/1636; orphan sweep ~L3053

## Goal

Hybrid agents (`capabilityMode:'hybrid'`, `hybridMode: 'scanner_gated' | 'mixed'`) get
their scanner back, inside Traderton. The agent actor has an explicit lifecycle that
survives Traderton restarts. When an agent stops or crashes, its bots stop.

## E1-T — Traderton

### T1. Profile carries the scan configuration — with one owner per field

**Ownership rule (004 "Agent strategy ownership in the trading profile", 2026-10-04).**
The later preset slice
([004-preset-assessment-data-only](../004-preset-assessment-data-only/001-plan.md)) lets
the agent change its preset inside Traderton. If herobids kept sending a resolved
technical config, a later unrelated profile update (e.g. the creator edits capital) would
overwrite the agent's choice. So the profile splits into creator inputs (written only by
herobids) and active strategy state (written only by Traderton):

| Column | Writer | Meaning |
|---|---|---|
| `scan_mode text NULL` | herobids (creator input) | `'scanner_gated' \| 'mixed'`; null = no scan loop |
| `creator_strategy jsonb NULL` | herobids (creator input) | Exactly one of `{ presetKey, styleTier }` (preset chosen by the creator) or `{ customTechnical: TechnicalConfig }` (creator-authored config) |
| `active_strategy jsonb NULL` | **Traderton only** | `{ presetKey \| null, styleTier, behaviorVersion, technical: TechnicalConfig (resolved), source: 'creator' \| 'agent', changedAt }`. This is what the actor runs. |

- `set_agent_trading_profile` accepts only `scanMode` + `creatorStrategy` (optional;
  absent = unchanged for old callers). It **never** accepts `active_strategy`.
- Traderton derives `active_strategy` on write:
  - **First set, or `creatorStrategy` changed** (compared to the stored value): resolve
    and set `source:'creator'`. Creator intent is supreme, so a real creator change resets
    any agent choice. Preset → technical resolution uses Traderton's own catalog and
    `applyPresetToAgent` (`packages/domain/src/config/presets*.ts`). Custom technical is
    used as-is.
  - **Unchanged `creatorStrategy`**, for example a resend while saving capital: leave
    `active_strategy` untouched.
- Parity check: herobids resolves today with its own copy of the catalog and
  `applyPresetToAgent` (`apps/api/src/agents/strategy-preset-resolver.ts`). Add a parity
  test proving Traderton's resolution gives the same `TechnicalConfig` for every preset ×
  style tier as herobids' copy (fixtures generated once from herobids). Fix drift in the
  source before relying on it.
- Validation at the boundary, applied to the **resolved** technical config, copied from
  source:
  - `scanner_gated` → `StrictTechnicalConfigSchema.parse` then
    `TechnicalConfigSchema.parse`; reject when no strategy is given
  - `mixed` → lenient `TechnicalConfigSchema.parse`
  - swap-venue + `scanner_gated` → copied `validateSwapScannerConfig`
  - errors map to `validation.*` codes
- Agent-visible read: `get_agent_trading_profile` returns `active_strategy`, so the agent
  and herobids can see what's running.
- Tests:
  - "rejects a scanner-gated profile without a creator strategy"
  - "resolves a creator preset to the same technical config herobids produced"
  - "repairs a mixed-mode technical config with defaults"
  - "rejects an incoherent swap scanner config"
  - "keeps the active strategy when an unchanged creator strategy is resent"
  - "resets the active strategy when the creator changes their strategy"
  - "keeps existing profiles valid when scan fields are absent"

### T2. Scanner config (operator config)
- Copy the source subtrees into Traderton's schema + `config/default.yaml` under
  `agentScanner` (trading-owned; herobids' `agentRuntime` was dropped as platform):
  - `candleFetchRetry`, `candleFetchBreaker`, `scannerSignalDedup`
  - `swap: { enabled, venues }`
  - the capacity source (`marketData.*.scanner`, which already exists, ~L233)
- Defaults copied verbatim, with comments. No env vars, so no `.env.example` change
  (confirm; add twins if any env override is introduced).

### T3. Scan persistence (Traderton-owned)
- Copy herobids `packages/db/src/schema/agent-scan-candidates.ts` +
  `agent-scan-metrics.ts` into `@traderton/db`, with a migration and repositories
  (`insertCandidates`, `insertMetrics`).
- Retention: copy the source retention behaviour if one existed (herobids config has
  `platformAssessor.preCheck.candidateRetentionMs`, 7d; find its pruner). If no pruner
  existed, add a batched prune loop modelled on E3's notification pruning (same
  config-driven shape) rather than leaving the tables unbounded.

### T4. Wire the scan loop into the agent actor
- `AgentActorSpec` gains `ownerId`, `scanMode` and `activeStrategy` (from the profile's
  Traderton-owned `active_strategy`). Its `technical` feeds `technicalConfig`, and
  `presetKey`/`behaviorVersion` feed scan-metric identity.
- `constructAndRegisterAgentActor` passes, when `scanMode` is set:
  - `technicalConfig`, `isHybridMode: true`
  - `discoverCandidates`: copy `buildDiscoverCandidates` into
    `packages/worker/src/composition/discover-candidates.ts` (verbatim, citing the source)
  - `fetchCandles`: the boundary's existing `scannerCandleFetcher`
  - `candleFetchRetry` / `candleFetchBreaker` / `maxConcurrentScans`
  - `signalFingerprintStore` (Redis), `scannerSignalDedup`
  - `onPersistScanCandidates`: copied filter logic + Traderton repo
  - `onPersistScanMetrics`
  - plus the E3 notifier callbacks
- These are injected into `AgentActorRuntimeDeps` (built once in `createTradingRuntime`
  / `bin.ts`), not per call.
- `agent-direct-actor-ensure.ts`: the spec includes the new profile fields. A revision
  change already forces reconstruct, so a technical/preset change applies through the
  existing rebuild path. `applyPendingConfigUpdate` hot-apply is a later optimisation
  (it would avoid resetting the equity tracker); record it in 010, not here.
- Tests (`decision-intake.test.ts`, `agent-direct-actor-ensure.test.ts`):
  - "starts a scan loop for a scanner-gated agent"
  - "runs no scan loop when scan mode is absent"
  - "persists scan candidates and metrics after a scan"
  - "rebuilds the actor when the technical config changes"

### T5. Explicit lifecycle tools + persisted run state
- New table `agent_actor_runs`: `ownerId`, `actorId`, `venueAccountId`, `venue`,
  `venueType`, `desiredState ('running'|'stopped')`, `updatedAt`; unique `(ownerId,
  actorId)`.
- `start_agent_actor` (category write; venue-resolving, so the context factory's
  ensure constructs and starts the actor): upsert `desiredState='running'` with the
  injected venue coordinates. Idempotent per 005.
- `stop_agent_actor` (category write): set `desiredState='stopped'`, stop + deregister
  the actor, evict the ensure cache entry (the ensure needs an `evict(ownerId, actorId)`
  method), then **cascade-stop the agent's running bots**: `getBotsByCreator('agent',
  actorId)` → `markBotStopped` + `runtime.stopInstanceDirect` (source:
  `cascadeStopAgentBots`). Idempotent.
- Both are agent-subject tools, owner-scoped, actor = the agent itself. Add them to
  `registry.ts`, the MCP skill map (decide which skill; default `crypto-trading`), and
  `tool-schemas.ts`.
- **Rehydrate on boot** (`bin.ts`, after `runtime.start()`): for each `desiredState='running'`
  row, call the ensure with the stored coordinates and the profile's execution mode.
  Failures are logged per agent and retried by the orphan sweep below.
- **Orphan sweep** (periodic, operator config `agentScanner.orphanSweepIntervalMs`,
  copied default from source `worker.agents.botOrphanSweepIntervalMs`):
  - stop running bots whose creator agent's run state is `stopped` or absent (source:
    `listRunningBotsForInactiveAgents`, liveness = `agent_actor_runs`)
  - re-ensure `running` agents whose actor isn't alive
  - reschedules itself on failure
- Lazy ensure on other venue-resolving calls stays as the fallback. It does **not**
  write run state, so only `start_agent_actor` declares intent.
- Tests:
  - "start_agent_actor records running state and starts the actor"
  - "stop_agent_actor stops the actor and its running bots"
  - "rehydrates running agent actors on boot"
  - "orphan sweep stops bots of a stopped agent"
  - "repeated start/stop calls are idempotent"

## E1-H — herobids (GATED: start only after human go)

### H1. Send scan configuration with the profile
- `apps/api/src/agents/trading-profile-reconciliation-saga.ts` (+ the agents route that
  builds the profile): send **creator inputs only**:
  - `scanMode` from `capabilityMode`/`hybridMode` (`hybrid` + `scanner_gated|mixed`,
    else null)
  - `creatorStrategy`: `{ presetKey, styleTier }` when the creator picked a preset
    (`metadata.strategyPreset` / `strategy.type` + style), or `{ customTechnical }` when
    the creator authored `unifiedConfig.technical` directly
  - never a resolved config and never the active strategy (T1 ownership rule)
- Tests:
  - "sends the creator's preset, not a resolved technical config"
  - "sends custom technical config for creator-authored agents"
  - "sends no scan mode for intelligence agents"

### H2. Session lifecycle calls
- `apps/worker/src/index.ts` `onSessionActive` → `start_agent_actor` (per-agent write
  boundary). `onSessionStopped`, `onAgentCrashed` and the AgentHealthMonitor
  terminal-cleanup hook → `stop_agent_actor`. These restore the hooks L3d-5 removed
  (`cascadeStopAgentBots` call sites). Failures log and do not block the session
  transition (best-effort, like source).
- Agent delete path (`DELETE /agents/:id` cleanup) → `stop_agent_actor`.
- Tests: "starts the Traderton agent actor when a session activates"; "stops the
  Traderton agent actor and its bots when a session stops".
- Verify worker with `pnpm exec tsc --noEmit -p apps/worker/tsconfig.json`.

## End-to-end proof (after both halves)
Cross-stack leg:
1. Create a `scanner_gated` paper agent and activate its session.
2. Within 2 scan intervals, the agent receives `agent.technical.scan_completed`, and a
   wake if there are signals.
3. Stop the session. The actor stops, a bot the agent created stops, and the run state is
   `stopped`.
4. Restart Traderton with a session active. The actor is rehydrated.

## Docs on completion
001 C2-table agent rows (scan loop, persistence, lifecycle driver) and bot cascade/orphan
rows → **Met**. Record authored pieces (`agent_actor_runs`, lifecycle tools,
journal-based liveness) as Intentional divergence with the reason (cross-process
boundary). 005: new tools + profile fields. 011 E1/E2 ticked. CANONICAL-STATE §2.1
updated.

## Risks / residual questions
- **No lease on agent actors** in E1 itself. This is safe only with one boundary replica
  (true today; add the 007 note in this phase). The durable fix is planned in
  [002-agent-actor-lease-and-routing](../002-agent-actor-lease-and-routing/001-plan.md)
  (011 E4). Keep the E1 rehydrate/sweep behind one ensure entry point so that plan can
  make them lease-aware.
- **Visibility of `start_agent_actor` / `stop_agent_actor` — RESOLVED (human, 2026-10-04):**
  they are consumer-only. Herobids' session manager calls them; agents must not see them.
  Keep them out of every `SKILL_TOOL_MAP` skill set and out of the agent-visible
  `tools/list`. Implementation: confirm `skill-tool-map.ts` / the MCP `tools/list`
  builder can exclude a registered tool, or add a "consumer-only" marker. Add a test that
  neither tool appears in any agent-visible tool set.
- **Preset changes** made by herobids' current `change_strategy_preset` still write only
  the herobids binding, so they don't reach `active_strategy`. That's expected until the
  preset slice ([004-preset-assessment-data-only](../004-preset-assessment-data-only/001-plan.md)),
  which adds the agent-driven write path (`source:'agent'`) on top of T1's ownership split.
- The ensure rebuilds the actor on every profile revision, which resets the equity peak
  (existing behaviour). It becomes more frequent if technical config changes often. Track
  the hot-apply optimisation in 010.

## Outstanding Issues (non-blocking, from code review)

### [T1] profile scan config columns + ownership split + resolution + parity
- RESOLVED (MEDIUM, folded in): the duplicate `stableCanonicalJson` helper in the profile
  repo was removed; the active_strategy comparison now reuses the existing `canonicalJson`.
- RESOLVED (LOW, folded in): added `.describe()` to the new `scanMode`/`creatorStrategy`
  tool params; added a sentinel comment on the custom-technical `styleTier: 'standard'`.
- LOW: a changed/first set resolves the creator strategy twice — once in the tool
  (validation) and once in the repo (derivation), each with its own `changedAt` timestamp.
  The repo value is authoritative; the double resolution is correct and cheap. No action.
- NOTE: `run-integration.sh` was extended to wire in the pre-existing
  `agent-trading-profile-repository.integration.test.ts` (it was not previously in the
  allowlist); additive, keeps `--no-file-parallelism`.
- NOTE: parity fixture `__fixtures__/herobids-preset-resolution.json` was independently
  verified by the reviewer to be genuine herobids output (not circular); preset YAMLs +
  presets.ts are byte-identical across repos, so no drift.

### [T2] agentScanner operator config
- LOW: the out-of-bounds schema test exercises one bound (`scannerSignalDedup.topN:51`).
  A few more boundary cases (maxDelayMs>10000, maxSkipScans>100, ttlSeconds<60) would
  broaden regression coverage. Optional.
- NOTE: herobids keeps swap under `scanner.swap`; Traderton flattens it to
  `agentScanner.swap` per the T2 plan text (defaults/bounds byte-identical, parity holds).

### [T3] scan persistence tables + repositories + retention
- LOW: the scan integration test's `beforeAll` uses `db as unknown as Database` (test-only,
  with a justification comment — TestDb and Database are structurally identical). Optional:
  align `openTestDb()` to return `Database` and drop the cast.
- LOW: comments cite herobids' 7d read window (604_800_000ms) as the retention basis;
  herobids has no actual pruner, so this loop is new (per the plan). Documentation-only.
- NOTE: the only intended divergence from the herobids schema is dropping the
  `agent_scan_candidates.agentId` FK to the (non-existent in Traderton) `agents` table —
  it is a soft text reference, verified no FK in migration 0006.

### [T4] wire scan loop into agent actor
- LOW: no test exercises the swap-venue arm of `wireScanDeps`
  (swapNetwork/swapQuoteAssetAddress/swapEnabled resolution); orderbook path is well
  covered. Optional swap-spec test would broaden coverage.
- LOW: `quoteAssetSymbol ?? 'USDC'` default is applied both in `wireScanDeps` and inside
  `buildDiscoverCandidates`. Harmless double-default, mirrors source.
- LOW: test fixtures use `as unknown as TechnicalConfig/ActiveStrategy` for partial
  strategy objects (test-only). A typed factory helper would remove the cast.
- NOTE: `marketData` is optional in schema and guarded in production (scannerCandleFetcher
  undefined when absent → scan loop simply doesn't start); the test-fixture completion is
  benign, not masking a missing guard. The scanner candle fetcher is built eagerly from
  `config.marketData` (traderton reads config directly, unlike herobids which built it from
  the post-start registry).

### [T5] lifecycle tools + agent_actor_runs + cascade/rehydrate/orphan sweep
- RESOLVED (LOW, folded in): `narrowVenueType` now logs a warn on an unexpected stored
  `venue_type` (defaults to orderbook) for observability.
- LOW: `injectionFor` uses a placeholder `ownerMode: 'paper'` (the ensure re-derives the
  real mode from the profile — documented). A named const would make the intent clearer.
- LOW: no orphan-sweep swap-venue arm test / no explicit no-FK test. Minor coverage gaps.
- LOW: unit tests use `as unknown as` for fake runtime/registry/repo (standard fake idiom).
- NOTE: the two lifecycle tools are consumer-only per the RESOLVED human ruling — registered
  in buildToolRegistry but ABSENT from SKILL_TOOL_MAP and with NO get_schema entry, so they
  never appear in the agent tools/list (verified by the tools-from-registry visibility test).
  This overrides the T5 plan text's "add to tool-schemas.ts / MCP skill map" line.
