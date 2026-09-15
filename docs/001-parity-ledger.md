# Parity Ledger

**Status:** living
**Purpose:** track every source-system trading capability against its status in
Traderton. Feature parity is the standard (see [000-vision.md](./000-vision.md)).
The source repo (`herobids`) is the specification. We may improve, not degrade.
The exhaustive source inventory lives in
[006-source-capability-manifest.md](./006-source-capability-manifest.md); this
ledger carries the live status against that inventory.

## Status meanings

| Status | Meaning |
|--------|---------|
| **Pending** | In inventory, but not yet copied or verified. Transitional status before work reaches that slice. |
| **Met** | Reproduced; verified against source behaviour (copied code + copied tests green). |
| **Improved** | Reproduced and made better. Note what changed and why. |
| **Deferred (optional)** | Deliberately not done yet, with **no herobids parity obligation** (genuinely new/nice-to-have, e.g. bot cloning). May remain unbuilt without harm. Note reason. |
| **Deferred (required for cutover)** | Deliberately not done yet, but herobids will **rely on Traderton to provide it** in the end state (see "herobids becomes a consumer" in [000](./000-vision.md)). Deferred only in *when*, not *whether* — **blocks cutover until resolved.** Note reason + the tool/subsystem row it belongs to. |
| **Gap** | Attempted; fell short. Note exactly what is missing and why. Requires sign-off. |
| **Intentional divergence** | Source behaviour deliberately NOT copied because it was platform coupling, not trading capability. Note the seam. |

Rules: nothing is silently dropped — every source capability appears here.
Nothing regresses without an explicit **Gap** entry that someone signed off.

## Ledger

### Phase 1 (domain slice) — DONE

**Status: DONE.** The `@traderton/domain` trading slice compiles under strict TS, lint is clean, and all copied domain parity tests pass (230). No platform imports remain in the slice; no `@herobids` references; no LLM coupling.

**Phase 2 (`db`): DONE** — see "Trading data model" row (Met) + the Phase 2 Intentional Divergence rows. `@traderton/db` compiles strict, lint clean, copied unit tests green (11 pass; 9 integration gated on DATABASE_URL), fresh initial migration generated, no platform imports/FKs.

**Phase 3 (`engine`): DONE** — `@traderton/engine` extracted by copy-and-delete. Domain-only (sole prod dep `@traderton/domain`). 58 src files copied byte-identical (modulo `@herobids/*`→`@traderton/*` rename; verified by diff in review), incl. the **risk gate byte-identical**. One seam cut: the platform preset-review `wake-gate.ts` (+ test + 2 barrel exports) deleted as Intentional Divergence. Compiles strict, lint clean, forbidden-import sweep clean. **Engine slice: 437 copied tests green** (incl. risk-gate parity 83 unmodified). Risk-gate exact-rules table + engine-subsystems rows → Met; wake gate → Intentional divergence.

**Phase 4 (`market-data`): DONE** — `@traderton/market-data` extracted by copy-and-delete. Domain-only (+`node-html-parser`). Clean-package, **zero seams**: 44 files copied, the only diff across all files is the `@herobids/domain`→`@traderton/domain` rename (3 files; other 41 byte-identical — verified by diff in review). Compiles strict, lint clean, forbidden-import sweep clean (no LLM-package/platform/db/venues/engine imports). **market-data slice: 354 copied tests green.** "Market data / discovery" row → Met; `regime`+indicators (mechanical analysis inputs) landed.

**Phase 5 (`venues`): DONE** — `@traderton/venues` extracted by copy-and-delete. Depends on domain + market-data (+`ccxt`/`viem`/`ws`). 40 files copied verbatim (diff = namespace rename only; verified in review). One seam cut: the platform browser-pool `browserless-adapter.ts` (+ test + 2 barrel exports) deleted as Intentional Divergence (needs Phase-1-dropped `BrowserPoolPort`; only consumer was the platform agent worker). Compiles strict, lint clean, forbidden-import sweep clean. **venues slice: 177 unit tests green; 6 integration tests credential-gated (skip).** ccxt pinned to source-resolved `4.5.54` ([003](./003-anomalies-and-deviations.md)). Venue-adapter rows → Met; browser-pool → Intentional divergence.

**Phase 7 (`backtesting`): DONE** — `@traderton/backtesting` extracted by copy-and-delete. Clean-package, **zero seams**: 13 files copied verbatim (incl. `importers/`; diff = namespace rename only; file sets identical — verified in review). Depends on domain + engine (all 19 imported barrel symbols present). Compiles strict, lint clean, forbidden-import sweep clean (only `@traderton/domain` + `@traderton/engine`). **backtesting slice: 49 copied tests green.** "Backtesting / replay" row → Met.

**Phase 8 (`apps/worker` — mechanical trading loop): DONE (partial by design — the largest, hardest phase).** `@traderton/worker` extracted by copy-and-delete as the **M1 library surface** (no API). Landed the mechanical loop MODULES verbatim (39 files: trading actors, `WorkerRuntime`, scanners, technical-phase, tick-gates, reconciliation, venue-adapter-factory, swap/instrument, risk/gating, utils; byte-identical modulo namespace — verified in review). One sanctioned seam: `scan-types.ts` (verbatim-relocated scan value-types from the DELETE'd `runtime-composition.ts`). Build + lint clean, forbidden-import sweep clean (no `@herobids/*`, no llm/documents/ses/platform). **worker slice: 681 copied tests green; whole repo 1995 passed / 15 skipped / 0 failures.** Required a **domain re-sync** (herobids source-fix #2 relocated 5 trading types Phase 1 had over-deleted) and hit **3 stop-gates** (all human-resolved — see [003](./003-anomalies-and-deviations.md)). **Deferred (required for cutover), authored at M1-integration/Phase 9 (NOT dropped):** (i) the Traderton-owned **config shape** (`config.ts`/`AppConfig`/`AgentRiskDefaultsConfig`); (ii) the **trading composition root** (herobids `index.ts` has no faithful subset — actors are constructed by deleted startup/session/intake wiring); (iii) the **decision-intake/approval/session surface** (venue-account-direct resolver + `submit_decision` intake + human approvals — the reclassified 5-file cluster); (iv) per-`ownerId` **`create_bot`/`start_bot` limit**. These + a few copied files that depend on them are quarantined verbatim in `packages/worker/src/_deferred-config/` (excluded from build+vitest until authored). Intentional Divergence (platform, not copied): `agent.ts`, hybrid evaluators, `runtime-composition` body, `startup-context` (connection grant front-end), `venue-intelligence`, `intelligence-tools`, `tick-thinking` (agent scout/judge reasoning), `backtest-runtime` (LLM), agent-evaluation/alerting/market-intelligence/tools/agents dirs. Outstanding: LOW — a verbatim `@herobids/backtesting` string in a `describe()` regression-test label (`backtesting.test.ts:355`) is left verbatim per copy-never-author (non-import string; test asserts the correct Traderton package.json and passes).

**Phase 6 (`strategy` mechanical slice): DONE** — `@traderton/strategy` extracted by copy-and-delete (clean-package *split*). Depends on domain + market-data (+`zod`); **NO `@herobids/llm`/`@traderton/llm` dep** (decision 9 — no LLM cost center). 7 files copied verbatim (`mechanical-strategy`, `dca-strategy`, `scan-engine` + their tests, and `index.ts`; diff = `@herobids/*`→`@traderton/*` rename only, verified in review). The llm/hybrid slice (`llm.ts`, `llm-provider.ts`, `hybrid-strategy.ts` + tests) was **never copied** — Intentional Divergence (decisions 7–9; extends the `LlmStrategy`/`HybridStrategy` divergence row). `index.ts` barrel-trimmed by exactly the 3 `./llm` + 1 `./hybrid-strategy` export lines. Both stop-gates cleared: mechanical slice is llm-free (no `./llm`/`./hybrid` imports) and every needed domain/market-data symbol is in the Traderton barrels — `HybridPricingIdentity` kept (it is the domain pricing-identity used by `scan-engine`, **not** `HybridStrategy`). Compiles strict, lint clean, forbidden-import sweep clean (no `@herobids/*`, no `@traderton/llm`/`@herobids/llm`, no platform/db/engine/venues). **strategy slice: 56 copied tests green** (dca 14, mechanical 18, scan-engine 24). "Mechanical strategies" row → Met. See [Phase 6 plan](../archive/features/006-strategy-plan.md).

**Phase 9a (`apps/api`/tools — COPY surface): DONE.** After herobids source-fixes #2 (trading-protocol types) + #3 (tool contract split) + #3b (`executionConfig` port), `@traderton/domain` re-synced (verbatim `trading/tool-contract.ts` + `tool-schemas.ts`, barrel-wired; 3 platform schema-registry entries trimmed as Intentional Divergence). **18 of the 25 trading tools copied verbatim** into `packages/worker/src/tools/` (`account`, `analytics`, `find-instrument`, `market-data`, `price`, `risk-limits`, `watch`, `resolvers`, `schema` — byte-identical modulo namespace; narrowed to `TradingToolContext`) + `intelligence-tools.ts` + a `watch-summary.ts` seam (verbatim relocation of `summarizeActiveWatches` closure from the DELETE'd `runtime-composition.ts`). **7 tools deferred to 9b** (`submit_decision`, `create_bot`, `start_bot`, `stop_bot`, `list_bots`, `get_bot_status`, `adjust_bot_config` — `tools/{trading,bots}.ts`, drive-path `AGENT_MESSAGE_TYPES`). The 10 clean-looking API routes were all **quarantined** (`_deferred-authoring/`) — each needs authored deps (auth `request.userId`, `userId`→`ownerId` schema, config shape, platform tables), so they are 9b. Build + lint clean; **whole repo 2131 tests pass / 15 skipped / 0 failures.** Reviewed (copy-not-authored verified; forbidden-import sweep clean). See tool inventory table + [009-api-plan](../archive/features/009-api-plan.md).

**Phase 9b (authoring pass) — IN PROGRESS.** Governed by [013-9b-authoring-plan.md](../archive/features/013-9b-authoring-plan.md) (minimum-authoring re-scope: most of 9b is copy-and-delete; only a small bounded core is authored). Landed so far:
- **Pre-9b cleanup:** `decision_approvals` table + repo deleted (human-approval lifecycle is consumer-owned — see the Intentional Divergence row + [004](./004-decision-log.md)). Migration regenerated (22 tables).
- **Item A — config shape: DONE (copy-and-delete / fused-file trim, ZERO authoring except one deferred S-1 line).** Re-synced `AppConfigSchema`/`AppConfig` + `AgentRiskDefaultsSchema`/`AgentRiskDefaultsConfig` into `@traderton/domain` by trimming platform keys + the platform `superRefine` blocks from the herobids source object literal (kept the 2 trading `superRefine` checks) — re-opening the Phase-1 over-deletion that removed `AppConfigSchema` wholesale. Un-quarantined from `_deferred-config/` (verbatim moves): `agent-risk-limits.ts` (+`.test`+`.parity.test`), `public-stream-routing.ts` (+`.test`), and the config loader `config.ts` (+`config.test.ts`) — loader trimmed of platform `ENV_OVERRIDES` + billing guards; the copied loader test trimmed to trading-only (platform describe/it blocks removed whole; `BASE_YAML` platform block dropped — line-traceable to source). **Config-shape `Deferred (required for cutover)` → RESOLVED.** Build + lint clean; **whole repo 2231 tests pass / 15 skipped / 0 failures** (+100 vs the 9a baseline of 2131, from the un-quarantined config/risk-limits/stream-routing parity tests). S-1 mechanical-only narrowing (the one authored line + assertion) is a separate later step, still pending.
- **Item B — swap-venue token-safety gating: RESOLVED (C1, 2026-09-12; was `Deferred (required for cutover — swap bots only)`).** The prior deferral rested on "reproducing `enrichTokenWithDiscovery` is non-wiring authoring" — SUPERSEDED (008 §9.1: copying a self-contained herobids helper verbatim is copy-faithful, not authoring). `enrichTokenWithDiscovery` copied VERBATIM from herobids `main` `apps/worker/src/index.ts:93-152` into `packages/worker/src/swap-token-enrichment.ts`; `swapTokenSafety` wired into the per-bot ActorFactory in `create-trading-runtime.ts` via the copied `createSwapTokenSafetyAdapter` + the herobids `resolveTokenData` closure (index.ts:243-268), guarded `config.marketData && sharedMarketDataRegistry` (orderbook/paper keep `undefined` → unaffected); override repo once-per-runtime; the 1inch `swapNetwork` fail-closed guard (herobids `index.ts:2043-2047`) re-added after `swapNetwork` resolves. Composition seam tests + an 8-case enrichment test. worker tsc clean; worker suite 1105/0. Reviewed (no CRITICAL/HIGH). Swap-venue token safety now at PARITY.
- **Item A′ — mechanical-only narrowing: DONE (2026-09-07).** Authored `MechanicalStrategySchema` (Traderton wrapper); `BotConfigSchema.strategy` re-pointed at it; copied `StrategySchema` left byte-verbatim; `config/mechanical-only.test.ts` (9 assertions) pins the guarantee. See the mechanical-only Intentional Divergence row.
- **Item B — trading composition root: DONE (2026-09-07, commit 5834402).** Authored `createTradingRuntime` factory (bot-lifecycle scope only) — WIRING ONLY over copied `@traderton/*` modules; singletons + per-bot `ActorFactory` (traced to herobids `index.ts:1878–2249`); injected `venueAccountId` (decisions 11–13); `createStrategy` mechanical/dca; live-gate + market-data recorder wired verbatim; status callbacks M1 no-op stubs. `@traderton/worker` now consumable through its barrel (was `export {};`). Reviewed (no critical/high). Build green, lint clean, **2244 tests pass** (+4 smoke). Trading-loop "assembled runtime" composition `Deferred (required for cutover)` → **Met (bot-lifecycle)**; the agent-direct runtime + intake remain item C. See [013 §4](../archive/features/013-9b-authoring-plan.md) + [015](../archive/features/015-composition-root-proposal.md).
- **Item C — decision-intake surface: DONE (2026-09-07).** Authored WIRING + one thin seam over the Phase-8-copied actor-owned intake — no copied module altered. (1) Item B's factory now owns the **one** `actorRegistry: Map<string, ExecutionActor>` (bots register in the `ActorFactory`; agents via the construct hook) + exposes `registerActor`/`deregisterActor`. (2) Authored the slim `submitDecision(registry, input)` router (`packages/worker/src/composition/decision-intake.ts`): resolves the running actor → drives the copied `getIntakeDeps`/`getDecisionContext`/`getPosition` + `validatePerTradeLevels` + `submitDecisionForExecution`; returns a typed `accepted`/`rejected{code,message,retryable}`/`error`. Traced to herobids `agent-decision-handler.ts` step 4→8 and the composite resolver's `actor?.isRunning` arm (`index.ts:818–864`); **DROPPED** (per 013 §5 / 019 §4) the paused/stale-session gates, the entire `approval_required`/Telegram/pending-approval block, all `InstanceEventPublisher` emits + `decisionFailureRepo` side-channels (→ item C2, M1 no-op), the grant-fallback arms (kept only the running-actor arm — decision (a)), and the `updateRiskLimits` agents-table refresh. (3) Venue-account-direct seam: the injected `venueAccountId` flows through the actor's own intake (`intake.venueAccountId`); the venue-account-EXISTENCE guard is the actor's `start()` via `venueAdapterFactory` (throws `CredentialResolutionError`) — item C validates only that the injected `venueAccountId` is non-empty at construct. No parallel grant resolver authored (confirmed the actor already carries the seam). (4) `constructAndRegisterAgentActor` + `stopAndDeregisterAgentActor`: build `AgentTradingActorDeps` from the item-B singletons + `buildAgentRiskLimits` fed from **injected** values (never the `agents` table) + a per-actor `createFillFirstMarkSource`; event callbacks are M1 no-op stubs; `onCrashed → deregister`. Does NOT drive lifecycle (item D). Authored deterministic test `composition/decision-intake.test.ts` (8 assertions, clearly labelled AUTHORED — stub actor + stubbed engine boundary, real routing + level-validation). Build green, lint clean, **2252 tests pass / 15 skipped / 0 failed** (+8 authored). The grant-fallback Intentional Divergence row already exists (no new row) — item C is its implementation. **Surfaced divergences:** (a) the `updateRiskLimits` runtime-refresh that read `agentRepo.getAgent` is DROPPED for M1 (its source is the platform `agents` table; a runtime risk-refresh can be re-added from injected values later if needed — the actor's `updateRiskLimits` hook is preserved). (b) The herobids per-instrument handler-side circuit-breaker failure counters (`no_context`/`swap.instrument_format` thresholds) are dropped — kept the typed rejection simple; the actor's OWN `VenueCircuitBreaker` (`circuit_breaker_open` via `getIntakeDeps`) is preserved. Both noted in 013 §5. `submit_decision` intake/execution surface → **Met (intake/execution; drive path is item D, events are item C2).**
- **Item D — in-process drive target + drive-path tools: DONE (2026-09-07).** COPIED `tools/trading.ts` + `tools/bots.ts` verbatim (diff = namespace + the sanctioned `TradingToolContext` convention only) + their herobids parity tests. AUTHORED (seam/wiring, tracing herobids line-by-line): a 3-const `AGENT_MESSAGE_TYPES` (values verbatim); the in-process `publishToInbound` drive target (`DECISION_SUBMIT`→item C `submitDecision` + `lpush`/`expire` reply matching `trading.ts`'s `blpop`; `MANAGE_BOT`→bot-lifecycle handler; no `BOT_QUERY` route); `handleManageBot` tracing the herobids trading core over the copied `WorkerRuntime`; `WorkerRuntime.enqueueLifecycle`. DROPPED (Intentional Divergence — platform, decisions 7–13): the `handleManageBot` agent-session + connection-grant + LLM-model-policy shell; `emitInstanceStatus` (→ item C2). The 7 drive-path tools → **Met** (see rows below). Reviewed (no critical/high). Build green, lint clean, **2303 tests pass** (+50). **Item-E seam:** create/start persist+limit is one injected `BotLimitSeam` (pre-E → `bot_limit_unavailable`); E must also claim the DB running-slot on create. See [013 §6](../archive/features/013-9b-authoring-plan.md).
- **Item E — per-`ownerId` maxBots enforcement: DONE (2026-09-07). COMPLETES M1.** Re-instated the two `BotRepository` limit methods (`tryCreateBotWithLimit`/`tryMarkBotRunningWithLimit`) deleted in Phase 2, re-keyed per-`ownerId`. Mostly-COPY (reframed after human challenge): the count/insert/mark bodies mirror the herobids broker method (`repositories.ts:905–1027`) line-for-line; the atomicity **copies** herobids' own API-path advisory-lock form (`pg_advisory_xact_lock(classId, hashtext(ownerId))`, already in Traderton `_deferred-authoring/api-routes/bots.ts:135`), re-keyed `agents`-row→`ownerId` (`MAXBOTS_LOCK_CLASS=17`); the two-call create→mark is preserved (`running` = the `reclaimOrphans` crash-recovery contract). Only the `createTradingRuntime` seam wiring (`maxBots` from `agentRiskDefaults.maxBots` + injected per-owner `maxBotsOverride` VALUE) + the item-D `createAndStart` create→mark call are authored. `maxBots` never read in the db layer (value arg). Concurrency proven by a DATABASE_URL-gated integration test (N-at-k → exactly k). Reviewed (no critical/high). Build green, lint clean, **2315 tests pass** (+7; +2 gated skips). `create_bot`/`start_bot` limit-enforcement → **Met** (see rows below); the per-agent→per-`ownerId` reshape is an Intentional Divergence (row below). See [013 §7](../archive/features/013-9b-authoring-plan.md).
- **Item F1 — M2 REST boundary shell (read-only): DONE (2026-09-08), on branch `f-m2-rest` (NOT merged to `main`).** New `packages/boundary` (`@traderton/boundary`) — the authored 005 machinery over the copied tools: Fastify shell + HMAC-SHA-256 auth (configured consumers/keys, clock-skew, constant-time, header↔body `caller` **and** `X-Request-Deadline-At`↔`body.deadlineAt` match) + envelope/version validation (reject unknown outer keys, path-major↔contractVersion-major) + the `tools:invoke` dispatcher over the copied `ToolRegistry` (**read-only tools only** — `getReadOnlyToolNames`; side-effecting tools rejected `precondition.not_ready`) + result mapping onto the closed failure union + `/health/{live,ready}`. `packages/worker` barrel widened to re-export `ToolRegistry`/tools; root `tsconfig.json` + `vitest.config.ts` alias; `fastify@5.12` added. Reviewed (PASS, no critical/high). Build green, lint clean, **2334 tests pass / 17 skipped** (+19 authored F1 tests, authored against 005 — no copy oracle). **F1 CodeReviewer MEDIUMs:** M1 (deadline header↔body match) + M2 (canonical PATH stripped of query) FIXED in F1; **M3 (005 §Authz item 3 — actor provenance valid for the requested tool) DEFERRED to F2** (read-only blast radius is low; F2 authors it with the side-effecting surface — see [003](./003-anomalies-and-deviations.md) + [013 §8.5](../archive/features/013-9b-authoring-plan.md)). Not merged — the merge gate is unmet and F2 remains.
- **Item F2a — `boundary_invocations` idempotency store: DONE (2026-09-08), on branch `f-m2-rest` (NOT merged).** New `@traderton/db` table + migration + `BoundaryInvocationRepository`, COPY-ADAPT (D1) from the herobids oracle (`blueprint-idempotency.ts` + the blueprints fork route + `blueprint_instantiation_requests`), re-keyed to the 005 four-tuple `(consumer_id, owner_id, tool_name, idempotency_key)`; authored the `state`/`in_progress`→`terminal`/retention/expiry deltas 005 adds. `beginOrResolve` (advisory-lock class 18 → started/in_progress/replay/conflict), `complete` (idempotent guard), `findByRequestId` (feeds F2b). Reviewed (no critical/high; H1 concurrency-test efficacy + M1 double-complete FIXED; LOW-1 → backlog B6). Build green, lint clean, **2340 pass / 24 skipped**; the integration test is `DATABASE_URL`-gated (skips locally, runs in CI/Phase 10 — item-E gating). See [013 §8.6](../archive/features/013-9b-authoring-plan.md).
- **Item F2b — dispatcher integration: DONE (2026-09-08), on branch `f-m2-rest` (NOT merged).** Wired the F2a idempotency store into the boundary + completed the side-effecting path over the copied tools (authored 005 machinery, no trading behaviour): deadline (D3 pragmatic — pre-check + one re-check before execute); the idempotency wrap (fingerprint→beginOrResolve→conflict/in_progress/replay/started→complete; read-only tools bypass; complete-on-error + complete-failure handled; retention a VALUE); opened F1's read-only gate; the status endpoint `GET /internal/v1/invocations/:requestId` (reads-only, never executes) + authored `TradertonToolInvocationStatusV1`; the real `TradingToolContext` factory (`createTradingRuntime` + `createDriveTarget` + real `ioredis`/`botRepo`) with the authored **D2 subject→injection resolver** (bot-scoped ownership check + per-owner default venue account); **D4 Option B** actor-provenance authz (per-consumer `allowedActorTypes`) — resolves the F1-deferred 005 §Authz item-3 (docs/003 DEFERRED→RESOLVED). Dispatcher depends only on thin injected ports (no `@traderton/db` leak). Reviewed (no critical/high; M1 complete-failure-500 + L1 fixed; M2→B7, others→B8). Build green, lint clean, **2363 pass / 24 skipped** — F2b tests use **fakes**; the live DB path + end-to-end signed side-effecting flow are proven by logic+review and are **F2c's** gated-integration + 7-verification-test job. See [013 §8.7](../archive/features/013-9b-authoring-plan.md).
- **Item F2c — runnable stack + dev signing helper + the 7 required-verification tests: DONE (2026-09-08), on branch `f-m2-rest` (NOT merged). COMPLETES F + Phase 9b.** The F acceptance slice (005 §Required Verification): a copied-trimmed `config/default.yaml` (COPY-ADAPT from herobids, trading VALUES 1:1, only the four apiKey-gated `enabled` flips diverge — docs/003); a fresh minimal `docker-compose.yml` (boundary + Postgres + Redis, D5); a committed dev HMAC signer (`sign.ts`, reuses the verifier's canonical-string builder); the 7 tests 1:1 with 005 (test #4 = paper-mode `create_bot`, `enqueueLifecycle` stubbed → one bot row + one invocation on same-key retry) + a `test:integration` migrate-then-test runner (default `pnpm test` unchanged). Reviewed (no critical/high; M1 config-drift on hyperliquid `walletGeneration`/`economicCalendar` FIXED — restored to source 1:1; L2→backlog B9). **PROVEN END-TO-END** (coordinator-run): `pnpm test:integration` tests 1–6 green vs real PG+Redis; `docker compose up --build` fully healthy + `/health/ready` ready; full suite with `BOUNDARY_BASE_URL` → all 14 assertions incl. test #7 green; re-verified after the M1 fix. See [013 §8.8](../archive/features/013-9b-authoring-plan.md).
- **⇒ F (M2 REST boundary) is COMPLETE** — F1 (shell) + F2a (idempotency store) + F2b (dispatcher integration) + F2c (stack & verification). **This completes Phase 9b.** The whole `@traderton/*` library + the M2 REST boundary now exist and are green on `f-m2-rest`. **Nothing merged to `main`** — the merge gate (herobids consumes the library; all tests pass; run local + staging a while + manual/visual/black-box; manual approval) is human-owned and unmet. Next: the merge-gate work (herobids consuming `@traderton/*`) + L3/cutover per [024](./024-verification-and-consumption-roadmap.md).

**L3 (consumption / cutover) — IN PROGRESS.** Governed by [024](./024-verification-and-consumption-roadmap.md) + [CANONICAL-STATE §3.2](./CANONICAL-STATE.md). Each item on its own branch off `f-m2-rest`; nothing merges to `main` without the human. Landed so far:
- **L3-P1 — `provision_venue_account` boundary tool: DONE (2026-09-10), on branch `l3-p1-provision` (NOT merged).** Exposed venue-account + credential provisioning as ONE side-effecting 005 tool by **un-quarantining + adapting the already-copied provisioning half** (copy-never-author). **Un-quarantined** the provider credential-validation surface from herobids into `packages/worker/src/providers/{types,validator,registry}.ts` — the `validator.ts` (canonicalize/validate venue secrets) is **verbatim**; the `registry.ts` keeps the per-venue credential-field data 1:1 but **deletes the platform catalog projection** (public catalog/wallet-generation/ETag — Intentional Divergence, absent from `@traderton/domain`). Added `getEncryptionKey()` to the already-copied `crypto.ts` (the `CREDENTIAL_ENCRYPTION_KEY` env/config seam — never hard-coded). **Authored only the thin seam:** `packages/worker/src/tools/provisioning.ts` — an `AgentTool` (`provision_venue_account`, category `write-database`) with a Zod payload `{ venue, label, secrets, venueAccountRef? }` that, in ONE `db.transaction`, validates+canonicalizes secrets → `encryptCredential` → inserts `user_credentials` → inserts `venue_accounts` (linked) → returns `{ venueAccountId, venue, label }` (**metadata only; never the secrets**). The Jupiter `venueAccountRef` (Solana wallet) rule + secret validation are copied verbatim. **Adapts:** route→tool; JWT `request.userId`→boundary-resolved `ctx.ownerId` (written to both tables — the ONE data adapt); **DROPPED** the plan-limit (`checkCredentialLimit`/`pg_advisory_xact_lock(13,…)` — a consumer pre-boundary concern, mirrors maxBots #4). Registered in `packages/boundary/src/registry.ts` as a non-read-only tool → the F2 idempotency store persists+dedupes it (no second idempotency mechanism). Added `ownerId` + `db` to the boundary's `TradingToolContext` wiring (`bin.ts`). **Credential custody enforced (D2):** secrets arrive over HMAC+TLS, encrypted before insert, never logged, never returned. **Two forced drops flagged in [003](./003-anomalies-and-deviations.md):** the venue `probe()` enrichment (adapters' `probe` never copied into `@traderton/venues`) and the `credentialCreatedEvent` audit append (`userId`-shaped, never copied into `@traderton/engine`). Tests: adapted the copied credentials/accounts create-path parity assertions into `tools/provisioning.test.ts` (secret validation, canonicalization, 1inch legacy-apiKey discard, Jupiter rule, credential-linkage, encrypt-at-rest, no-secret-in-response) + boundary-level `packages/boundary/src/provision-venue-account.test.ts` (signed invoke → encrypted rows → `{venueAccountId}`; bad secret → `validation.invalid_payload`; registered side-effecting) + a `DATABASE_URL`-gated `tools/provisioning.integration.test.ts` (real rows, `encrypted_data` not plaintext) **PROVEN against throwaway Postgres:16**. Build + lint clean; **whole repo 2381 pass / 39 skipped / 0 failures.** Recorded in [005](./005-consumer-boundary-contract.md) (Boundary Tools). Not merged — merge gate unmet.

- **L3-P1c — `deprovision_venue_account` boundary tool: DONE (2026-09-11), on branch `l3-p1-provision` (NOT merged). Independently reviewed 2026-09-11 (see below).** The delete counterpart of `provision_venue_account`, same file (`packages/worker/src/tools/provisioning.ts`), authored as a thin route→tool seam over the copied/quarantined accounts DELETE handler (copy-never-author). Behaviour (copied, verified against CURRENT herobids practice): owner-scoped load → `not_found.resource` for absent/unowned; block on ANY `bots` row referencing the account (no status filter) → `provision.in_use`; ONE `db.transaction` deletes `venue_accounts` FIRST then its `user_credentials` (FK `venue_accounts.credentialId → user_credentials` is ON DELETE RESTRICT, so that order is required); FK-`23503` fallback (a bot linked between the pre-check and the delete) re-queries and returns the same `in_use`; metadata-only success `{ venueAccountId, deleted:true }`. **Legal split:** blocks only on Traderton-owned dependents (`bots`); platform-owned blockers (`connections`/`agent_connections`) stay in herobids and run BEFORE it calls this. Tests: `packages/worker/src/tools/deprovision.test.ts` (7 tests — registered write-database, cascade-order, no-credential case, not_found, any-bot block, FK-23503 race → in_use, missing-owner fail-closed). **Review finding (MEDIUM, logged not blocking):** the 7 tests are mock-based (delete-order inferred by call count); unlike the F-boundary work they do not exercise the real FK ordering against live Postgres. The real FK order + 23503 path get exercised end-to-end at L3-P1b. Proposal: `docs/features/L3-P1c-deprovision-venue-account-proposal.md`. Not merged — merge gate unmet.
- **Credential-store model (2026-09-11, human-settled) — trading credentials are NOT mirrored into herobids.** Each side stores only the credentials it uses (trading → Traderton, custodied+decrypted behind the boundary; Gmail/OAuth/social → herobids). No herobids reference-mirror of trading credentials; a unified view (if ever needed) is composed at read time, not stored. Full reasoning: [004-decision-log.md](./004-decision-log.md) "Why trading credentials are NOT mirrored into herobids". Consequence: herobids `credentials.ts` stays local; only the holistic trading path re-points at L3-P1b.
- **Cutover obligation (D2) — migrate pre-existing trading-credential + venue-account rows into Traderton. → NO-OP / RESOLVED (2026-09-12, human: "no real data, starting afresh").** GREENFIELD cutover: there are NO pre-existing rows to migrate (see CANONICAL-STATE §2.0 + 004 "No pre-existing production data"). Reduces to "confirm the old tables are empty, then drop." The obligation is satisfied by the absence of data. Original (now-moot) framing below for history. Belongs to the `provision_venue_account` / `venue_accounts` + `user_credentials` rows. L3-P1b makes herobids create NEW trading links directly in Traderton (via `provision_venue_account`), but trading credential + venue-account rows already present in herobids' own DB (from before cutover) must be migrated into Traderton's DB (or re-provisioned) at cutover — otherwise those owners' bots/decisions cannot resolve a venue account behind the boundary. Deferred only in *when*, not *whether*; blocks cutover until resolved. Not an L3-P1b concern (new links land correctly); a cutover data-migration step.
- **c4.7 — admin `bots` count tiles: INTENTIONAL DIVERGENCE (2026-09-12, decision-agent settled within the rules; herobids consumer edit, not merged).** The herobids admin surface had two local `bots` reads: (A) `/admin/stats` platform-wide `count(bots)` total; (B) `/admin/users` per-user `botCount` correlated subquery (admin reading every listed user's — i.e. OTHER owners' — count). BOTH are cross-tenant reads the owner-scoped boundary subject model (`{ownerId,actor}`, no cross-owner hole by design — L3-Q2-P) STRUCTURALLY CANNOT express, and authoring a cross-tenant/platform count tool is REJECTED (mirrors the c4.2-analytics ruling: platform aggregation is not authored into the trading authority). Both are DISPLAY-ONLY admin observability tiles (nothing gates on them), greenfield, and NOT inventoried trading capabilities (006 lists trading tools, not admin dashboard tiles). Disposition: REMOVED both from herobids `apps/api/src/routes/admin.ts` (no Traderton tool authored); `agentCount` (platform `agents` table) retained. The seam: admin bot observability is deliberately NOT reproduced over the boundary; if platform bot observability is ever wanted it is a Traderton-native admin/metrics capability, not a herobids cross-tenant read. Not a silent drop — recorded here.

**Next action:** Phase 9 (`apps/api` — trading control-plane + 25 tools + the Phase-8 deferred authoring), per the roadmap [009-extraction-roadmap.md](../archive/009-extraction-roadmap.md). LARGE subtraction + the sanctioned **authoring** pass (M1 composition first, M2 REST adapter sequenced) — done after a holistic review. Its scope spans three surfaces (api trading routes; the 25 tool modules that live i LARGE subtraction + the sanctioned **authoring** pass (M1 composition first, M2 REST adapter sequenced) — done after a holistic review. Its scope spans three surfaces (api trading routes; the 25 tool modules that live in `apps/worker/src/tools/`; the Phase-8 `Deferred (required for cutover)` items: config shape, composition root, intake/approval surface, per-`ownerId` maxBots). Seed plan at [docs/features/009-api-plan.md](../archive/features/009-api-plan.md). Phases 9–10 governed by 009; honor the stop-gates.

**Phase 1 evidence:**

- Workspace shell scaffolded (pnpm workspace, strict TS ES2022 ESM, vitest) mirroring herobids toolchain (Node ≥22, pnpm 10.33.2). `git init` done for delete-visibility.
- `@herobids/domain` copied verbatim (97 files) and renamed to `@traderton/domain`. Trading `config/strategy-presets/*.yaml` copied. **Verbatim-copy baseline was green: 981/981 tests, build + lint clean** (the parity harness).
- Leaf-first platform deletions completed cleanly (build green after each): removed `agent-evaluation`, `agent-goal`, `assessment-billing`, `plan-entitlements`, `platform`, `provider-catalog`, `runtime-composition`, `skills*`, `skill-resolution`, `tools`, `tool-schemas`, `llm-selection`, `external-skill-provider-http`, `text-search`, `review-pre-check`, `browser-pool-feature.test`, dirs `email/ infra/ skills/ __tests__/`, platform ports (`assessment-identity-resolver`, `assessment-request`, `preset-transition`, `blueprint-execution-capability`, `browser-pool`, `document-store`, `document-text-extractor`, `runtime-document-materializer`, `runtime`, `external-skill-provider`), `models/llm-models`. Barrels (`index.ts`, `ports/index.ts`, `models/index.ts`) trimmed accordingly.
- Config seam RESOLVED: `config/schema.ts` reduced to trading-only (2568→844 lines, 77 exports) by clean leaf-first in-place deletions — no authored restructuring. Removed the `WakePreferences`/`agent-protocol` seam, then (after `blueprint.ts` deletion freed the agent-policy schemas and herobids source-request #1 freed the LLM schemas) all platform schemas: AppConfig, agent-runtime-policy island, LLM block, billing/plans, auth, alerts/telegram/gmail, nomad/sharedServices, worker/services/browser/http/sessionCircuit/agentRuntime(+Policy), marketIntelligence, platformAssessment*, evaluation, Intelligence/UnifiedAgent/preset/capability/hybrid schemas, WakeGate, validateReviewInterval, and agent `PermissionLevel`/`AgentStyle`. Details in [003](./003-anomalies-and-deviations.md).
- Deleted `blueprint.ts` + `blueprint.test.ts` (platform marketplace/authoring — Intentional Divergence, confirmed not on the trading path).
- Strategy-registry seam RESOLVED via herobids source-request #1 (commit `648f9110`, released). Traderton copies a mechanical-first registry and omits the `registerAgentDecisionModes({llm,hybrid})` call → mechanical-only (`mechanical`+`dca`); `momentum:llm`/`momentum:hybrid` unsupported (Intentional Divergence). See [003](./003-anomalies-and-deviations.md).
- **No open herobids requests.** (#2 was withdrawn — `blueprint.ts` is platform marketplace, not the trading path; bots use `BotConfigSchema`, execution path is blueprint-free.)
- **Domain slice green: build + lint clean, 230 copied tests pass.** Surviving trading files match the Phase 0 COPY list (trading/, values/, named ports, result/enums/pagination/scanner-types/cost-profile, agent-risk-contract, market-assessment, models/decision, config trading schemas + strategy-parameters + presets).

### Cross-cutting

| Capability (from source) | Area | Status | Notes |
|--------------------------|------|--------|-------|
| Traderton-native usage metering / payments / caps | cross-cutting | Deferred (optional) | Platform billing authority stays outside Traderton by design. Service-owned metering, billing, and caps are cut for initial extraction and can return later. No herobids parity obligation (platform keeps its own billing). |
| Bot reproduction / cloning (Traderton-native) | cross-cutting | Deferred (optional) | **New Traderton-native capability, not a source parity item.** Reproduce/clone a bot from its stored `BotConfigSchema` recipe (strip instance-only fields `venueAccountId`/`connectionId`/`status`; create a new bot bound to a venue account). Built on `BotConfigSchema`; does NOT require the platform blueprint marketplace machinery. Intended from day one; to be designed/built in a later phase, not authored during Phase 1. See [004](./004-decision-log.md). |

### Trading tools (25 — authority:
[006-source-capability-manifest.md](./006-source-capability-manifest.md))

| Tool | Status | Notes |
|------|--------|-------|
| `submit_decision` | **Met** (intake/execution item C + tool/drive item D, 2026-09-07) | Decision execution — highest-stakes parity surface. Engine execution core (`submitDecisionForExecution`, planner, risk gate, executors) landed Phase 3 (Met). Intake/resolution surface: Met (item C) — `submitDecision` router + the one `actorRegistry` + venue-account-direct seam over the Phase-8-copied actor intake (running-actor only; grant-fallback dropped — Intentional Divergence row below; approvals consumer-owned). **Item D (2026-09-07):** `tools/trading.ts` copied verbatim + the in-process `publishToInbound` drive target routes `DECISION_SUBMIT`→`submitDecision` and writes the `agent:decision:reply:*` reply the tool's `blpop` awaits. Event emits are **item C2** (M1 no-op). |
| `create_bot` | **Met (tool + drive + limit, 2026-09-07)** | `tools/bots.ts` copied verbatim; the item-D `MANAGE_BOT:create_and_start` handler validates config (`BotConfigSchema`) + mode-escalation + the swap-symbol guard, then (**item E, 2026-09-07**) `tryCreateBotWithLimit` (insert `stopped`) → `tryMarkBotRunningWithLimit` (claim `running`) → `enqueueLifecycle('start')`. **Limit-enforced creation → Met:** atomic per-`ownerId` count+insert under a `pg_advisory_xact_lock` (`BotRepository`, re-keyed from the deleted agents-row-lock; limit key per-`ownerId`, decided 2026-09-06; value from `agentRiskDefaults.maxBots` + injected override). The per-agent→per-`ownerId` reshape is an Intentional Divergence (row below). `Deferred (required for cutover)` → **RESOLVED.** See [013 §7](../archive/features/013-9b-authoring-plan.md). |
| `start_bot` | **Met (tool + drive + limit, 2026-09-07)** | `tools/bots.ts` copied verbatim; the item-D `MANAGE_BOT:start` handler validates ownership (by injected `ownerId`) + persisted config, then enqueues a `WorkerRuntime` start job. Reclaim start re-marks running; **non-reclaim start** claims a slot via `tryMarkBotRunningWithLimit` (**item E, 2026-09-07** — atomic per-`ownerId` count+mark under the advisory lock; `tryMarkBotRunningWithLimit`, re-keyed from the deleted agents-row-lock). `Deferred (required for cutover)` → **RESOLVED.** Same item-E primitive as `create_bot`. |
| `stop_bot` | **Met (tool + drive, 2026-09-07)** | `tools/bots.ts` copied verbatim; the item-D `MANAGE_BOT:stop` handler validates ownership then enqueues a `WorkerRuntime` stop job. Fully live. |
| `list_bots` | **Met (tool + drive, 2026-09-07)** | `tools/bots.ts` copied verbatim (reads `botRepo.getBotsByCreator('agent', ctx.agentId)` — decision (a) scope). Fully live. |
| `resolve_bot` | Met (module copied, 9a) | **9a: `tools/resolvers.ts` copied verbatim** (byte-identical modulo namespace), narrowed to `TradingToolContext`; tests green. Boundary/composition wiring is 9b. (Lives in `resolvers.ts`, not `bots.ts`.) |
| `get_bot_status` | **Met (tool + drive, 2026-09-07)** | `tools/bots.ts` copied verbatim. Fully live. |
| `adjust_bot_config` | **Met (tool + drive, 2026-09-07)** | `tools/bots.ts` copied verbatim; the item-D `MANAGE_BOT:adjust_config` handler deep-merges + validates + restarts a running bot via `WorkerRuntime`. Fully live. |
| `adjust_risk_limits` | Met (module copied, 9a) | **9a: `tools/risk-limits.ts` copied verbatim**, narrowed to `TradingToolContext`; tests green. Risk policy parity preserved by the verbatim copy. Wiring 9b. |
| `get_risk_limits` | Met (module copied, 9a) | **9a: `tools/risk-limits.ts`** copied verbatim; tests green. Wiring 9b. |
| `get_account_summary` | Met (module copied, 9a) | **9a: `tools/account.ts` copied verbatim** (narrowed to `TradingToolContext` via source-fix #3b's `executionConfig` port); tests green. Wiring 9b. |
| `list_positions` | Met (module copied, 9a) | **9a: `tools/analytics.ts`** copied verbatim; tests green. Wiring 9b. |
| `get_price` | Met (module copied, 9a) | **9a: `tools/price.ts`** copied verbatim; tests green. Wiring 9b. |
| `get_funding_rates` | Met (module copied, 9a) | **9a: `tools/market-data.ts` + `intelligence-tools.ts`** copied verbatim; tests green. Wiring 9b. |
| `get_market_overview` | Met (module copied, 9a) | **9a: `tools/market-data.ts` + `intelligence-tools.ts`** copied verbatim; tests green. Wiring 9b. |
| `get_analytics` | Met (module copied, 9a) | **9a: `tools/analytics.ts`** copied verbatim; tests green. Wiring 9b. |
| `check_regime` | Met (module copied, 9a) | **9a: `tools/market-data.ts`** copied verbatim; tests green. Wiring 9b. |
| `discover_tokens` | Met (module copied, 9a) | **9a: `tools/market-data.ts` + `intelligence-tools.ts`** copied verbatim; tests green. Wiring 9b. |
| `search_tokens` | Met (module copied, 9a) | **9a: `tools/market-data.ts`** copied verbatim; tests green. Wiring 9b. |
| `find_instrument` | Met (module copied, 9a) | **9a: `tools/find-instrument.ts`** copied verbatim; tests green. Wiring 9b. |
| `watch_token` | Met (module copied, 9a) | **9a: `tools/watch.ts`** copied verbatim (+ `watch-summary.ts` seam relocation); tests green. Wiring 9b. |
| `check_watches` | Met (module copied, 9a) | **9a: `tools/watch.ts`** copied verbatim; tests green. Wiring 9b. |
| `list_watches` | Met (module copied, 9a) | **9a: `tools/watch.ts`** copied verbatim; tests green. Wiring 9b. |
| `remove_watch` | Met (module copied, 9a) | **9a: `tools/watch.ts`** copied verbatim; tests green. Wiring 9b. |
| `resolve_watch` | Met (module copied, 9a) | **9a: `tools/resolvers.ts`** copied verbatim; tests green. Wiring 9b. |

### Subsystems (authority:
[006-source-capability-manifest.md](./006-source-capability-manifest.md))

| Capability | Status | Notes |
|------------|--------|-------|
| Domain slice (`@traderton/domain`: trading config schemas, values, ports, models/decision, result/enums/pagination, scanner-types, cost-profile, agent-risk-contract, market-assessment, strategy-parameters, presets) | Met | Phase 1 landed. Copied from herobids + platform slices deleted; strict-TS compile + lint clean; 230 copied parity tests pass. This is the domain layer only — the engine/venues/market-data/db/runtime that *consume* these types remain future phases (rows below stay Pending). |
| Risk gate (all rules, hard invariants, user vs operator defaults) | Met | **Phase 3 landed.** `packages/engine/src/risk-gate.ts` copied byte-identical; 83 parity tests pass unmodified (see the risk-gate exact-rules table below). |
| Venue adapters (Hyperliquid, Bybit, Jupiter, 1inch) | Met (unit; integration credential-gated) | **Phase 5 landed** (`@traderton/venues`). 40 files copied verbatim (diff = namespace rename only; verified in review), then the browser-pool seam (`browserless-adapter.ts` + test + 2 barrel exports) cut as Intentional Divergence. Compiles strict against domain + market-data; **177 unit tests green; 6 integration tests credential-gated (skip without venue creds)** — like Phase 2 db, live venue validation is a CI/Phase-10 concern. See per-adapter table below + [Phase 5 plan](../archive/features/005-venues-plan.md). |
| Trading loop (scan→decision→plan→risk→execute→fill→reconcile) | Met (modules; composition Deferred-required) | **Phase 3** landed the engine's `runTradingCycle` orchestration + decision intake, planner, executors, reconcile. **Phase 4/6** landed the scan front-end (market-data indicators/regime + strategy scan-engine). **Phase 8** landed the worker-level loop **modules** (`@traderton/worker`): trading actors (`trading-actor`, `agent-trading-actor`), `WorkerRuntime` (bullmq instance lifecycle + leases), scanners, `technical-phase`, `complete-technical-scan`, tick gates, reconciliation-orphaned-cleanup, venue-adapter-factory, actor-health — copied verbatim, **681 worker tests green**. The *trading composition root* that wires these together (herobids `index.ts`, which has no faithful subset) is **`Deferred (required for cutover)`**, authored at M1-integration/Phase 9. So the loop's parts are Met; its assembled runtime is the deferred authoring. |
| Position / equity trackers | Met | **Phase 3 landed** (`position-tracker.ts`, `swap-position-tracker.ts`, `equity-tracker.ts`, `daily-loss-tracker.ts`, `rehydrate-daily-loss.ts`) — copied verbatim, tests green. |
| Price-watch lifecycle | Met | **Watch tools + evaluation logic + types landed.** The 5 watch tools (`watch_token`, `check_watches`, `list_watches`, `remove_watch`, `resolve_watch`) copied verbatim in 9a (`tools/watch.ts` + `tools/resolvers.ts` + the `watch-summary.ts` seam); the threshold-evaluation logic (`isThresholdMet`, trigger detection) lives inside the copied `check_watches` tool; `watch-types.ts` + `position-coverage.ts` landed in Phase 8. Tests green. **Intentional Divergence:** the agent-wake *push* loop `apps/worker/src/market-intelligence/monitor.ts` (emits `agent.wake`; depends on `InstanceEventPublisher`/`AgentWakePayload`) is platform agent-reasoning (decisions 7–9) — cut with the Phase-8 `market-intelligence` deletion, not copied. (Status corrected from stale `Pending` during the M1 holistic review, 2026-09-07 — see [011-m1-holistic-review-report.md](../archive/features/011-m1-holistic-review-report.md) §4 MEDIUM-2.) |
| Market data / discovery | Met | **Phase 4 landed** (`@traderton/market-data`). 44 files copied verbatim (only diff: `@herobids/domain`→`@traderton/domain` namespace rename in 3 files; other 41 byte-identical — verified by diff in review). Candle fetchers (binance/geckoterminal/candle-registry), provider clients (birdeye/coinmarketcap/dexscreener/hyperliquid-info/bybit-info/bybit-tickers/scrapfly), price-service, discovery (discovery/discovery-seen-tracker/token-search/token-safety), analysis (indicators/regime/economic-calendar), infra (cache/redis-cache/provider-registry/rate-limiter/http/types). Compiles strict against `@traderton/domain`; **354 copied tests green.** Forbidden-import sweep clean (no `@herobids/*`, no llm-package/platform/db/venues/engine imports). Domain-only (+`node-html-parser`). **No LLM-package dependency:** the one LLM-shaped symbol (`createLlmCalendarParser` in `economic-calendar.ts`) is a verbatim, self-contained OpenAI-compatible `fetch` client taking injected config — it imports no `@herobids/llm` and carries no LLM cost center (satisfies decision 9); it is an optional injectable fallback to the DOM parser. See [Phase 4 plan](../archive/features/004-market-data-plan.md). |
| Backtesting / replay | Met | **Phase 7 landed** (`@traderton/backtesting`). Whole package copied verbatim (13 files incl. `importers/`; diff = `@herobids/*`→`@traderton/*` rename only, file sets identical — verified in review). Depends on domain + engine. Replay runner, historical data feed, context replay, market-data recorder, validation runner, backtest report, simulated clock, CSV importer. Compiles strict; **49 copied tests green.** Forbidden-import sweep clean (only domain + engine). The `backtest_runs`/`replay_corpora` data-model rows landed in Phase 2 (db); this is the runtime backtesting/replay engine. |
| Trading data model (tables listed in Phase 0) | Met (schema + repositories) | **Phase 2 landed** (`@traderton/db`). 22 trading tables (trading-core verbatim, all soft-linked); 7 identity FKs → soft `ownerId`, `bots.connectionId` dropped (decisions 10–13 + soft-reference rule, 004); 3 intra-trading FKs preserved. **(Corrected 2026-09-07:** Phase 2 originally copied 23 tables including `decision_approvals`; that table + its repository were removed and the initial migration regenerated when the human-approval lifecycle was reclassified consumer-owned during 9b planning — see the `decision_approvals` Intentional Divergence row + [013 plan](../archive/features/013-9b-authoring-plan.md). Net: 22 tables.) Trading repositories copied (journal-pg, repositories.ts Fill/Position/ExecutionPlan/Order/BalanceSnapshot/Decision/Bot, reconciliation, backtesting, instrument, token-safety-override, decision-approval, decision-failure, llm-artifact). Platform schema/repos deleted. Fresh initial migration `0000_init_trading_schema.sql` generated (herobids migration history not copied — decision 1). Build + lint + copied unit tests green (11 pass). **Note:** 9 db integration tests (`journal-pg`, `position-repository`) are gated on `DATABASE_URL` (skip without a live Postgres) — they must run against Postgres in CI to validate the `ownerId` renames end-to-end (Phase 10 / CI concern). Row is Met for schema+repository extraction; runtime DB validation pending CI. |
| Mechanical strategies (`Dca`, `Mechanical`, `scan-engine`, `regime`) | Met | Move to Traderton (no LLM). Domain-config foundation landed in Phase 1 (`MechanicalParamsSchema`, indicator/technical schemas, mechanical-only strategy registry). **Phase 4 landed the mechanical market-analysis inputs** in `@traderton/market-data`: `regime.ts` (regime detection) + `indicators.ts` (technical indicators), copied verbatim, tests green — the mechanical intelligence (indicators only, no LLM) per decisions 8–9. **Phase 6 landed `@traderton/strategy` (mechanical slice)**: `mechanical-strategy.ts`, `dca-strategy.ts`, `scan-engine.ts` (+ tests) + `index.ts` copied verbatim (diff = `@herobids/*`→`@traderton/*` rename only; verified by diff in review). Depends on domain + market-data; **NO `@herobids/llm`/`@traderton/llm` dep** (decision 9). The llm/hybrid slice (`llm.ts`, `llm-provider.ts`, `hybrid-strategy.ts` + tests) was never copied (Intentional Divergence — see the `LlmStrategy`/`HybridStrategy` divergence row). `index.ts` barrel-trimmed by exactly the 3 `./llm` + 1 `./hybrid-strategy` export lines. `HybridPricingIdentity` (domain pricing-identity, not `HybridStrategy`) kept and consumed by `scan-engine`. Compiles strict, lint clean, forbidden-import sweep clean. **56 copied tests green** (dca 14, mechanical 18, scan-engine 24). See [Phase 6 plan](../archive/features/006-strategy-plan.md). |

### Risk gate — exact rules (highest-stakes parity surface)

Source: `packages/engine/src/risk-gate.ts`, `checkRisk()`. Pure function.
Risk-reducing plans (`close`/`reduce`) bypass entry-side checks. Each rule must
reproduce its exact error code.

| # | Rule | Error code | Status |
|---|------|-----------|--------|
| 1 | Max drawdown (absolute USD) | `risk.max_drawdown_exceeded` | Met |
| 1a | Max drawdown % (peak→current equity) | `risk.max_drawdown_pct_exceeded` | Met |
| 1b | Daily max loss % (rolling 24h) | `risk.daily_max_loss_exceeded` | Met |
| 1c | Stop-loss cooldown | `risk.stop_loss_cooldown` | Met |
| 2 | Max open positions (on open) | `risk.max_open_positions_exceeded` | Met |
| 3 | Max position size (resulting) | `risk.max_position_size_exceeded` | Met |
| 3b | Max position size % of equity | `risk.max_position_size_pct_exceeded` | Met |
| 4 | Max order notional | `risk.max_order_notional_exceeded` | Met |
| — | Missing mark for notional | `risk.no_mark_for_notional` | Met |

**Phase 3 evidence (risk gate):** `packages/engine/src/risk-gate.ts` `checkRisk()` copied
byte-identical from herobids (modulo the `@herobids/*`→`@traderton/*` namespace rename; verified
by diff in review). The copied parity tests pass **unmodified**: `risk-gate.test.ts` (29) +
`risk-gate.parity.test.ts` (54) = 83 tests green. Risk-reducing (`close`/`reduce`) bypass of
entry-side checks and every exact error code preserved verbatim.

Note: `dailyMaxLossPct`/`maxDrawdownPct` are the agent-facing %-based controls;
`maxDrawdown` (absolute USD) is preserved for non-agent flows. Notional checks
use the worst-case of `referenceMark` vs `order.price`.

### Venue adapters — capabilities

Source: `packages/venues`. Each carries order ops + streams + confirmation.

| Adapter | Kind | Status | Notes |
|---------|------|--------|-------|
| Hyperliquid | perp/orderbook | Met | **Phase 5.** `hyperliquid.ts` + public/private streams (`hyperliquid-public-stream.ts`, `hyperliquid-private-stream.ts`) + `hyperliquid-mark-source.ts` copied verbatim; unit tests green; `hyperliquid.integration.test.ts` credential-gated (skips). |
| Bybit | perp/orderbook | Met | **Phase 5.** `bybit.ts` + public/private streams (`bybit-public-stream.ts`, `bybit-private-stream.ts`) copied verbatim; unit tests green; `bybit.integration.test.ts` credential-gated (skips). ccxt pinned to source-resolved `4.5.54` (dependency reproduction; see [003](./003-anomalies-and-deviations.md)). (Bybit market-data helpers `bybit-info.ts`/`bybit-tickers.ts` landed in `@traderton/market-data`, Phase 4.) |
| Jupiter | swap (Solana) | Met | **Phase 5.** `jupiter-swap.ts` + `jupiter-confirmation.ts` + `solana-signer.ts` copied verbatim; unit tests green. |
| 1inch | swap (EVM) | Met | **Phase 5.** `oneinch-swap.ts` + `evm-confirmation.ts` + `evm-signer.ts` copied verbatim; unit tests green; `oneinch.integration.test.ts` credential-gated (skips). |
| PublicStreamPool | shared streaming | Met | **Phase 5.** `stream-pool.ts` copied verbatim; tests green. worker-scoped shared WS connections. |
| Mark sources | Oracle, Hyperliquid | Met | **Phase 5.** `oracle-mark-source.ts`, `hyperliquid-mark-source.ts` copied verbatim; tests green. |
| Rate limiter | token bucket | Met | **Phase 5.** `rate-limiter.ts` copied verbatim; tests green. per-venue. |
| Wallet generation | EVM/Solana | Met | **Phase 5.** `wallet-generation.ts` copied verbatim; tests green. |
| Candle fetcher | Gecko | Met | **Phase 5.** `candle-fetcher.ts` copied verbatim. |

### Engine subsystems (packages/engine)

| Subsystem | Status | Notes |
|-----------|--------|-------|
| Order manager + order-state machine | Met | transitions, fills. Copied verbatim (`order-manager.ts`, `order-state.ts`, `order-lifecycle-manager.ts`, `order-update-decision.ts`); copied tests green. |
| Planner (`planDecision`) | Met | decision → execution plan. `planner.ts` copied verbatim; tests green. |
| Executors: Paper / Shadow / Live / SwapLive | Met | incl. live timeout mgr + recovery. `paper/shadow/live/swap-live-executor.ts`, `live-timeout-manager.ts`, `live-recovery.ts` copied verbatim; tests green. |
| Position tracker + swap position tracker | Met | `position-tracker.ts`, `swap-position-tracker.ts` copied verbatim; tests green. |
| Fill accounting | Met | `fill-accounting.ts` copied verbatim; test green. |
| Equity tracker + daily-loss tracker + rehydrate | Met | feeds risk gate. `equity-tracker.ts`, `daily-loss-tracker.ts`, `rehydrate-daily-loss.ts` copied verbatim; tests green. |
| Stop-loss monitor + per-trade-level validator | Met | `stop-loss-monitor.ts`, `per-trade-level-validator.ts` copied verbatim; tests green. |
| Circuit breaker (per venue) | Met | `circuit-breaker.ts` copied verbatim; tests green. |
| Fee simulator + paper slippage | Met | `fee-simulator.ts` copied verbatim; test green. |
| Journal (event types) | Met | decision/plan/order/fill/risk/live/credential events. `journal.ts`, `journal-memory.ts` copied verbatim; `journal-live.test.ts` green. |
| Trading cycle (`runTradingCycle`) | Met | the orchestration loop. `trading-cycle.ts` copied verbatim; tests green. |
| Decision intake (`submitDecisionForExecution`) | Met | + context-hash guard. `decision-intake.ts`, `decision-context-hash.ts` copied verbatim; tests green. |
| Instrument executor (`executeDecision`) | Met | `instrument-executor.ts` copied verbatim; test green. |
| Reconciliation (orderbook + swap loaders) | Met | drift detection + thresholds. `reconciliation/` (reconcile, reconciler, venue-state-loaders, drift-category) copied verbatim; tests green. |
| Wake gate | Intentional divergence | The engine's `wake-gate.ts` (`evaluateWakeGate`) is the **platform agent preset-review wake**, not the trading fill/mark-driven wake — needs the dropped `WakeGateConfig` (Phase 1 platform), operates on agent preset/style-tier concerns, and was orphaned at the herobids barrel (no consumer). Cut by deletion. See Intentional divergence table + [Phase 3 plan](../archive/features/003-engine-plan.md). |
| Mark source / mark selector | Met | fill-first mark source. `mark-source.ts` (`LastFillMarkSource`, `MarkSelector`, `createFillFirstMarkSource`), `market-data-feed.ts`, `stream-market-data-feed.ts` copied verbatim; tests green. This is the **trading** mark source, distinct from the platform wake gate above. |

### Intentional divergence

Source behaviour deliberately NOT copied because it was platform coupling or a
resolved design decision — not a trading capability. Recorded so parity review
sees it explicitly; none is a silent drop.

| Source behaviour | Divergence | Rationale |
|------------------|-----------|-----------|
| Trading coupled to platform `users` + platform billing tables | Not owned by Traderton | Traderton is multi-tenant but not the identity/platform-billing authority; accepts authenticated `ownerId` + `actor` at the boundary (decision 10). |
| `connections` / `agent_connections` grant layer | Stays platform | Grant/entitlement is platform-owned; Traderton binds bots directly to `venueAccountId` (decisions 11, 13). |
| herobids per-agent maxBots enforcement (`BotRepository.tryCreateBotWithLimit` / `tryMarkBotRunningWithLimit`, row-locking the `agents` table) | Platform implementation not copied (deleted Phase 2) | The per-agent limit keyed on `agents` + agent-row-lock is platform concurrency policy; only the platform agent-broker/worker call it. Deleted from `@traderton/db`. The *capability* (limit-enforced bot creation/start) is trading and tagged **`Deferred (required for cutover)`** on the `create_bot`/`start_bot` rows — Traderton must provide it before cutover (see those tool rows + [004](./004-decision-log.md)). This is the "capability trading, implementation platform-coupled" case from the herobids-becomes-a-consumer model. **RESOLVED (2026-09-07, item E):** the capability is re-implemented **per-`ownerId`** on `@traderton/db` `BotRepository` (`tryCreateBotWithLimit`/`tryMarkBotRunningWithLimit`) — bodies mirror the herobids methods, but the atomicity re-keys the deleted `agents`-row `FOR UPDATE` to a **per-`ownerId` `pg_advisory_xact_lock`** (copied from herobids' own API-path form). The **per-agent → per-`ownerId` reshape** is the sanctioned Intentional Divergence (Traderton has no `agents` table; `ownerId` is the tenancy key, decision 10 + 2026-09-06); the limit *value* is the operator default `agentRiskDefaults.maxBots` + an optional consumer-injected per-owner override. `create_bot`/`start_bot` limit → Met (rows above). See [013 §7](../archive/features/013-9b-authoring-plan.md) + [004](./004-decision-log.md). |
| `bots.userId`/`venue_accounts.userId`/`user_credentials.userId`/`backtest_runs.userId`/`replay_corpora.userId`/`datasets.userId` hard FKs to `users`; `bots.connectionId` FK to `connections` | Converted to soft `ownerId` / dropped (Phase 2) | Soft-reference rule ([004](./004-decision-log.md)): Traderton doesn't own user identity (decision 10); every copied table's `users` FK → soft `ownerId`; `bots.connectionId` dropped, bots bind via `venueAccountId` (decision 13). Sanctioned authored seam, not a gap. |
| Bots could run `LlmStrategy` / `HybridStrategy` | Traderton bots are **mechanical-only** (`mechanical`, `dca`) | Intelligence is the agent's job. LLM/Hybrid decision-making relocates to the agent, which submits decisions via the boundary (decisions 7–9). Config-validation form: the strategy registry that moves to Traderton registers only `mechanical`+`dca` (the `llm`/`hybrid` modes + `LlmParams`/`HybridParams` stay agent-side — herobids source-request #1 in [003](./003-anomalies-and-deviations.md)). **Config-boundary status (corrected 2026-09-07, M1 review S-1):** the copied `StrategySchema.decisionMode` is *not yet narrowed* — it remains a **verbatim copy** of herobids' `z.enum(['mechanical','llm','hybrid'])` (its acceptance test is copied too), because narrowing the enum is a consequential authored behavioural change the decision log reserves for a signed-off Intentional Divergence, deliberately not done during the copy phase. **Enforcement today is at the registry/runtime layer** (the registry never calls `registerAgentDecisionModes`; `validateStrategyParams` reports `momentum:llm`/`momentum:hybrid` unsupported; `@traderton/strategy` exports only `Mechanical`/`Dca`). The config-enum narrowing was a **9b authoring item — DONE 2026-09-07 (item A′), option (a) narrow-and-diverge**: authored `MechanicalStrategySchema` (Traderton-owned wrapper, `decisionMode: z.enum(['mechanical']).optional()` + the same dca-or-required refine) and re-pointed `BotConfigSchema.strategy` at it — the copied `StrategySchema` is left **byte-verbatim** (its copied acceptance test for `llm` stays true; the narrowing lives on the Traderton wrapper, not the copy). A dedicated authored test `config/mechanical-only.test.ts` (9 assertions) pins the guarantee: `BotConfigSchema` + `MechanicalStrategySchema` reject `momentum:llm`/`momentum:hybrid`, accept `mechanical`/`dca`. Follow-up (item D): the `create_bot.config.strategy` **advertised** JSON tool-schema still reflects the broad `StrategySchema` — narrow the advertised schema when the tool catalog is authored. See [013 item A′](../archive/features/013-9b-authoring-plan.md) + [004](./004-decision-log.md). Same decision, seen from config. **Phase 6 realizes this at the implementation level:** `@traderton/strategy` was extracted as a *split* — only the mechanical files (`mechanical-strategy`, `dca-strategy`, `scan-engine`) were copied; `llm.ts`, `llm-provider.ts`, and `hybrid-strategy.ts` (+ their tests) never entered the Traderton tree, and the `@herobids/llm` dependency was dropped entirely (no `@traderton/llm`, no LLM cost center per decision 9). The barrel drops `LlmStrategy`/`clearLlmResponseCache`/`LlmStrategyConfig`/`HybridStrategy`. |
| `blueprint.ts` (whole file — marketplace/authoring: agent+bot revision payloads, publish/fork/browse, revisions, popularity) | Stays platform; **`blueprint.ts` not copied into Traderton** | Confirmed 2026-09-05: blueprint.ts is the marketplace/authoring layer, not the trading path — bots are created/validated/executed via `BotConfigSchema`, and the bot execution path is blueprint-free (see [003](./003-anomalies-and-deviations.md), [004](./004-decision-log.md)). The trading config Traderton owns (`RiskPosture`, `BotRisk`, `ExecutionDefaults`, `TokenSafety`, `BotConfigSchema`) lives in `config/schema.ts`, not blueprint.ts, so decision 14's "risk/execution/token-safety schema slice" is satisfied without copying blueprint.ts. 1:1 parity preserved by deleting the platform file, not repurposing it. |
| market-assessment platform orchestration + platform billing | Left behind (Intentional divergence + Deferred) | Only the domain/analysis is trading-owned; platform-side billing stays outside Traderton, while Traderton-owned usage metering remains Deferred (decision 15). |
| Traderton-native usage metering / payments / caps | Deferred (see Cross-cutting) | Cut for initial extraction. |
| Venues `browserless-adapter.ts` / `BrowserlessAdapter` (platform browser-pool client) | `browserless-adapter.ts` not copied into Traderton (deleted Phase 5) | A headless-browser session-pool client (acquires CDP browser sessions from a Browserless service via `fetch /json/new`) — a platform web-scraping/browser-automation concern, **not** a trading venue adapter. It implements `BrowserPoolPort` (with `BrowserSession`/`BrowserPoolError`), types Phase 1 classified platform and dropped from the domain slice. Consumer check across all of herobids (read-only): imported only by `apps/worker/src/agent.ts` (platform agent runtime) + re-exported by the venues barrel — no trading consumer. Same pattern as the engine wake gate: platform coupling needing a Phase-1-dropped domain port, orphaned of trading consumers → cut by deletion (+ 2 barrel exports). Not a herobids-on-Traderton dependency, so not Deferred-required. |
| Engine `wake-gate.ts` / `evaluateWakeGate` (platform agent preset-review wake) | `wake-gate.ts` not copied into Traderton (deleted Phase 3) | The engine's wake gate decides **agent preset-review wakes** — it is keyed entirely on agent-reasoning concerns (`agentId`, `agentStyleTier`, `agentCurrentPreset`, preset rankings, per-agent daily wake limits) and imports `WakeGateConfig`, a type Phase 1 already classified platform and dropped from the domain slice. Consumer check across all of herobids (read-only): `evaluateWakeGate`/`WakeGateInput`/`WakeGateResult` are referenced only as re-exports in `packages/engine/src/index.ts` — no trading (or any) consumer imports them. This is the agent preset-review reasoning relocated agent-side by decisions 7–9, not a trading capability. Cut by deletion (+ its 2 barrel exports); the **trading** fill-first mark source (`mark-source.ts`) is separate and IS copied (Met). Not a herobids-on-Traderton dependency, so not Deferred-required. |
| Tools `assess_strategy_preset` / `change_strategy_preset` (`apps/worker/src/tools/assess-strategy-preset.ts` / `change-strategy-preset.ts`) | Platform preset-review tools not copied into Traderton (DELETE-side, 9a) | These two tool modules are **not** in the 006 25-tool inventory. They are the agent **preset-review** tools: they depend on platform `tool-errors.ts` (`CapabilityDenial`), the Phase-1-dropped `PresetTransitionPort`, and the market-assessment/preset-transition machinery — the same agent-reasoning concern as the wake gate (decisions 7–9). Verified during the M1 holistic review (2026-09-07): correctly classified platform and dropped. Recorded explicitly here because their strategy-preset names could otherwise be mistaken for a trading capability. Not a herobids-on-Traderton dependency; not Deferred-required. |
| `decision_approvals` table + `DecisionApprovalRepository` (user-approval lifecycle for `approval_required` trade proposals) | Removed from `@traderton/db` (2026-09-07); user-approval lifecycle is **platform/consumer-owned**, not trading | Decided during 9b planning (human-confirmed): **Traderton does not own human approvals.** The agent/consumer platform decides whether a decision needs a human, asks the human (its own UI/messaging), holds the pending approval + its TTL/short-code/expiry, and — on approval — calls Traderton's `submit_decision` (the same port a direct decision uses). Evidence the approval flow is platform: it is keyed on platform `userId` (rejects if `approval.userId !== userId`; requires an owned agent with a user), reads `authorizationMode` from the platform `agent.unifiedConfig`, and notifies via the platform messaging surface (Telegram/`InstanceEventPublisher`). The copied table/repo were an **orphan** in Traderton — no trading code imported them (verified). Removed by clean deletion (2 files + 3 barrel lines) + regenerated initial migration (23→22 tables); build/lint/tests green (2131 pass). Traderton's parity obligation is `submit_decision` **execution**, which stays (Met). Reasoning: [004](./004-decision-log.md) ("Why Traderton does not own human approvals"); un-blocked from Phase-2 "Met" table set — corrected in the Trading data model row above. Not Deferred-required (the capability is consumer-owned, not a Traderton obligation). |
| `AgentIntakeResolver` grant-fallback (herobids `agent-intake-resolver.ts`, `resolveActiveBinding`) + the `ActorStateOwner` agent-session wrapper | **NOT copied** (item C, decision locked 2026-09-07); Traderton requires a **running `ExecutionActor`** — no actor → `instance_not_running` (existing copied rejection) | Decided during 9b item-C planning (human-confirmed, option (a)). The grant-fallback resolves a decision's venue account by walking `agentConnections ⋈ connections` — `resolveActiveBinding` returns `{ id: connections.id, venue: connections.provider, venueAccountId: connections.resolvedVenueAccountId }`. A "binding" is therefore the **agent↔connection grant**, and the fallback IS the connection-grant front-end — the exact platform layer already placed consumer-side (the `connections`/`agent_connections` divergence row above + decisions 11–13 + the Phase-8 `resolveBotStartupContext` cut). "Agent with no binding" = no active connection grant = a consumer-side grant state, so Traderton (which takes an injected `venueAccountId`) has nothing to execute against and rejects rather than re-resolving grants it doesn't own. Git evidence it is the **legacy pre-actor path**: `AgentIntakeResolver` was the original agent-direct trading path (herobids `d82db5e7`, 2026-06-12), demoted to a "paper-only fallback (testing / agents with no binding / degraded mode)" when the `ExecutionActor`/`AgentTradingActor` concept landed (`898c82da`, 2026-06-14, plan `001-agent-execution-actor/001-plan.md` line 225). Traderton extracts the intended design (the actor), not the demoted vestige. Consumer-owned convenience (paper/testing without a running actor) stays consumer-side. **Not a dropped trading capability; a relocated grant concern** — same seam already cut for bots, applied to the agent-direct path. `submit_decision` **execution** parity is unaffected (Met via the copied `AgentTradingActor` actor-owned intake). See [013 §5](../archive/features/013-9b-authoring-plan.md) + [017](../archive/features/017-item-c-intake-proposal.md) + [004](./004-decision-log.md). Not Deferred-required. |

## Cutover Sign-Off

This section is the aggregate production cutover gate. The inventory authority
remains [006-source-capability-manifest.md](./006-source-capability-manifest.md),
the row-level live statuses above are the evidence base, and the operational
proof comes from [007-operational-readiness.md](./007-operational-readiness.md).

| Gate | Status | Evidence / notes |
|------|--------|------------------|
| Inventory fully accounted for | Pending | Every inventory row from 006 has a ledger disposition appropriate for the target cutover. |
| All `Deferred (required for cutover)` entries resolved | Pending | Every ledger entry tagged `Deferred (required for cutover)` is now `Met`/`Improved` (or explicitly re-accepted as `Gap` with sign-off). herobids-on-Traderton must not be weaker than herobids-today for any capability herobids relies on Traderton to provide. Enumerate the resolved entries here. |
| Side-effecting parity validated | Pending | `submit_decision`, bot lifecycle, risk gate, and watch lifecycle have copied-test and cutover-evidence coverage. |
| Consumer boundary contract validated | Pending | [005-consumer-boundary-contract.md](./005-consumer-boundary-contract.md) is implemented and integration-tested end to end. |
| Operational readiness passed | Pending | Latency, equivalence, restart-resilience, and rollback checks from 007 passed in the target environment. |
| Rollback path rehearsed | Pending | Traffic can move back to the prior trusted path without data loss or double execution. |
| Final cutover approval | Pending | Record approver, environment, date, and release note or change ticket here. |

Only mark `Final cutover approval` as `Met` when `Inventory fully accounted
for` is `Met`, `All Deferred (required for cutover) entries resolved` is `Met`,
and `Side-effecting parity validated`, `Consumer boundary
contract validated`, `Operational readiness passed`, and `Rollback path
rehearsed` are each `Met`. Accepted `Gap` or `Deferred (optional)` entries may
explain the inventory state; they do not waive the mandatory contract, readiness,
or rollback gates. A `Deferred (required for cutover)` entry does **not** get to
explain-and-pass — it must be resolved (or re-accepted as a signed-off `Gap`)
before cutover.

### L3-P1b outstanding issues (herobids-side re-point, reviewed 2026-09-11 — PASS, no critical/high)

- **MEDIUM — `checkVenueAccountLimit` is ineffective for trading links post-L3-P1b. `Deferred (required for cutover)`.** herobids' `apps/api/src/plan-guards.ts` `checkVenueAccountLimit` counts rows in herobids' LOCAL `venue_accounts` table, but the trading path no longer writes that table (venue accounts are boundary-owned now). So the per-plan venue-account cap silently stops enforcing for boundary-provisioned accounts (the local count is ~0). §6 intended this check KEPT; it is kept in form but not in substance. Belongs to the `venue_accounts` / provisioning rows. **DECIDED DIRECTION (2026-09-11, human) — option C:** add a boundary READ tool (e.g. `count_venue_accounts` / `list_venue_accounts`) that returns the owner's true venue-account count from Traderton's DB; herobids calls it in its pre-provision check and enforces the plan limit ITSELF (policy/entitlement stays herobids-owned; Traderton owns only the data + answers "how many"). Preferred over (a) boundary-enforced limit (pushes policy into Traderton — rejected: venue-account limits are a platform entitlement, unlike maxBots where bot state is fully Traderton-owned) and over (b) herobids `connections` proxy (rejected: bakes in a 1:1 connection↔venue-account assumption the extraction is dissolving). The read tool is read-only (short-circuits resolution), leaves `provision_venue_account`'s contract unchanged. **Caveat (accepted):** count-then-provision is not atomic (TOCTOU) — a brief over-limit is possible under concurrency; acceptable for a plan limit (recoverable, not a safety invariant).

  **RESOLVED 2026-09-11 (on `l3-integration` + herobids `consume-traderton`).** Traderton: added `count_venue_accounts` read tool (`packages/worker/src/tools/account.ts`, category `read-database` → resolver short-circuits it; owner-scoped `count()` on `venue_accounts`; fail-closed on missing db/owner; `{count}` result; 5 unit tests). herobids: `checkVenueAccountLimit` (`apps/api/src/plan-guards.ts`) re-pointed from the local table to the boundary tool — signature now `(tradertonClient, config, userId, planId, isAdmin)`; **fails closed** (`precondition.not_ready`) on no-client / boundary failure / transport / in_progress / malformed payload (never silently allows over-limit). `setup.ts`: the check MOVED out of the Phase-2 DB tx to a Phase-0 pre-provision step (no HTTP-in-transaction; also removes the prior over-limit provision→deprovision round-trip — that LOW is now moot). `accounts.ts POST /venue-accounts`: signature updated. **PROVEN end-to-end** (signed calls → live boundary → real Postgres): count 0 → provision → count 1 → deprovision → count 0. Build/lint/test green (traderton; herobids 7735 passed). **Follow-on — `accounts.ts POST /venue-accounts` is a deprecated PREVIEW remnant. `Deferred` (LOW).** This primitive endpoint still CREATES a venue account in herobids' LOCAL `venue_accounts` table (L3-P1b re-pointed only the holistic `setup.ts` path). **Gating (traced + corrected 2026-09-11):** its web page is under the sidebar **Preview** group, which is rendered ONLY for `user?.isAdmin` (`apps/web/.../Sidebar.tsx`) — so non-admins are never linked to it. The `/venue-accounts` ROUTE (`router.tsx`) is in the plain authenticated group (a manually-typed URL still resolves for non-admins), but "preview implies just a preview" — not a path we stand behind. **No scripts POST to it** (verified: `herobids/scripts`, `herobids/infra/hetzner/scripts`, `traderton/scripts` — the quick-setup scripts use `/setup/provider-link`, already re-pointed). **Design stance (human):** working with venue accounts DIRECTLY is against the model — the old 3-step ceremony (create credential → bind → assign connection) was deliberately collapsed into ONE action (the guided `createProviderLink`); this endpoint + its preview page are leftover hints of the old flow. **Preferred resolution: DELETE the preview page + the `POST /venue-accounts` endpoint** as part of cutover cleanup (rather than re-point it), since the collapsed one-action flow fully replaces it. If kept, it must be re-pointed to `provision_venue_account`. Its limit check was updated to the boundary count in this slice (documented in-code) — harmless given the above.
- **LOW — over-limit trading provision does a provision→deprovision round-trip.** In L3-P1b the venue-account/connection limit is re-checked in Phase 2 (after the boundary provision); an over-limit request therefore provisions then compensates (deprovisions). Correct (no orphan) but slightly wasteful. Acceptable — the compensation path must exist regardless. Optional optimisation: a pre-provision proxy check.
- **LOW — `apps/api/src/trading-provisioner.ts` is now unused** (no importers after the setup.ts re-point). Left in place; delete in a later cleanup slice (part of the eventual venue/credential-table teardown).

### L3-P1b end-to-end verification (2026-09-11) + a blocker found & fixed

**Blocker found by the live end-to-end run (would NOT surface in unit tests / mocks):**
the F2b subject-resolver (`packages/boundary/src/subject-resolver.ts`) had only two
side-effecting paths — bot-scoped (payload names `botId`) and no-bot (resolve a
per-owner DEFAULT venue account, else `precondition.not_ready`). `provision_venue_account`
is the tool that CREATES an owner's first venue account, so it hit "no venue account for
owner" → `precondition.not_ready` and could NEVER run — a chicken-and-egg deadlock.
`deprovision_venue_account` (takes `venueAccountId`, needs no venue coordinates) hit the
same wall. The resolver was authored (F2b) before provision/deprovision existed.

**Fix (traderton side, on `l3-integration`):** added an owner-scoped provisioning-tool
short-circuit to the resolver — mirroring the read-tool seam — that returns a minimal
injection (`ownerId` + `actorId`, empty venue coords) for `provision_venue_account` /
`deprovision_venue_account`, skipping the venue-account requirement (they write tables via
`ctx.db` and drive no executor). Name-scoped (an explicit set), NOT category-wide: other
`write-database` tools (e.g. `create_bot`) still require a resolved venue account. Added
`toolName` to `resolveSubjectInjection(...)` + updated `bin.ts` + 14 resolver tests green
(new provisioning-seam block; guard test that `create_bot` still requires an account).
A future `drivesExecutor: false` tool-contract flag could replace the explicit set (noted).

**End-to-end PROVEN (herobids-style signed calls → live boundary → real Postgres:16, via
the committed dev signer):** provision → success (`{venueAccountId}`, metadata only) ·
idempotent retry (same key) → same id, no duplicate row (idempotency store works) ·
deprovision → success (real FK cascade venue_account→credential) · second deprovision →
`not_found.resource` under `details.errorCode` (confirms the wire-code collapse the
herobids re-points branch on) · bad payload (Jupiter missing privateKey) → validation
failure, no persist. This exercises the encryption, the FK cascade, and the idempotency
store that the mock-only tool tests (the logged deprovision MEDIUM) could not.

**Verification method note (cutover):** the base `docker-compose.yml` omits
`CREDENTIAL_ENCRYPTION_KEY`, which `provision_venue_account` needs to encrypt secrets (F2c
only ran paper-mode create_bot). The e2e run supplied it via a local, uncommitted compose
override. **Cutover obligation (LOW): add a dev `CREDENTIAL_ENCRYPTION_KEY` to the compose
stack** so provisioning is exercisable from the committed stack without an override.

### Side-effecting boundary tools NOT yet consumed over REST — goal-blocking obligations (classified 2026-09-11)

**Context.** The goal is: no trading logic runs in the herobids process. herobids currently
routes only these to the boundary: `create_bot`, `submit_decision`, `provision_venue_account`,
`deprovision_venue_account`, `start_bot`, `stop_bot`, `adjust_bot_config`, and the read tools
(`get_account_summary`, `get_analytics`, `get_bot_status`, `get_price`, `get_market_overview`,
`get_positions`, `list_bots`, `list_positions`). The tools below are trading (or trading-adjacent)
but are STILL invoked in-process in herobids (they import `@herobids/*` directly). Each is
**goal-blocking, not optional** — deferred only in *when* (sequencing), never in *whether*. Until
each is re-pointed to the boundary, the legal-isolation goal is unmet.

- **`adjust_risk_limits` — trading. `Deferred (required for cutover)`.** Mutates the risk contract
  (trading policy). Already a copied boundary tool (`tools/risk-limits.ts`, `write-database`). Uses
  `ctx.riskContractOps` — needs NO resolved venue account. Obligation: re-point herobids' call site
  to the boundary (like Q2). Blocked on nothing; sequenced after the current L3 slices.

- **`watch_token` / `remove_watch` / `check_watches` (+ `list_watches`, `resolve_watch`) — trading,
  traderton-owned, pull-based. `Deferred (required for cutover)`.**
  **Classification rationale:** watching a *token price* for a threshold is trading-adjacent by
  definition — the concept "token price threshold" is trading. The litmus test (human, 2026-09-11):
  "a user should be able to write a skill teaching a herobids agent to use traderton, with NO
  herobids code doing or knowing trading-adjacent aspects." A herobids-side "generic watch engine +
  injected price provider" FAILS this — either herobids ships trading-aware provider code, or a skill
  would have to inject code (skills are data, not code). Therefore the watch system is **traderton-owned
  and reached as boundary tools**, so a skill can teach the agent to watch tokens by naming traderton
  tools alone. This matches the code as-is: `watch.ts` already lives in traderton
  (`packages/worker/src/tools/watch.ts`, `TradingToolContext`, boundary-registered); watches persist
  in traderton Redis (`agent:watches:{agentId}`); position-linkage/instrument resolution is already
  traderton-side. **Event delivery is a NON-issue: watches are agent-PULL** — the agent invokes
  `check_watches` (an eval tool) over the boundary; no push/streaming channel to design. Obligation:
  re-point herobids' agent tool-calls for these to the boundary. Design points for that slice:
  confirm `check_watches` context needs only agent-scope + price reads (no venue account), and it
  rides the resolver-signal fix below.

- **`check_regime`, `score_candidate` — trading. DONE (Q2, boundary tools built + reviewed).**
  Re-point of herobids' 3 market-intelligence call sites → boundary is the pending step (Q2 re-point
  slice); tracked in the direction overview.

### Subject-resolver: replace the provisioning name-set with a per-tool signal (before routing the above)

**Finding (latent, not live).** `packages/boundary/src/subject-resolver.ts` decides "needs a resolved
venue account" by fall-through: read-only → skip; bot-scoped → resolve from bot; ELSE → require a
per-owner default venue account (else `precondition.not_ready`). That final catch-all wrongly requires
a venue account for side-effecting tools that DON'T drive the executor. Evidence: only `submit_decision`
+ the bots tools use `ctx.publishToInbound` (the drive target that consumes venue coords); `provision`,
`deprovision`, `adjust_risk_limits`, and the watch tools do NOT. L3-P1b patched `provision`/`deprovision`
with an explicit name-set (`OWNER_SCOPED_PROVISIONING_TOOLS`). `adjust_risk_limits` + the watch tools
are currently mishandled by the fall-through, but the boundary does not receive them from herobids yet
→ **latent, not a live bug.**

**Decision.** Do NOT grow the name-set to silence this. Replace the name-set with a per-tool signal
on the tool contract, **default chosen deliberately** (safe default: wrongly requiring an account →
the correct tool refuses to run — visible/non-destructive; wrongly skipping → a drive tool runs without
venue coords — silent/dangerous → so default = needs resolution). Category-blind (both live in
`write-database`), so it MUST be a per-tool property, not derivable from category.

**RESOLVED 2026-09-11 (L3-Rx, on `l3-integration`).** Added optional `ownerScopedNoVenue?: boolean` to
`AgentTool` (absent/false = needs resolution — fail-closed). Set `true` on the 6 non-drive side-effecting
tools (`provision_venue_account`, `deprovision_venue_account`, `adjust_risk_limits`, `watch_token`,
`remove_watch`, `check_watches`; `list_watches`/`resolve_watch` are `read-memory`, already short-circuited).
`resolveSubjectInjection` now takes a resolved `skipVenueResolution` boolean (dropped the name-set +
`toolName` param, stays port-only); `bin.ts` computes `isReadOnlyCategory(category) ||
tool?.ownerScopedNoVenue`. The four resolution paths are byte-identical — only the short-circuit entry
changed; the method was NOT split (authored code, no oracle). Tests: reworked `subject-resolver.test.ts`
(flag-driven) + new `owner-scoped-no-venue.test.ts` (guards the 6 flagged + 5 drive tools). Build/lint/test
green (2410 passed). This pre-empts the latent mishandling of `adjust_risk_limits`/watch tools BEFORE they
are routed over REST. Plan: [docs/features/L3-Rx-subject-resolver-venue-signal-plan.md](./features/L3-Rx-subject-resolver-venue-signal-plan.md).

  **Plan (implemented):** [docs/features/L3-Rx-subject-resolver-venue-signal-plan.md](./features/L3-Rx-subject-resolver-venue-signal-plan.md)
  — full design (opt-out signal `ownerScopedNoVenue`, fail-closed default, the flagged tools, the
  `publishToInbound` ground-truth table, steps + tests). Transient working doc; THIS ledger entry is the
  durable record.

### Q2 re-point + adjust_risk_limits — DONE (2026-09-11, autonomous to branch; nothing merged)

Cross-repo slice, decided via the 008 process (see decision-log). Traderton on `l3-integration`,
herobids on `consume-traderton`. Nothing pushed, nothing merged to `main`.

- **Q2 regime re-point — Met.** herobids `coordinator.refreshRegime` + `evidence-adapters.ts` evaluate
  regime via the boundary `check_regime` (candles fetched behind the boundary). Telemetry RE-SOURCED from
  the tool result (parity, not degraded): `recordProviderSuccess` + `recordFreshnessMode` from
  `data.freshness`; `rate_limit.exceeded` → `recordRateLimitThrottle`; else `recordProviderFailure`;
  fail-closed (unavailable snapshot) when the boundary is absent. Traderton support: `check_regime` now
  returns `data.freshness` + a reachable `rate_limit.exceeded` (see the "check_regime freshness" ledger
  entry + 003). **Does NOT clear `@herobids/market-data`** — the coordinator's discovery loop
  (`providerRegistry.discovery.discover`) is untouched (separate larger slice; `discover_tokens` is a
  single-network point query lacking the coordinator's multi-network snapshot/stale surface).
- **Q2 score_candidate re-point (ORDERBOOK/PERP only) — Met; swap Deferred.** `preset-scorecard-runner` +
  `platform-assessor` are async/Result; orderbook/perp scored via `score_candidate` (providerSymbol =
  identity.symbol reproduces old behaviour; `scanHealth` from `candlesEvaluated`; infra failure propagated
  as a Result err, never synthesized `stale`). **Swap/dex CARVED OUT** (`Deferred (required for cutover)`):
  the boundary needs a DEX pool address the assessment identity lacks (only a token address), and the old
  path sidestepped it by passing candles — so swap scoring stays in-process for now; re-point deferred
  pending a token→pool resolution decision (route via 008).
- **adjust_risk_limits write re-point — Met.** The agent risk-limit WRITE routes through a new subject-bound
  `tradertonWriteBoundary` on `ToolContext`; **fail-closed** (`precondition.not_ready`, no in-process
  fallback) when the boundary is absent (per the confirmed L3c write posture). `get_risk_limits` (read)
  still uses `ctx.riskContractOps` — only the write path moved.

**Verification:** traderton build/lint green + 2418 tests; herobids build/lint green + 7746 tests
(independently re-run). Traderton `check_regime` freshness/rate_limit + `count_venue_accounts` were proven
end-to-end against the live docker boundary earlier; the herobids worker→boundary regime/score live run is
verified by suites + the proven signed-invoke path (a full worker-process e2e is a staging-soak item).
**Follow-on obligations opened:** swap `score_candidate` re-point (token→pool); coordinator discovery-loop
re-point (needs snapshot-parity boundary surface); `get_risk_limits` read re-point (L3d); watch-tools
state-move (own slice, carved earlier).

### Market-intelligence extraction + risk-limits read group — DONE (2026-09-12, autonomous to branch; nothing merged)

Decided via the 008 process; traderton `l3-integration`, herobids `consume-traderton`. Nothing pushed/merged.

- **T1 `get_risk_limits` read re-point — Met.** herobids routes the read through `ctx.tradertonBoundary`
  when configured (Traderton tool is a byte-identical copy → parity by construction); read-fallback to
  in-process `riskContractOps` when absent. Completes the risk-limits pair with the `adjust_risk_limits`
  write (fail-closed). herobids `7748c199`.
- **T2 swap `score_candidate` — Option B BUILT (C2, 2026-09-12; the earlier "BUILD DEFERRED" is SUPERSEDED).**
  The swap arm landed with the market-intelligence group's `scannerPoolResolver`: `score_candidate`
  (`packages/worker/src/tools/strategy.ts`) accepts a held token (`network+tokenAddress`), resolves its
  canonical pool behind the boundary (`scannerPoolResolver` → `selectCanonicalPool`: highest liquidity,
  tie-break volume then poolAddress, NO quote-asset constraint = the ratified decision), fetches that
  pool's candles (`scannerCandleFetcher` → GeckoTerminal), and scores — plus the Option-A `poolAddress`
  path. Wired in `bin.ts`; proven e2e (`boundary-e2e.ts` swap check, free endpoints); 15/15 strategy tests
  incl. 7 swap cases. Orderbook/perp already Met (prior Q2). Swap `score_candidate` now at PARITY+improvement
  (real pool candles). (The old note's "INERT today" reflected a pre-build state; verified stale at C2.)
- **T3 coordinator discovery-loop re-point — Met; clears the coupling.** `discover_tokens` widened to
  `networks[]` + `maxResults` + reachable `rate_limit.exceeded` (traderton `e3a2e75`; engine already
  multi-network, cross-network dedupe/rank stays behind the boundary — not re-authored). herobids
  `refreshDiscovery` calls it over the boundary; telemetry re-sourced (both providers); snapshot assembly +
  per-network slices + TTLs unchanged (parity); fail-closed when absent. **`providerRegistry` REMOVED from
  the coordinator — its last in-process `@herobids/market-data` coupling is cleared.** herobids `73348523`.
  (`sharedMarketDataRegistry` stays in index.ts for the scanner-candle-fetcher — a separate consumer.)

**Verification:** traderton build/lint green + 2418+ tests; herobids build/lint green + 7754 passed / 320
skipped (independently re-run). Traderton boundary behaviours proven e2e earlier against the live docker
boundary; the herobids worker→boundary discovery/regime live run is a staging-soak item (verified by suites
+ the proven signed-invoke path). **Pending human ratification** (parity-touching): regime + discovery
telemetry re-source; T2 approach B; T3 discovery snapshot re-source.
**Open follow-ons:** T2 swap score build (token→pool, Traderton authoring); `@herobids/market-data` still
held by the scan pipeline + scanner-candle-fetcher (separate extract); watch-tools state-move.

### Ratification (2026-09-12, human)

The human RATIFIED the parity-touching decisions from the market-intelligence + risk-limits-read group
(the ratify-list): (1) regime + discovery telemetry re-source (Intentional-divergence/improvement);
(2) T2 swap `score_candidate` Option B (approach; build deferred); (3) T3 discovery multi-network
re-source + `discover_tokens` widening. All "pending human ratification" flags on these are now CLEARED.
**This is a ratification of the decisions, NOT a merge-to-`main` approval** — the work remains on branches
(`l3-integration` / `consume-traderton`); the merge gate is a separate, explicit, later human decision.

### B1 dead-scan-pipeline deletion + B2 scope + newly-found read-tools obligation (2026-09-12)

- **B1 — dead in-process scan pipeline DELETED (herobids `consume-traderton`).** 7 producer files
  (technical-phase, complete-technical-scan, scanner-candidate-discovery, scanner-pre-filter,
  swap-candidate-discovery, swap-token-resolver, token-safety-adapter) + their tests removed — no
  production callers (already dead since the L3d-5 actor slice; verified). `TechnicalScanState` + its
  consumers KEPT (LIVE — fed by `agent.technical.scan_completed` from Traderton); two DTO types relocated
  to `apps/worker/src/scan-types.ts`. `@herobids/engine` confirmed TYPE-ONLY everywhere. Build/lint/test
  green (378 files / 7574 passed). Not a parity concern (dead code).
- **B2 — agent.ts tick-loop couplings (scope = option 1, human-decided):** re-point regime / volatility /
  hybrid-sizing / venue-intelligence now; DEFER full market-data-registry removal. In progress.
- **NEW cutover obligation — agent-container READ TOOLS still consume in-process market-data.
  `Deferred (required for cutover)`.** `tools/price.ts`, `tools/market-data.ts`, `tools/watch.ts` use
  `ctx.marketDataRegistry`/`ctx.priceService` directly in the agent container. Until they re-point to the
  boundary, `createProviderRegistry`/`createPriceService` cannot be removed and "no market-data in the
  herobids agent process" is NOT fully met. Its own slice, after B2. This is the honest gap B2 alone does
  not close.
- **B2 open decisions (to route via 008 as B2 builds):** volatility-candle-series gap (no boundary tool);
  hybrid `get_price` vs `resolvePriceTarget` contract; venue-intelligence field-shape coverage;
  economic-calendar scope.

### Market-intelligence boundary registry-wiring gap + DEX top-pick divergence (2026-09-12, routed via 008)

Surfaced by the 008 decision agent while reviewing the B2 venue-intelligence re-point; verified by the coordinator against `bin.ts` + the four read tools.

- **D1 — GAP → RESOLVED by commit `acb706e` (pending merge-gate ratification):** the production boundary context factory (`packages/boundary/src/bin.ts`) did NOT wire `marketDataRegistry`/`marketDataConfig` into the `TradingToolContext`, so `check_regime` / `get_market_overview` / `discover_tokens` / `search_tokens` returned `market_data_not_configured` over the boundary. **Now wired** (commit `acb706e`: `createProviderRegistry` + `marketDataConfig` + `createPriceService`, gated on `appConfig.marketData`), so the B2 market-intel re-point serves data over the boundary. See 003-anomalies row 2026-09-12. Parity-touching (changes what the boundary serves) → PENDING human ratification; stops at merge gate.

- **D2 — DEX venue-intel top-pick selection = Intentional-divergence (Option A), PENDING human ratification:** once the registry is wired, the boundary `search_tokens` selects the top DEX token by Traderton's safety-aware ranking (`rankAndFilterCandidates`: eligible-first, then safety-score desc), whereas the in-process path selected by highest-liquidity (≥$10k floor, liquidity-desc). herobids keeps its own network filter + takes `search_tokens`[0]; it does NOT re-author a liquidity floor/sort (that would re-home market-data policy in herobids, violating the top rule). Rationale (decision agent): the DEX venue-intel signal is DISPLAY-ONLY (flows to the LLM prompt context via `recordVenueSignals` → `venueIntelligence` block; no execution/sizing/risk-gate consumes the chosen token), so a safety-first pick is a defensible improvement, not a degrade; Option C (a `search_tokens` param reproducing liquidity ordering) is rule-unviable (ranking is always safety-score desc). If the $10k liquidity floor must be preserved, pass `minLiquidityUsd:10000` to `search_tokens` (a filter honoured by `applyTokenSearchPolicy`) — ordering stays Traderton's. **Status: Intentional-divergence, pending ratification.**

### Outstanding Issues — market-intel boundary wiring + B2 re-point (2026-09-12 code review, non-blocking)

From the CodeReviewer pass on the boundary-registry wiring + herobids B2 re-point. No CRITICAL/HIGH. M1 (bybit rejection-telemetry parity on the boundary perps failure path) was FIXED in the same slice. Remaining, deferred as non-blocking:

- **[boundary wiring] M2 (LOW-ish):** `bin.ts` injects `marketDataRegistry`/`marketDataConfig`/`priceService` via `as unknown as TradingToolContext[...]` casts. Consistent with the pre-existing `botRepo`/`redis` cast style in the same object (a cross-package structural-typing seam), not new debt. Optional: add a one-line comment or a shared type alias explaining the structural cast.
- **[herobids B2] L1:** the `result.kind !== 'success'` → throw block is repeated 4x (get_market_overview / discover_tokens / search_tokens / check_regime). Could DRY into a `boundaryResultError(toolName, result)` helper. Deferred (4x, each trivially readable).
- **[herobids B2] L2:** `parseRegimeBoundaryPayload` defaults `freshness.provider` to `'binance'` (a magic literal tied to the regime candle source). Correct today; add a clarifying comment.
- **[herobids B2] L3:** `DexDiscoveryMeta`/`DexSearchToken` inline types in `agent.ts` duplicate a subset of the exported `DexBoundaryToken` parser interface. Intentional narrowing to rendered fields; minor.

### Outstanding Issues — swap score_candidate re-point (2026-09-12 code review, non-blocking)

CodeReviewer pass on the swap token→pool re-point. No CRITICAL/HIGH — implementation faithful to the ruling and cleanly layered. Deferred, non-blocking:

- **[swap score_candidate] M1:** the 4-field pool shape (poolAddress/network/liquidityUsd/volume24hUsd) is duplicated across 3 sites — `strategy.ts` (ResolvedPool), `tool-contract.ts` (inline scannerPoolResolver port type), `strategy.test.ts` (PoolResolver). Extract a single named domain type (e.g. `ScannerPoolCandidate`) to prevent silent drift. Follow-on.
- **[swap score_candidate] M2:** `selectCanonicalPool`'s pure lexicographic tie-break (equal liquidity AND equal volume → poolAddress localeCompare) is not asserted on its own. Add a dedicated unit test.
- **[swap score_candidate] L1/L2/L3:** non-null `[0]!` in selectCanonicalPool (prefer destructuring); dual-rate-limiter double-acquire on the resolver+fetch path (documented; ledger note only); buildTarget three-arm union readability. Cosmetic.
- **Note (adjacent):** traderton already has a `swap-token-resolver.ts` (liquidity-ranked token→pool). The GeckoTerminal point resolver was chosen per the 008 ruling (guaranteed candle-fetchable by the same provider). If a future consolidation is wanted, evaluate whether the two resolvers should converge — follow-on, not this slice.


### Economic calendar — trading-adjacent coupling, Deferred (required for cutover) (2026-09-12, HUMAN RULING — FINAL)

RETRACTS the earlier "explicitly-platform / not-a-Gap" classification. Human ruled (final, legal-based): the
economic calendar is **trading-adjacent** — it is trading-capability-gated and feeds the agent's decision
prompt as market context (see 004-decision-log 2026-09-12). Therefore it is a coupling, not a platform
carve-out.

- **Status: Deferred (required for cutover).** The economic-calendar ACQUISITION (ForexFactory/Scrapfly
  scrape loop + parser + `CompositeEconomicCalendarProvider`) and the tick read
  (`getUpcomingEvents({cacheOnly:true})`) must move behind the Traderton boundary so no trading
  market-context acquisition runs in the herobids process. No trading market-data acquisition may remain
  in-process at cutover.
- **Own slice.** Boundary shape TBD at build time (acquisition-behind-boundary + a read tool e.g.
  `get_economic_calendar`, vs. a boundary-populated cache the consumer reads); the classification is settled.
- Until built, this is an UNMOVED coupling counted against the "no market-data in the herobids process"
  cutover gate — NOT a silently-dropped feature and NOT platform.


### Ratification (2026-09-12, human) — market-intel boundary group

The human RATIFIED the pending-ratification rulings from this group:
1. **Boundary registry wiring** (`acb706e`) — market-data registry/config/priceService injected into the boundary context. RATIFIED.
2. **DEX venue-intel top-pick** = Traderton safety-aware `search_tokens` ranking (Intentional-divergence, display-only). RATIFIED.
3. **Swap token→pool resolver** = GeckoTerminal token-pools point resolver (revising the T2/Q2 named primitive). RATIFIED (direction + mechanism), with two open items still to settle at build/staging time: (a) quote-asset constraint default (currently highest-liquidity, no constraint); (b) GeckoTerminal Pro `tokens/{address}/pools` endpoint availability.

All "pending human ratification" flags on the above are CLEARED. **This ratifies the DECISIONS, NOT merge-to-`main`** — work stays on branches; the merge gate remains a separate, explicit, later human decision.


### herobids functional/E2E suites are boundary-unaware — Deferred (own slice) (2026-09-12)

Running herobids `run-all-tests.sh --e2e` on `consume-traderton` surfaced 45 functional-tier assertion
failures + 1 Playwright journey (Journey 14), ALL one root cause: `POST /connections` / trading-link +
bot-lifecycle endpoints now provision the venue account **over the Traderton boundary** (herobids no
longer writes trading credentials locally — the legal-isolation objective). When no boundary client is
configured (`TRADERTON_BOUNDARY_HMAC_SECRET` unset → `tradertonClient` undefined), the route fails closed
with `precondition.not_ready` → **503**. The functional suites (`bots-lifecycle`, `capability-model`,
`go-live`, `trading-positions`, `agents.functional`) + Journey 14 were written for the PRE-boundary
local-write path and have NOT been updated — they call `setupTradingLink`/`createBot` expecting 201.

- **Not a regression, not caused by the market-intel work** (verified: the market-intel commits touch only
  worker files `agent.ts`/`agent-capabilities.ts`/`venue-intelligence.ts`/`preset-scorecard-runner.ts`;
  the 503 is the connection-provisioning path). The 503 is the fail-closed objective working correctly.
- **Deferred — own slice (required for cutover):** update the herobids connection/bot functional + E2E
  suites to the boundary world — either inject a stubbed `tradertonClient` (unit/functional) or stand up a
  cross-stack harness (herobids API/worker + a running Traderton boundary with matching
  `allowedConsumers`/signing creds) for a true integration/E2E run. This belongs to the
  connection/bot-creation re-point slice, NOT the market-intelligence extraction group.
- **Tiers that DO exercise the market-intel work all passed:** unit (3091/0), integration, all 4 API
  smokes, 22/26 Playwright journeys (3 skipped, 1 = Journey 14 boundary-gated). Plus the Traderton
  live-boundary e2e (6/6, `run-all-tests.sh --e2e`).


### Update (2026-09-12) — functional suites made boundary-aware; bot-lifecycle sub-item still deferred

Progress on the "herobids functional/E2E suites are boundary-unaware" item above.

- **DONE:** the connection-dependent functional suites (agents.functional, capability-model, go-live,
  trading-positions) now pass by injecting a stubbed `tradertonClient` into the functional harness
  (`apps/api/src/__tests__/functional/helpers.ts`) — they exercise the real post-provision local write
  instead of stalling at 503. Also fixed a pre-existing harness 500 (`CREDENTIAL_ENCRYPTION_KEY` was
  restored/deleted before request time). herobids `dbf0c4f1`. Functional tier: 164 passed / 0 failed /
  7 skipped; full `run-all-tests.sh` green.
- **STILL DEFERRED (own slice — bot-ownership / create-contract decision):** 7 bots-lifecycle cases are
  `it.skip` with documented reasons. Root: `create_bot` is now an ASYNC boundary submit that writes NO
  local `bots` row (Traderton owns bots; the row lands on the next worker tick), while herobids'
  DELETE/stop/start read the LOCAL bots table. Also, the paper+swap execution-capability validation MOVED
  behind the boundary (herobids dropped its local pre-check). Re-enabling needs the decision: does herobids
  keep a local bots mirror? is create sync-or-async over the boundary? where do lifecycle reads resolve?
  These are behaviour/contract four-risk questions — route via 008 when the bot-lifecycle re-point slice is
  taken up. The tests are preserved (skipped, not deleted) as the parity harness for that slice.
- **STILL DEFERRED:** the true cross-stack E2E (herobids stack + live Traderton boundary, matching signing
  creds) — merge-gate-prep, as before.


### Bot-consumer contract — decision-agent rulings (2026-09-12); read re-point still gated

The 008 decision agent settled the bot-consumer contract (see 004 2026-09-12 + docs/009 brief). Consequences for the ledger:

- **Bot reads over the boundary (1b) — Deferred (required for cutover).** Blocked on the owner-scoped Traderton read surface (below). Until it lands, herobids bot reads stay on the local mirror.
- **New owner-scoped Traderton read surface — Deferred (required for cutover), COPY/ADAPT.** Owner-keyed `list_bots`/`get_bot_status` + owner/bot-scoped costs/journal/journal-summary/sessions/events + a `getBotsByOwner`-family repo method — re-key the existing agent-scoped queries to the soft `ownerId` column (decision 13). Built as an adapt, not authored; proceeds as an `l3-integration` slice under the autonomy contract. This is the gating prerequisite for the entire bot read re-point.
- **`POST /bots` 201→202 contract change — Intentional-divergence.** id-later (no local row); rule-forced by async ownership. Consistent with start/stop (already 202). Client/UI correlation-token shape pending human item A.
- **Lost synchronous paper+swap 400 at create — Intentional-divergence / transitional Gap.** Capability validation is now async (rejected at Traderton publish); the immediate 400 herobids gave is gone until the bot read path (1b) can surface the async failure. Pending human item B (accept async-only vs fund a sync `preview_bot_capability` tool).
- **Interim local-mirror staleness — transitional Gap (closes on 1b).** Between the write re-point (done) and the read re-point (1b), a bot created over the boundary writes NO local row, so herobids' local-mirror read endpoints are stale/incomplete for boundary-created bots. Accepted transitional inconsistency, confined to the branch, resolved when 1b lands. NOT a silent drop (recorded here).
- **7 skipped bots-lifecycle functional tests** (herobids `dbf0c4f1`) are the parity harness for this slice — re-enable when 1b + the contract changes land.


### Owner-scoped bot read surface — LIST + STATUS landed (2026-09-12)

First slice of the owner-scoped read surface (004 ruling 4 — the gating prerequisite for the herobids bot read re-point). COPY/ADAPT of the agent-creator-scoped read path re-keyed to the soft `ownerId` column; agent-scoped path untouched.

- **Built (Traderton `l3-integration`):** `BotRepository.getBotsByOwner(ownerId, since?)` + `getBotByIdForOwner(botId, ownerId)` (mirror `getBotsByCreator`/`getBotById`, filter re-keyed to `ownerId`, no `creatorType` filter — owner = tenancy boundary, default C). Boundary read tools `list_owner_bots` + `get_owner_bot_status` (category read-database; field-for-field payload parity with `list_bots`/`get_bot_status`; scope on `ctx.ownerId`; ownership check pushed into SQL — no info leak).
- **Verified:** build/lint green; full suite 2436 passed / 0 failed; 5/5 owner-read repo integration on real Postgres; 17 bot-tool tests. CodeReviewer PASS (no critical/high/medium).
- **Scoping semantics (default C) PENDING RATIFICATION:** owner view = all bots whose `ownerId` matches regardless of `creatorType`.
- **Follow-on wave (still Deferred — required for the full read re-point):** owner/bot-scoped costs, journal, journal-summary, sessions, events (the remaining herobids GET /bots/:id/* endpoints read fills/journal). Not built in this slice.
- Next: with LIST+STATUS available over the boundary, the herobids consumer bot read/lifecycle re-point (1b) can re-point GET /bots + /bots/:id + the DELETE/stop/start ownership+status checks; then re-enable the 7 skipped bots-lifecycle tests.


### Bot re-point slice landed (A1/B1/C) — 2026-09-12

Implemented the ratified bot-consumer contract across both repos. The 7 skipped bots-lifecycle functional tests are RE-ENABLED and passing (herobids functional tier 171 passed / 0 failed / 0 skipped).

- **A1 (Met):** `create_bot` returns the synchronously-available `{ok, botId}` (the row + id are written synchronously by `tryCreateBotWithLimit`; only the actor START is deferred). Seam: `publishToInbound` return widened to `Promise<void | ManageBotResult>` (create branch returns `{botId}`, other branches void). herobids `POST /bots` returns **201 + id**. The misleading "next tick" note corrected.
- **B1 (Met — parity restored):** `validateExecutionCapability` wired into the live `createAndStart` path (was a GAP — present in herobids pre-migration, validated nowhere over the boundary). paper+swap rejected synchronously. **Boundary-union constraint (Intentional-divergence):** the closed 005 failure union cannot carry a dedicated code, so the tool returns `fault:false` → dispatcher maps to `validation.invalid_payload` (→ herobids 400) and threads the DEDICATED identity `execution_capability.paper_swap_not_supported` in `details.errorCode` + message. herobids `POST /bots` surfaces that identity in the 400. Status parity (400) + error identity preserved.
- **C (Met — additive divergence):** `list_owner_bots`/`get_owner_bot_status` payloads now include `creatorType`/`creatorId` so an owner can tell who created each bot. Intentional ADDITIVE divergence from the agent-scoped `list_bots`/`get_bot_status` (which omit creator); the agent-scoped tools are unchanged.
- **herobids reads re-pointed (ruling 1) with local fallback (ruling 5):** `GET /bots`→`list_owner_bots`; `GET /bots/:id`→`get_owner_bot_status`; DELETE/stop/start existence+ownership+status gate→`get_owner_bot_status`. The read boundary is derived from the existing write `tradertonClient` (same HMAC transport; read-database tools dispatch read-only). Lifecycle ACTIONS still route over the write boundary. Local-table fallback when the boundary is absent.
- **DELETE parity GAP (tracked — follow-on):** no boundary `delete_bot` tool exists yet, so herobids DELETE removes only the LOCAL mirror row (now owner-scoped); the boundary-owned bot persists in Traderton. Acceptable interim ONLY because the mirror is the pre-existing trading DB (L3d deletes it) and a stopped bot is inert. FOLLOW-ON: add a boundary delete tool + route DELETE over it (or refuse when the boundary is present). Do NOT treat the local delete as authoritative removal.
- **Still deferred (follow-on wave):** owner/bot-scoped costs/journal/sessions/events reads stay on the local mirror.


### Wave A1 — `delete_bot` boundary tool + herobids DELETE re-point — DONE (2026-09-12)

Closes the DELETE parity gap (herobids previously deleted only the local mirror; the Traderton-owned bot orphaned). Per 004 2026-09-12 "Wave A1" (S1–S5).
- **traderton:** `delete_bot` (`ownerScopedNoVenue`, write-database) mirrors `deprovision_venue_account`: owner-scoped existence (`getBotByIdForOwner` → `not_found.resource`), STATUS guard (`running` → dedicated `bot.running`, fault:false → boundary maps → 409), hard-delete via new `deleteBotByIdForOwner` repo method. Hard-delete verified safe (NO FK points to `bots`; fills/journal actor-scoped, survive).
- **herobids:** DELETE routes over `delete_bot` as authoritative, fail-closed (503 when boundary absent); boundary-FIRST then local-mirror delete (S5); 409 via `details.errorCode`. Pre-guard 409 + backstop cleanly layered.
- **Verified:** traderton build/lint/test 2448 passed / 0 failed; herobids lint clean + functional 172 passed / 0 failed. CodeReviewer PASS (no critical/high). 1 MEDIUM = backstop-409 test deferred to D1 (untested-today because the pre-guard fires first; tracked in 011 D1 sub-obligation).
- **H-1 pending ratification (safe default proceeding):** hard-delete is the terminal semantics (copy-faithful; forensic trail FK-independent). Retention, if ever wanted, is a post-migration 010 item.


### Wave A2 — owner-scoped bot read-wave (costs/sessions/events/journal/journal-summary) — DONE (2026-09-12)

Per 004 2026-09-12 "Wave A2" (S-C). Un-quarantine + adapt (agent→owner) — aggregation stays in Traderton; herobids is a thin pass-through.
- **traderton:** 4 owner-scoped read-database tools — `get_owner_bot_costs`, `get_owner_bot_sessions`, `get_owner_bot_journal_summary` (aggregation copied VERBATIM from the quarantined route: fee-grouping, session-pairing, count), `get_owner_bot_journal` (raw PgJournal.query serving both /events + /journal). Owner-scoped via `getBotByIdForOwner` → `not_found.resource`.
- **herobids:** 5 bot-detail endpoints re-pointed to the tools (boundary-when-present, local fallback ruling 5). Response shapes preserved.
- **Verified:** traderton build/lint/test 2463/0; herobids lint clean + functional 179/0.
- **CodeReviewer found + FIXED a HIGH (was a false green):** the read handlers checked top-level `code === 'not_found.resource'`, but the dispatcher remaps a tool's fault:false errorCode to the wire `validation.invalid_payload` (real code in `details.errorCode`) → absent/unowned bot returned 502 not 404. FIX: `readBoundary` now UNWRAPS `details.errorCode` when the wire code is `validation.invalid_payload`, surfacing the tool code so the 404 mapping fires (mirrors accounts.ts/delete precedent); the functional stub's `notFound()` now reproduces the real dispatcher mapping so the 404 tests genuinely gate it.
- Local aggregation reads removed at D1 (with the tables).
- **Human item (pending ratification, safe default proceeding):** journal tool granularity — 1 shared `get_owner_bot_journal` (chosen) vs 5 tools 1:1. Naming only.


### Ratification-scope correction (2026-09-12, human) — "violate", not "touch"

The human corrected a drift: ratification is required ONLY when a ruling **VIOLATES a rule, CONTRADICTS a recorded decision, or UNDERMINES an objective** (Intentional-divergence / Gap / accepted behaviour-degrade), OR when the decision agent says it cannot ground the choice and needs a product/policy call. A ruling that HONOURS the rules — even one squarely about parity or legal isolation — is SETTLED and just logged; it needs NO ratification. 008 §3/§6/§8 corrected to match §7's violate/contradict/undermine test (was loosely "parity/legal-touching").

**Re-classification of items I had marked "pending ratification" — most were OVER-FLAGGED (rule-honouring → NO ratification needed):**
- Reads-over-boundary → ENFORCES isolation. NOT ratification.
- POST /bots 201+id → RESTORES the pre-migration contract (parity). NOT ratification.
- sync paper+swap 400 → RESTORES a parity gap. NOT ratification.
- owner-scoped read tools built as copy/adapt → within copy-never-author. NOT ratification.
- A2 journal-tool granularity → naming/ergonomics. NOT ratification.

**GENUINELY needing the human (small):**
- **H-1 (hard-delete terminal semantics):** flagged by the decision agent as an ungroundable product call ("should a deleted bot's config be retained for audit?"). Accepts NOT building retention (a post-migration option). Stays pending — but note the human may simply confirm the copy-faithful default (hard-delete) or defer to the gate.
- **Owner-view shows creator (creatorType/creatorId):** an intentional ADDITIVE divergence from the agent-scoped tool shape — human-directed refinement; treated as ratified-by-direction, logged as Intentional-divergence.

Net: the standing ratification queue is effectively just H-1 (a product-call default), not the earlier inflated list.


### Wave B1 — hybrid-sizing price re-point — DONE (2026-09-12)

Per 004 2026-09-12 "Wave B1" (P-A, settled by parity). herobids hybrid sizing now resolves prices over the boundary; the in-process priceService is the fallback (ruling 5) — a step toward removing the agent-container registry (B7).
- **traderton:** new `resolve_price_target` read-market-data tool (mirrors get_price but calls `resolvePriceTarget`, surfaces the RESOLVED identity `{symbol,chain,address,name,priceUsd,source,fetchedAt,stale}`). get_price unchanged (P-C rejected).
- **herobids:** `createBoundaryPriceService(boundary)` adapter (PriceService-shaped, strict payload narrowing → fail-closed price.malformed) passed to `resolveHybridTargetSize` when the boundary is present; hybrid go_long guard now boundary-OR-priceService. resolvedChain/resolvedAddress/source metadata preserved.
- **CodeReviewer caught + FIXED a HIGH parity break:** the adapter initially collapsed (ticker + pinned address) into `address ?? symbol` (address-as-symbol), but the resolver SEARCHES DexScreener by the ticker `symbol` then PREFERS the exact-address match — so collapsing changed the search input = a silent DEX repricing divergence. FIX: `resolve_price_target` tool gained an optional `address` param; the adapter forwards ticker `symbol` AND `address` separately, reproducing the in-process `resolvePriceTarget(symbol, chain, address)` exactly. Tests corrected to assert both-args (were a false green).
- **Verified:** traderton build/lint clean + price tests 24/0 (full suite 2472/0 pre-fix); herobids lint clean + adapter/sizing 26/0.
- Shared surface: `resolve_price_target` also serves B3 (watch tools). No ratification (settled by parity).

### D1-c trading-table-drop WAVE — read re-points (c1–c3) — in progress (2026-09-12, autonomous to branch; nothing merged)
Decided via the 008 process; traderton `l3-integration`, herobids `consume-traderton`. Each herobids in-process reader of the dropping trading tables (`bots`/`fills`/`journalEvents`/`venue_accounts`) is re-pointed over the boundary (or removed if dead) BEFORE the D1-c4 drop.
- **D1-c1 evaluation-evidence reads — Met.** 3 agent-scoped boundary read tools (`get_agent_fills`/`get_agent_journal_events`/`get_agent_positions`, botIds folded server-side) + re-pointed `agent-evaluation/evidence-assembler.ts` (SYSTEM subject) + `apps/api/routes/exports.ts` agent endpoints (USER subject). Sessions stay local (platform). traderton 118/0, herobids 190/0.
- **D1-c2 assessment-identity venue-binding read — Met.** New derived boundary tool `get_agent_venue_binding` (`{venueFamily,venueType}|null`, no raw rows/secrets); `assessment-identity-resolver.ts` re-pointed via injected `resolveVenueBinding` port (agents.unifiedConfig fallback + agentPresetBindings styleTier stay LOCAL). traderton 65/0, herobids resolver 19/0.
- **D1-c3 startup-context resolver — Intentional-divergence (REMOVED).** herobids `apps/worker/src/startup-context.ts` (`resolveBotStartupContext` + `BotStartupError` + test) removed — superseded, mirrors Traderton's Phase-8 deletion of the same grant front-end (create-trading-runtime.ts §424, decisions 11–13). Dead-but-exported+tested; NO live caller (the live grant path is `index.ts:486` `approvalVenueAccountResolver` + `apps/api/routes/bots.ts` forwarding connectionId → boundary resolves the account). NOT a Gap — the capability moved behind the boundary, not lost. Decision agent ruling B, settled by parity (004 "D1-c3"). herobids worker+api tsc green; worker suite 3059/0.
### c4.9c/d/g — `/agents/outcomes` bot attribution (connectionId→creatorId) — Intentional-divergence (2026-09-12)
Per-agent trading outcomes now fold agent-owned-bot positions via creator-ownership (`bots.creatorType='agent' AND creatorId=agentId`) through `get_agent_positions`, replacing the source's `positions→bots→agent_connections` shared-connection join. The delta lives entirely in the `agent_connections`/`bots.connectionId` grant indirection, which decision 13 + c4.1 settled has NO Traderton successor (same connectionId→creatorId rescope as c4.9a/b/c/d; c4.9b flagged the old join as potentially double-counting). Trading capability preserved; only the platform grant-layer cross-attribution of other actors' bots is dropped. Decision-agent ruling (a): settled within migration rules, ledger-only, no attribution code change. Verified against pre-migration commit 5b26fc1a^ (`GET /agents/performance` bot Part-2 join keyed on `bots.connectionId`, not creator).
