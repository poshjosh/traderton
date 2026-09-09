# 013 — Phase 9b Authoring Plan (DRAFT — review checkpoint)

**Phase:** 9b of the roadmap ([009](../009-extraction-roadmap.md)) — the "authoring" pass, **re-scoped to
minimum-authoring** (2026-09-07).
**Shape:** MOSTLY copy-and-delete (including fused-file line-trims, the Phase-1 technique) + a small,
explicitly-bounded truly-authored core. The copy-never-author safety net still applies to every item
that *can* be copied; only the irreducible core (§1a) is authored, and each authored piece is isolated,
minimal, reviewed on its own, and validated against herobids as a behavioural oracle.
**Re-scope rationale (2026-09-07, human challenge):** authoring is where the project's safety model
(source-as-oracle) stops applying — bugs go silent, tests assert the author's assumptions. So we
re-tested every "authored" item against "is this actually a fused-file deletion like Phase 1?" Result:
most of 9b is copy-and-delete; the genuinely-authored surface is far smaller than first drafted (§1a).
**Status:** DRAFT — this plan is a **checkpoint**. Per the 009 per-phase pattern (subtraction/authoring
phases require a reviewed written plan before code moves), **no code moves until this plan is reviewed.**
**Depends on:** 9a done + the M1 holistic review ([011](./011-m1-holistic-review-report.md), verdict: proceed).
**Grounding:** the investigation in the M1 review + a dedicated read-only source pass (2026-09-07);
findings summarized inline. Governed by [AGENTS.md](../../AGENTS.md), [000](../000-vision.md),
[004](../004-decision-log.md), [005](../005-consumer-boundary-contract.md).

---

## 0. Decisions already made (inputs to this plan)

- **Go-ahead for 9b** given 2026-09-07.
- **S-1 mechanical-only boundary → option (a) narrow-and-diverge** (see [004](../004-decision-log.md),
  [011 §6 item 9](./011-m1-holistic-review-report.md)). 9b tightens the Traderton-owned config boundary
  to `decisionMode: ['mechanical']` and adds a live mechanical-only assertion.
- **M1 in-process before M2 REST** (000/005). The authoring order below reflects this: A–E land M1;
  F (REST) is sequenced last and may be its own sub-phase.
- **Traderton does not own human approvals** (2026-09-07, human-confirmed). The consumer owns the
  approval lifecycle (ask/hold/TTL/expiry/per-user); Traderton owns only `submit_decision` execution.
  The orphan `decision_approvals` table + repo were deleted (pre-9b cleanup). This shrinks item C
  (no approval branch) and removes any approval config from item A. See [004](../004-decision-log.md)
  + the `decision_approvals` Intentional Divergence row in [001](../001-parity-ledger.md).
- **Minimum-authoring re-scope** (2026-09-07, human-directed). Prefer copy-and-delete (incl. fused-file
  line-trims) wherever a faithful source exists; author only the irreducible residue; defer every
  *improvement* beyond herobids-parity out of 9b. Full classification in §1a.
- **maxBots = atomic** (2026-09-07, human-confirmed): reproduce herobids' atomic count+write, with the
  serialization lock re-keyed to `ownerId` via a Postgres advisory lock (Traderton has no `agents` row
  to lock). No blocker; this is the one small authored trading primitive (§7).
- **Async delivery = poll-first + opt-in register-once webhook** (2026-09-07, human-confirmed); the
  durable event log (Postgres+Redis) is an **improvement, tracked separately** in
  [014](./014-decision-response-and-event-model.md), NOT smuggled into 9b — see §1a "Improvements".
- **Item B composition-root decisions LOCKED** (2026-09-07, human-approved; full brief [015](./015-composition-root-proposal.md)):
  (a) scope = bot `TradingActor` only (agent-direct + registry → item C); (b) ports = inject `AppConfig`
  + `InstanceLoader`; (c) `idGen` = copy the herobids util verbatim; (d) `createStrategy` = mechanical/dca
  only + defensive throw (llm/hybrid already rejected by `BotConfigSchema` per A′; no new Gap). See §4.
- **Item C intake decisions LOCKED** (2026-09-07, human-approved; full design [017](./017-item-c-intake-proposal.md), §4 crux resolved):
  (a) **require a running `ExecutionActor`; DROP the grant-fallback** — no actor → `instance_not_running`
  (existing copied code); the `AgentIntakeResolver` grant-fallback + `ActorStateOwner` session wrapper are
  NOT copied (Intentional Divergence — it is the `agentConnections ⋈ connections` grant front-end, the
  same platform layer decisions 11–13 + the Phase-8 `resolveBotStartupContext` cut already placed
  consumer-side; legacy pre-actor path demoted 2026-06-14). (b) item B's factory owns the `actorRegistry`
  `Map<string, ExecutionActor>`; (c) item C constructs + registers the `AgentTradingActor` (lifecycle
  driver = item D). See §5.
- **Item D drive-path decisions LOCKED** (2026-09-07, human-approved; full design [020](./020-item-d-drive-and-tools-proposal.md)):
  (a) COPY `tools/bots.ts` + `tools/trading.ts` verbatim — `ctx.agentId`/`creatorType='agent'` is the M1
  ownership scope, bind the injected `ownerId` at the persistence seam (fallback (b) copy-and-adapt is a
  stop-gate path only); (D-i) author a 3-const `AGENT_MESSAGE_TYPES` (values verbatim, no source-fix);
  (i) add `WorkerRuntime.enqueueLifecycle`; item E stays separate behind a `botLimitCheck` seam; omit
  `BOT_QUERY` routing. The investigation reshaped item D: `handleManageBot` is NOT copyable (agent/grant/
  LLM shell — dropped); the authored handler traces only its trading core over the copied `WorkerRuntime`.
  See §6.

## 1. Governing invariants for every authored item (the 9b safety rules)

1. **Ports carry values, never trading behaviour.** Authored seams may inject only platform-owned
   *values* (resolved `venueAccountId`, grant validity, the `maxBots` limit decision, `ownerId`/`actor`,
   config values). The risk gate, planner, executors, reconciliation, and fill/position accounting are
   already-copied engine code and MUST NOT become injectable/overridable through any authored port.
2. **Author the seam, wire the copy.** Every authored file wires or injects into already-copied trading
   modules. Where a herobids file can be copied once its authored dependency exists, **copy it verbatim**
   rather than re-authoring it (e.g. the drive-path tools, the intake body logic).
3. **Delineate authored vs copied.** Maintain an explicit manifest (§9) of what was authored new vs
   copied/adapted, so the copy-never-author boundary stays auditable.
4. **Every authored divergence is logged.** Consequential divergences (per-owner maxBots reshape, the
   config-enum narrowing, `userId`→`ownerId` edits to copied route handlers) → Intentional Divergence
   rows in [001](../001-parity-ledger.md) + reasoning in [004](../004-decision-log.md). Stop-gate if a
   seam would need authored non-trivial *trading* logic beyond wiring (per 009 stop-gates).
5. **Green after every step.** Build + lint + copied/authored tests green after each un-quarantine.
6. **Minimum authoring.** Do not author anything a copy-and-delete (incl. fused-file line-trim) can
   produce. Do not build improvements beyond herobids-parity during 9b — record them, defer them.
7. **herobids as behavioural oracle.** For each truly-authored piece, use herobids as the reference
   (copied parity tests where they exist; the clone-and-hack-onto-Traderton A/B where they don't) so
   authored behaviour is verified against the real system, not against the author's assumptions.

## 1a. Classification — copy-and-delete vs truly-authored (the minimum-authoring map)

Every 9b item re-tested (2026-09-07, verified against herobids source) against four buckets:
- **COPY** — verbatim copy (modulo namespace), or copy + fused-file line-trim (the Phase-1 technique:
  delete platform lines in an interleaved file; diff-visible; copied tests are the oracle).
- **THIN SEAM** — a copied file with ONE small authored replacement where a platform dependency is cut
  (the sanctioned "author the seam" move; the rest of the file is copied).
- **AUTHORED** — genuinely authored; no faithful source subset exists. The irreducible creative surface.
- **IMPROVEMENT (deferred)** — beyond herobids-parity; NOT built in 9b; tracked separately.

| 9b item | Bucket | Why / evidence |
|---------|--------|----------------|
| **A. Config shape** (`AppConfigSchema`/`AppConfig` + `AgentRiskDefaultsSchema`) ✅ **DONE 2026-09-07** | **COPY (fused-file trim)** | herobids `AppConfigSchema` is one `z.object({…})` (schema.ts:1648) interleaving ~15 trading keys with ~20 platform keys + a platform `superRefine` — the SAME shape as the Phase-1 `config/schema.ts` monolith. Copy-and-delete = re-sync the object literal from source and delete the platform keys/`superRefine` in place. Re-opened the Phase-1 over-deletion; sub-schemas already present. **LANDED:** re-synced `AppConfigSchema`/`AppConfig` + `AgentRiskDefaultsSchema`/`AgentRiskDefaultsConfig`; un-quarantined `config.ts`+`config.test.ts` (loader trimmed of platform ENV_OVERRIDES/billing-guards; test trimmed to trading-only), `agent-risk-limits.*`, `public-stream-routing.*`. Build+lint green; 2231 tests pass (+100). Note: `candleFetch*` NOT brought across — the live loop takes those as injected deps (item B), not via config. **Not authoring** (except the deferred S-1 line, A′). |
| **A′. S-1 mechanical-only narrowing** ✅ **DONE 2026-09-07** | **AUTHORED (wrapper + test)** | Deliberate divergence (decision 3 / decision 2). **LANDED:** authored `MechanicalStrategySchema` (Traderton wrapper, `decisionMode: ['mechanical']`); re-pointed `BotConfigSchema.strategy` at it; copied `StrategySchema` left byte-verbatim (option a-i, wrapper). Dedicated authored test `config/mechanical-only.test.ts` (9 assertions) pins the guarantee. Build+lint green; 2240 tests pass (+9). Follow-up (item D): narrow the advertised `create_bot.config.strategy` tool-schema. |
| **A″. `config.ts` loader** | **COPY (fused-file trim)** | Copy the loader; delete the platform `ENV_OVERRIDES` entries + the `billing.primaryProvider` prod guard (line deletions, diff-visible). |
| **B. Composition root** (`createTradingRuntime` factory, **bot-lifecycle only**) | **AUTHORED** (decisions LOCKED — §4.1) | herobids `index.ts` (~3050 lines) constructs the trading actors *inside* deleted startup/session/intake wiring — no faithful trading subset (confirmed Phase 8). Wired modules all copied; wiring factory authored. **The largest genuinely-authored piece.** Scope = bot `TradingActor` only; agent-direct/registry/intake → item C; drive/tool-registry → item D; event producer → C2 (M1 no-op stubs); maxBots → E. Full brief + herobids trace: [015](./015-composition-root-proposal.md) + §4. Oracle: actor test files build the dep objects (template); herobids-clone A/B. |
| **C. Intake router + registry + AgentTradingActor wiring** ✅ **DONE 2026-09-07** (decisions LOCKED — §5) | **COPY (already, Phase 8) + AUTHORED wiring/seam + DROP** | Re-verified 2026-09-07 (post-investigation): the actor-owned intake (`AgentTradingActor.getIntakeDeps`/`getDecisionContext`/`getPosition`), `ExecutionActor`, `TradingActor`, `validate-trade-instrument`, `venue-instrument-cache` were **already COPIED in Phase 8** — C reuses them. C **authors** only wiring: a slim decision router (`submitDecision`), a plain `Map<string, ExecutionActor>` registry (owned by B's factory), the venue-account-direct resolver seam (injected `venueAccountId` + the venue-account guards), and `AgentTradingActor` construct+register. It **DROPS** (Intentional Divergence) the `AgentIntakeResolver` grant-fallback + `ActorStateOwner` — the `agentConnections ⋈ connections` grant front-end / agent-session wrapper, both platform (crux resolved = option (a); require a running actor else `instance_not_running`). Handler drops the platform paused/session/telegram/approval branches. |
| **D. Drive-path tools** (`bots.ts`, `trading.ts`) ✅ **DONE 2026-09-07** (decisions LOCKED — §6) | **COPY** (verbatim) | **LANDED:** both files copied verbatim (diff = `@herobids`→`@traderton` + the sanctioned `TradingToolContext`/`AgentTool<TradingToolContext>` convention only) + their herobids parity tests (9 + 25). `ctx.agentId`/`creatorType='agent'` scope untouched (decision (a); injected `ownerId` binds at the persistence seam). Platform broker NOT copied. Tools use only `DECISION_SUBMIT`+`MANAGE_BOT`. See §6.5. |
| **D-target. In-process drive target + bot-lifecycle handler + enqueue seam** ✅ **DONE 2026-09-07** | **AUTHORED (seam/wiring) + DROP** | **LANDED:** authored the 3-const `AGENT_MESSAGE_TYPES` (values verbatim); `createDriveTarget` `publishToInbound` (`DECISION_SUBMIT`→item C `submitDecision` + reply-write; `MANAGE_BOT`→handler; no `BOT_QUERY` route); `handleManageBot` **tracing `handleManageBot`'s trading core over the copied `WorkerRuntime`**; `WorkerRuntime.enqueueLifecycle`. **DROPPED** the agent-session + connection-grant + LLM-model-policy shell (platform, decisions 7–13). maxBots limit + create/start persist = one injected `BotLimitSeam` → item E (pre-E → `bot_limit_unavailable`). Build+lint green; 2303 tests. See §6.5. |
| **E. maxBots atomic** | **AUTHORED (thin primitive)** | herobids' atomic method row-locked the `agents` table; Traderton has none → re-key the lock to `ownerId` via a Postgres advisory lock inside the count+write txn. Small, isolated, testable authored primitive. Human-confirmed atomic. |
| **C2/G. Event producer — vocabulary + emitter** | **COPY** | The event envelope + per-event emitter methods (the trading subset, §ledger table) are clean and copyable (trading types). |
| **C2/G. Event producer — durable persistence + Redis relay (outbox)** | **IMPROVEMENT (deferred)** | herobids is Redis-Streams-window-only for outbound events (verified: `xadd MAXLEN ~`, no Postgres). Postgres+Redis durable outbox is an improvement BEYOND parity → tracked in [014](./014-decision-response-and-event-model.md), decided separately, NOT built inside 9b. At 9b-parity: reproduce the Redis-window emitter (copy-shaped). |
| **F. M2 REST adapter** | **AUTHORED** (+ COPY-adapt routes) | 005 is a fresh contract with no herobids equivalent (herobids uses JWT `request.userId`, not HMAC boundary) → the shell/auth/idempotency/deadline/dispatcher are authored. The trading route HANDLERS copy-adapt (`userId`→`ownerId`). Sequenced last (M2). |
| **F-routes. Agent-shaped routes** (`actor-health` = `/agents/:id/health`; `analytics` grouped by agent/session) | **HAND-BACK (Gap)** or boundary-inject | Some quarantined routes are inherently agent endpoints (verified: `agents`/`agentRuntimeSessions` refs). Decided route-by-route at F; agent-only ones stay herobids (signed-off Gap, not silent). |

**Net irreducible AUTHORED surface (the risk):** (1) the composition-root factory [B], (2) the intake
wiring [C] — the slim decision router, the `Map<string,ExecutionActor>` registry, the venue-account-direct
resolver seam, + `AgentTradingActor` construct/register (over the Phase-8-copied actor intake; the
grant-fallback is dropped, not authored), (3) the in-process drive target [D-target],
(4) the atomic maxBots primitive [E], (5) the S-1 one-liner [A′], and — only at M2 — (6) the REST
shell [F]. Everything else is copy-and-delete or copy. **Improvements (durable event outbox) are
deferred out of 9b entirely.** This is the honest, minimized creative surface.

## 2. Authoring order (dependency-correct)

```
A. Traderton-owned config shape            (unblocks _deferred-config/*)
      │
      ├─ S-1: mechanical-only narrowing     (rides on A — the Traderton config boundary)
      ▼
B. Trading composition root (factory)      (wires copied modules; needs A)
      ▼
C. Decision-intake surface (execution only) (venue-account-direct resolver; needs B; NO approvals)
      ▼
D. In-process drive target + 7 drive tools (needs C; then COPY bots.ts/trading.ts)
      ▼
E. Per-ownerId maxBots enforcement         (in the bot-lifecycle drive handler; needs D)
   ── end of M1 (in-process library consumable) ──
      ▼
F. M2 REST boundary adapter                (over the same ports; sequenced last)
```

A–E deliver **M1** (the in-process library is consumable + the full 25-tool surface lands).
F delivers **M2** (the REST adapter per 005). F is gated behind M1 landing green.

---

## 3. Item A — Traderton-owned config shape

**What it is.** A trading-only `AppConfigSchema`/`AppConfig` authored in `@traderton/domain`, composing
the trading sub-schemas already present there (`VenueConfigSchema`, `RiskPostureSchema`, `Reconciliation`,
`Stream`, `Marking`, `Backtesting`, `MarketData`, `LiveRollout`, etc.), plus an authored
`AgentRiskDefaultsSchema`/`AgentRiskDefaultsConfig` and the two `agentRuntime.candleFetch{Breaker,Retry}`
sub-schemas (field-for-field from herobids `AgentRuntimeConfigSchema`).

**Classification: COPY-AND-DELETE (fused-file trim), NOT authoring** (see §1a; corrected 2026-09-07).
herobids `AppConfigSchema` (schema.ts:1648) is a single `z.object({…})` interleaving trading + platform
keys + a platform `superRefine` — the same fused shape as the Phase-1 `config/schema.ts` monolith. The
copy-and-delete move: **re-sync the object literal verbatim from herobids source, then delete the
platform keys and the `superRefine` in place** (diff-visible line deletions; the copied config tests are
the oracle). This re-opens a Phase-1 over-deletion (Phase 1 removed `AppConfigSchema` wholesale as
platform; the sub-schemas it composes are already present in `@traderton/domain`). `AgentRiskDefaultsSchema`
+ the `agentRuntime.candleFetch*` sub-schemas are re-synced the same way. Nothing here is authored except
the S-1 narrowing (§3a).

**Copied once A lands (verbatim / near-verbatim):** the quarantined `_deferred-config/config.ts`
(loader), `public-stream-routing.ts`, `agent-risk-limits.ts` + their tests. `config.ts`'s `ENV_OVERRIDES`
map and the `billing.primaryProvider` production guard are platform → **pruned in place** (small authored
edit, logged as Intentional Divergence — the loader is otherwise a copy).

**Ports/invariant check.** Config is a value surface. Operator-vs-instance layering and immutable
user-configured limits (decision 3) preserved. No behaviour injected.

**Resolves / un-quarantines.** The Phase-8 config-shape `Deferred (required for cutover)` entry;
un-quarantines `_deferred-config/{config,config.test,agent-risk-limits,agent-risk-limits.test,
agent-risk-limits.parity.test,public-stream-routing,public-stream-routing.test}`.

**RESOLVED (2026-09-07):** the `agentApprovals` config block (`ttlMs`, `resolveRateLimitPerMinute`) is
**NOT carried** — the human-approval lifecycle is consumer-owned (see item C + [004](../004-decision-log.md)
"Why Traderton does not own human approvals"). Item A authors no approval config.

### 3a. Item A′ — S-1 mechanical-only narrowing (rides on A)

Narrow the Traderton-owned strategy config boundary so `decisionMode` accepts only `['mechanical']`
(option (a)). Two candidate shapes — **pick at implement time, whichever avoids editing the verbatim
copied `StrategySchema` in a way that breaks 1:1 diffability**:
- **(a-i) Traderton wrapper:** keep the copied `StrategySchema` as-is; the Traderton `BotConfigSchema`
  path validates through a `MechanicalStrategySchema = StrategySchema.extend({ decisionMode: z.enum(['mechanical']).optional() })`-style wrapper. Cleanest for diffability (copied file untouched).
- **(a-ii) In-place narrow:** edit the copied `StrategySchema.decisionMode` enum + its acceptance test.
  Simpler surface, but edits a verbatim copy (Intentional Divergence on that file).
Recommend **(a-i)** (wrapper) to keep the copied schema verbatim. Add a **live mechanical-only assertion**
(a unit test + a runtime guard at bot config validation) so the guarantee is explicit, not inherited.
Log the divergence in [001](../001-parity-ledger.md) (mechanical-only row) — already pre-recorded.

---

## 4. Item B — Trading composition root ✅ DONE 2026-09-07 (commit 5834402)

**Landed:** `createTradingRuntime` factory (`packages/worker/src/composition/create-trading-runtime.ts`)
+ relocated `id-gen.ts` + `bin/worker.ts` + authored smoke test + worker barrel export. Bot-lifecycle
scope only (per §4.1a); wiring-only over copied modules; live-gate + market-data recorder wired;
status callbacks are M1 no-op stubs. Reviewed (no critical/high). Build green, lint clean, 2244 tests
pass (+4 smoke). **Outstanding (recorded, not silent):** swap-venue token-safety gating is
`Deferred (required for cutover — swap bots only)` — `swapTokenSafety: undefined` + the paired 1inch
`swapNetwork` fail-closed guard dropped, both blocked on the uncopied `enrichTokenWithDiscovery`; see
[001](../001-parity-ledger.md) + [003](../003-anomalies-and-deviations.md). Exclusions (§4.5) all
routed to their owning items (C/D/C2/E/F) — none authored here.

**Full design + evidence: [015-composition-root-proposal.md](./015-composition-root-proposal.md)
(APPROVED 2026-09-07).** This section is the self-contained implementer brief; 015 carries the
line-by-line herobids trace and the dep-field maps. An implementer should not need this chat — read
this §4 + 015 + the cited copied modules.

**What it is.** An authored `createTradingRuntime(ports)` **factory** (not a top-level script) that
wires the ALREADY-COPIED trading modules into a runnable **bot-lifecycle** runtime. Authored = wiring
only; every trading primitive is already copied and is not re-implemented or overridden.

**Why authored.** herobids `apps/worker/src/index.ts` (~3050 lines) is platform-fused and constructs the
trading actors inside deleted startup/session/intake wiring — no faithful trading-only subset exists
(confirmed Phase 8). The modules it wires are all copied into `@traderton/*`; only the wiring is authored.

### 4.1 Approved decisions (2026-09-07, human — these are LOCKED, not open)

- **(a) Scope = bot `TradingActor` ONLY.** B builds the bot-lifecycle runtime. The `AgentTradingActor`
  (agent-direct) + its `actorRegistry` decision-routing are **excluded → item C** (they need the intake
  surface). `TradingActor` implements `InstanceActor` (the clean `WorkerRuntime` fit); `AgentTradingActor`
  implements `ExecutionActor` and is out of scope here.
- **(b) Ports = inject `AppConfig` + `InstanceLoader`.** The factory receives the whole Traderton-owned
  `AppConfig` (item A) + `redis` + an `instanceLoader` callback (the consumer's running-bot loader). Reuse
  the copied `WorkerRuntime` types; no new bespoke port surface.
- **(c) `idGen` = copy the herobids id-gen util verbatim** (it is trading scaffolding — a UUIDv7 generator
  with `planId()`/`decisionId()`). Locate the discrete herobids source file and copy it; do NOT author a
  new one. If no discrete file exists, STOP and surface it (do not hand-author an id scheme).
- **(d) `createStrategy` = mechanical/dca ONLY + defensive `throw`.** `LlmStrategy`/`HybridStrategy` are
  absent from `@traderton/strategy` (correct — mechanical-only, decisions 7–9). `BotConfigSchema` (item
  A′) already rejects `llm`/`hybrid` upstream, so those branches are unreachable via a valid bot config;
  the authored `createStrategy` handles `dca` + `mechanical` and throws on anything else (belt-and-braces).
  This is covered by the existing mechanical-only Intentional Divergence — **no new Gap/ledger row**, just
  a cross-reference.

### 4.2 Construction recipe (authored, from copied modules — see 015 §2.1 for herobids line refs)

Singletons, once: `createDatabase(config.database.url)` → 8 trading repos + `PgJournal`; `idGen` (4.1c);
`createProviderRegistry(config.marketData)` (optional) → scanner infra (`TokenBucketRateLimiter` ×2 +
`createScannerCandleFetcher` + `CandleFetchBreaker`); mark sources (`OracleMarkSource` +
`HyperliquidMarkSource` + `MarkSelector` composite fallback); `PublicStreamPool` via
`buildPublicStreamConnectors(config.venues)`; `VenueAdapterFactory({db, journal, venues, streamConfig})`;
`InstanceLease(redis, workerId)`; then `new WorkerRuntime(cfg, actorFactory, instanceLoader, lease)`.

### 4.3 Per-bot `ActorFactory` closure (the crux — traced to herobids index.ts:1878–2249)

`async (botId, rawConfig) => TradingActor`:
1. `BotConfigSchema.safeParse(rawConfig)` — now the mechanical-only schema (A′); throws on llm/hybrid.
2. Read the **injected `venueAccountId`** from the parsed config — NOT `resolveBotStartupContext` (that
   platform grant front-end was deleted Phase 8; venueAccountId is injected per decisions 11–13).
3. `venueAdapterFactory.buildOrderbookAdapter(...)` / `buildSwapAdapter(...)` — credential decrypt via the
   retained `venue_accounts`/`user_credentials` tables + `CREDENTIAL_ENCRYPTION_KEY` (copied factory does this).
4. `createStrategy(config.strategy, candleFetcher)` — mechanical/dca (4.1d).
5. `riskLimits` built INLINE from `config.risk` (bots do this; agents use `buildAgentRiskLimits` — not here).
6. per-bot `createFillFirstMarkSource({ actorId: botId, fallbackSource: markSelector, fillLookup: fillRepo })`.
7. scoped `streamPool` (orderbook) / undefined (swap).
8. assemble `TradingActorDeps` (operator-config fields from `config`) + `new TradingActor(botId, config.strategy.params, deps)`.

### 4.4 Injected vs constructed
- **Injected (consumer supplies):** `AppConfig`, `redis`, `instanceLoader` (running bots, each config
  carrying the resolved `venueAccountId` + soft `ownerId`).
- **Constructed internally:** everything in 4.2 (all copied modules).
- **Ports/invariant check:** the factory takes config **values** + a bot **loader** (data) + injects the
  `venueAccountId` (value) per bot. No port injects risk/planner/executor behaviour — those are
  engine-owned and not overridable. ✓

### 4.5 Exclusions — what B does NOT include, and where each goes

| Excluded from B | Deferred to | Note |
|-----------------|-------------|------|
| `AgentTradingActor` + `actorRegistry` decision routing | **item C (intake)** | needs the venue-account-direct resolver |
| `submitDecision` intake / decision handler | **item C** | B exposes the seams; C attaches |
| Who publishes lifecycle jobs / in-process `publishToInbound` | **item D (drive)** | B builds the BullMQ *consumer* side (`WorkerRuntime`); D is the producer |
| `onJournalEvent` / `emitAgentWake` / status publishes (`onStarted`/`onStopped`/`onStartFailed`/`onCrashed`/`onHalted` bodies) | **item C2 (event producer)** | M1 default = **no-op stubs**; keep `onCrashed → runtime.handleActorCrash(botId)` |
| per-`ownerId` maxBots enforcement | **item E** | — |
| M2 REST boundary | **item F** | — |
| the advertised `create_bot.config.strategy` JSON tool-schema narrowing | **item D** | flagged in item A′ follow-up |

B exposes the constructed `WorkerRuntime` + singletons on its return value so C/D/C2 attach without
re-opening B. **Note (correction of an earlier draft):** the `createToolRegistry`/`assertToolCatalogMatchesRegistry`
tool-registry composition and `ActorStateOwner` are NOT part of B — the tool registry belongs with the
tool surface (item D) and `ActorStateOwner` with the agent-direct/intake path (item C). B is the
bot-lifecycle runtime only.

### 4.6 Verification plan (no copy oracle — how B is validated)
- Build + lint green; existing **2240 copied tests stay green** (B adds a surface, changes no module).
- **Authored smoke test (clearly labeled, not a copied oracle):** `createTradingRuntime` with a
  paper/in-memory config + stub `instanceLoader` returns a `TradingRuntime`; `start()`/`shutdown()` are
  clean; a paper bot config rehydrates into a `TradingActor` that ticks.
- **herobids-as-oracle:** 4.3 is traced line-for-line to `index.ts:1878–2249` (see 015); review the
  authored closure against that reference. Optional deeper check: clone-herobids2-and-drive-Traderton A/B.

**Resolves / un-quarantines.** The Trading-loop "assembled runtime / composition `Deferred (required for
cutover)`" row; makes `@traderton/worker` consumable through its barrel (review §7 caveat).

**Shape decision (resolved):** a factory (`createTradingRuntime`) + a tiny bin entry that calls it — the
factory is what M1 (herobids in-process) and M2 (REST) both drive ("same ports, two adapters").

---

## 5. Item C — Decision-intake surface (execution only; NO approvals) ✅ DONE 2026-09-07

**Landed.** Files: `packages/worker/src/composition/decision-intake.ts` (AUTHORED — the `submitDecision`
router + the `DecisionSubmitInput`/`DecisionSubmitResult` value types + the venue-account-direct seam +
`constructAndRegisterAgentActor`/`stopAndDeregisterAgentActor`); `packages/worker/src/composition/create-trading-runtime.ts`
(extended item B's factory to own the one `actorRegistry` + expose `registerActor`/`deregisterActor`/
`submitDecision`/agent-actor construct+stop, and to register bots in the map); `packages/worker/src/index.ts`
(barrel exports for item D); `packages/worker/src/composition/decision-intake.test.ts` (AUTHORED test, 8
assertions). Build green, lint clean, **2252 tests / 15 skipped / 0 failed** (+8 authored; no copied test
altered). **Gap-fix follow-up (2026-09-07):** `VenueInstrumentCache` wired through the agent construct (see
the WIRED-COPIED manifest entry + the resolved HIGH in Outstanding Issues); +1 authored assertion →
**2253 tests / 15 skipped / 0 failed**.

**Authored-vs-copied-vs-dropped manifest (what was actually written):**
- **AUTHORED (wiring):** the `submitDecision` router; the `actorRegistry` map + register/deregister hooks
  (owned by B's factory, decision (b)); the `DecisionSubmitInput` value type (herobids' `MessageEnvelope`/
  `DecisionSubmitPayload` are platform agent-protocol types dropped in Phase 1 — NOT in `@traderton/domain`
  — so the handler takes a Traderton-owned decision **value** carrying only the fields it maps into the
  engine `Decision`); `constructAndRegisterAgentActor` + `stopAndDeregisterAgentActor` (decision (c)).
- **THIN SEAM (authored):** venue-account-direct — the injected `venueAccountId` flows through the actor's
  own `intake.venueAccountId`; item C validates only that it is non-empty at construct. The venue-account-
  EXISTENCE guard is the actor's `start()` via `venueAdapterFactory` (throws `CredentialResolutionError`).
  The herobids `missing_source_venue_account`/`source_venue_account_not_found` codes lived in the deleted
  `startup-context.ts` (the connection-grant front-end cut in Phase 8) — **no parallel grant resolver
  authored** (confirmed the actor already carries the seam, per the §5 instruction).
- **WIRED-COPIED — `VenueInstrumentCache` / `instrument_unknown` (2026-09-07, gap-fix follow-up).** The
  copied agent intake gates its venue-specific instrument validation behind
  `if (this.deps.instrumentCache?.isReady())` (`agent-trading-actor.ts:~886`), rejecting `instrument_unknown`
  — a **KEEP behaviour** of the copied intake. A gap-focused review found `VenueInstrumentCache` was never
  constructed/wired in the composition root and `constructAndRegisterAgentActor` had no attachment point,
  so the dep was permanently `undefined` and the rejection silently **failed open** for every agent
  decision. **Now wired (pure copied-module WIRING, no authored trading logic):** item B's factory
  constructs the cache once (herobids `index.ts:797`), builds `VenueSymbolProvider[]` from the configured
  venues using the copied `HyperliquidAdapter`+`normalizeHyperliquidSymbol`, `BybitAdapter`+`normalizeBybitSymbol`,
  `JupiterSwapAdapter`+`identityNormalize` (herobids `index.ts:1684–1733`; **1inch intentionally skipped** —
  its `fetchAvailableSymbols()` is a curated list, verbatim rationale preserved), and calls
  `warmup(providers)` then `startPeriodicRefresh(providers, 60·60·1000)` in `start()` (herobids
  `index.ts:1743–1744`; warmup is fail-open by design). `constructAndRegisterAgentActor` gained an
  `instrumentCache` attachment point on `AgentActorRuntimeDeps` and threads it — plus `oneInchConfig`
  (`config.venues['1inch']`), `canonicalTokens` (`config.marketData?.tokenSafety?.canonicalTokens`), and
  `perTradeLevelMonitorIntervalMs` (`config.agentRiskDefaults.perTradeLevelMonitorIntervalMs`) — into the
  actor's deps (herobids `index.ts:1273–1279`). `bindingProfile` (herobids `index.ts:1275`) is **NOT wired**:
  it is an agent-binding value, not Traderton config, so it stays the actor's optional-undefined default.
  Bots (`TradingActor`) do NOT receive the cache — agent-construct-specific, matching herobids. An authored
  deterministic assertion in `decision-intake.test.ts` (constructor spy; never-warmed cache, no network)
  confirms the constructed actor now receives a defined `instrumentCache`.
- **COPIED (Phase 8/3, reused unchanged):** `ExecutionActor`/`IntakeResult`/`isIntakeRejection`, the
  actor-owned intake (`AgentTradingActor.getIntakeDeps`/`getDecisionContext`/`getPosition`), `TradingActor`,
  `AgentTradingActorDeps`, `buildAgentRiskLimits`, `createFillFirstMarkSource`, engine
  `submitDecisionForExecution`/`validatePerTradeLevels`/`DecisionContextHashMismatchError`, `POSITION_GROWING_INTENTS`/
  `formatLevelValidationMessage`.
- **DROPPED (Intentional Divergence / routed elsewhere):** the paused/stale-session gates (platform);
  the entire `approval_required`/short-code/Telegram/pending-approval block (consumer-owned); all
  `InstanceEventPublisher` emits + `decisionFailureRepo` side-channels (→ item C2, M1 no-op); the
  grant-fallback arms of the composite resolver (kept only `actor?.isRunning` — decision (a)).

**Surfaced seams / dropped behaviour (non-CRITICAL):**
- The `updateRiskLimits` runtime-refresh (herobids `index.ts:820–831`) that read `agentRepo.getAgent` is
  **DROPPED for M1** — its source is the platform `agents` table. The actor's `updateRiskLimits` hook is
  preserved, so a future refresh can be fed from injected values without re-opening the seam.
- The herobids per-instrument **handler-side circuit-breaker failure counters** (`no_context` /
  `swap.instrument_format` thresholds, `checkCircuitBreaker`) are dropped — the rejection is kept typed
  and simple. The actor's OWN `VenueCircuitBreaker` (`circuit_breaker_open`, surfaced via `getIntakeDeps`)
  is preserved. The `no_context` "still initializing" nuance (`actorsWithSuccessfulContext`) is likewise
  dropped (it fed the dropped breaker); `no_context` stays `retryable: true`.
- The herobids `risk.daily_max_loss_exceeded` **message enrichment** (the "New positions are blocked till
  <ISO>" suffix computed from `intakeDeps.dailyLossTracker.oldestEntryMs`, `agent-decision-handler.ts`) is
  **DROPPED for M1** — the authored router surfaces `riskError.message` unchanged. This is **message-only /
  behaviour-preserving**: the risk *decision* (reject) is identical; only the human-facing hint text is
  simpler. Surfaced by CodeReviewer (LOW-1). Can be re-added later from the intake deps without re-opening
  a seam. Recorded here for divergence-ledger completeness (not a silent drop).

**Outstanding Issues (CodeReviewer, 2026-09-07 — no CRITICAL/HIGH; verdict PASS):**
- **[item C] HIGH — `VenueInstrumentCache` unwired → `instrument_unknown` failed open. RESOLVED
  (2026-09-07, gap-fix follow-up).** Surfaced by a later gap-focused review, not the original CodeReviewer
  pass. The cache was never constructed/wired and `constructAndRegisterAgentActor` had no attachment point,
  so the copied `instrument_unknown` rejection silently failed open for every agent decision — a degraded
  copied behaviour. **Fixed by pure copied-module WIRING** (construct cache + build providers + warmup/refresh
  in item B's factory; thread `instrumentCache`/`oneInchConfig`/`canonicalTokens`/`perTradeLevelMonitorIntervalMs`
  into the agent actor). See the WIRED-COPIED manifest entry above. Build green, lint clean, 2253 tests pass
  / 15 skipped / 0 failed (+1 authored assertion).
- **[item C] LOW-1 — `risk.daily_max_loss_exceeded` message enrichment dropped.** Recorded above (dropped-
  behaviour list) — message-only, behaviour-preserving. No code change required for M1.
- **[item C] LOW-2 — `agentActorRuntimeDeps` assembled eagerly** in `create-trading-runtime.ts` even in a
  bot-only process. Harmless (a plain object of already-built singletons); optional readability comment
  only. No action required.

---

### (Original plan below — retained for the record.)

## 5x. Item C — Decision-intake surface (execution only; NO approvals)

> **Scope narrowed (2026-09-07, human-confirmed): Traderton does not own human approvals.** The
> consumer decides whether a decision needs a human, asks the human, holds the pending approval
> (TTL/short-code/expiry/per-user), and on approval calls `submit_decision`. Traderton owns only
> decision **execution**. See [004](../004-decision-log.md) "Why Traderton does not own human
> approvals" + the `decision_approvals` Intentional Divergence row in [001](../001-parity-ledger.md).
> The `decision_approvals` table + repo were an orphan in Traderton and were **deleted** (pre-9b
> cleanup, 2026-09-07). Item C therefore has **no** `ApprovalService`, no `authorizationMode` fork,
> no approval config.

**Full design + evidence: [017-item-c-intake-proposal.md](./017-item-c-intake-proposal.md) (APPROVED
2026-09-07; §4 crux resolved).** This §5 is the self-contained implementer brief; an implementer works
from §5 + 017 + the cited copied modules, not this chat.

### 5.1 Locked decisions (2026-09-07, human — do not re-litigate)

- **(a) Require a running actor; DROP the grant-fallback.** Traderton accepts a decision only for a
  **registered, running `ExecutionActor`**; no actor → `instance_not_running` (an existing copied
  rejection code in `execution-actor.ts`). The herobids `AgentIntakeResolver` grant-fallback and the
  `ActorStateOwner` session wrapper are **NOT copied** (Intentional Divergence — see 001 + 003). Rationale:
  (i) the grant-fallback is the *legacy pre-actor* agent-direct path, demoted to a paper-only fallback
  when the actor concept landed (herobids 2026-06-14); (ii) it IS the connection-grant front-end —
  `resolveActiveBinding` resolves `venueAccountId` from `agentConnections ⋈ connections` (a "binding" =
  the agent↔connection grant), the exact layer decisions 11–13 + the Phase-8 `resolveBotStartupContext`
  cut already placed **consumer-side**. "Agent with no binding" = a consumer-side grant state; Traderton
  has no injected `venueAccountId` to execute against → reject. Not a dropped trading capability; the same
  seam already cut for bots, applied to the agent-direct path.
- **(b) Item B's factory owns the `actorRegistry`** (`Map<string, ExecutionActor>`) and passes it to the
  intake handler + exposes register/deregister — B and C compose over one map.
- **(c) Item C constructs + registers the `AgentTradingActor`** (deferred from B per §4.5a). Its start/stop
  **lifecycle driver** is item D / the M1 consumer — C authors construct+register + exposes the hook.

### 5.2 What it is (the clean Traderton intake)

An authored **thin decision router + a plain `Map<string, ExecutionActor>` registry** over the
**already-copied actor-owned intake** (Phase 8 copied `execution-actor.ts` [`ExecutionActor`/`IntakeResult`/
`isIntakeRejection`], `AgentTradingActor` [with its own `getIntakeDeps`/`getDecisionContext`/`getPosition`],
`TradingActor`, `validate-trade-instrument.ts`, `venue-instrument-cache.ts`):
- **Authored slim decision handler** `submitDecision(decision)`: registry lookup of the target
  `ExecutionActor` → `actor.getIntakeDeps(instrumentId)` (rejection → typed failure) →
  `actor.getDecisionContext` → `actor.getPosition` → build `Decision` → `validatePerTradeLevels` →
  `submitDecisionForExecution(...)` → `actor.recordExecutionOutcome`. Drops the herobids
  paused/active-session gates, the `approval_required` fork, and Telegram/pending-approval (platform /
  consumer-owned).
- **Authored `actorRegistry`** — a plain `Map<string, ExecutionActor>` (NOT `ActorStateOwner`, which is
  agent-session machinery). Owned by item B's factory (§5.1b); actors register on start, deregister on
  stop/crash.
- **Authored venue-account-direct resolver seam** — validates the injected `venueAccountId` + the
  venue-account-existence guards Traderton owns (`missing_source_venue_account`,
  `source_venue_account_not_found`); replaces `resolveActiveBinding`'s grant join. Never resolves
  connection grants (consumer-side).
- **Authored `AgentTradingActor` construction + registration** — build its deps from the item-B singletons
  + `buildAgentRiskLimits` + a per-actor `createFillFirstMarkSource`; register in `actorRegistry`.

### 5.3 Copied vs authored (manifest — full table in 017 §5)
- **Already COPIED (Phase 8, reused):** the `ExecutionActor` contract, actor-owned intake
  (`AgentTradingActor.getIntakeDeps/...`), `validate-trade-instrument`, `venue-instrument-cache`, engine
  `submitDecisionForExecution`/`validatePerTradeLevels`/`DecisionContextHashMismatchError`,
  `buildAgentRiskLimits`, the trading repos.
- **AUTHORED (wiring/seam):** the slim decision handler, the `actorRegistry` map, the venue-account-direct
  resolver seam, `AgentTradingActor` construct+register.
- **DROPPED (Intentional Divergence):** `AgentIntakeResolver` grant-fallback + `ActorStateOwner` session
  wrapper (connection-grant front-end + agent session lifecycle — platform).

**Ports/invariant check.** The handler routes a decision **value** to the actor-owned intake + drives the
engine; the registry holds actor references; the resolver receives an injected `venueAccountId`. No port
injects risk/planner/executor behaviour. ✓

### 5.4 Verification (authored — no copy oracle)
Build/lint green; existing 2244 tests stay green. Authored handler test (labelled): a registered stub
`ExecutionActor` receives a routed decision → handler drives `submitDecisionForExecution`; an unregistered
actor → `instance_not_running`; a `validatePerTradeLevels` failure → typed rejection. Trace the handler's
path to herobids `agent-decision-handler.ts` (the non-approval branch) for reviewability.

**Resolves.** `submit_decision` intake **execution** surface (`Deferred (required for cutover)`). The
approval half + the grant-fallback are consumer-owned (Intentional Divergence), not Traderton obligations.

---

## 6. Item D — In-process drive target + the 7 drive-path tools

> **Reshaped by investigation (2026-09-07): the two tool files copy cleanly, but `handleManageBot` is
> NOT copyable.** herobids' `handleManageBot` (`agent-message-broker.ts:552–…`) is the agent-session +
> connection-grant + LLM-model-policy layer — the exact platform surface already cut consumer-side
> (decisions 11–13 / 7–9). So the authored bot-lifecycle handler is **thin wiring that traces
> `handleManageBot`'s trading core over the already-copied `WorkerRuntime`**, dropping the platform shell —
> NOT a copy of `handleManageBot`.

**Full design + evidence: [020-item-d-drive-and-tools-proposal.md](./020-item-d-drive-and-tools-proposal.md)
(APPROVED 2026-09-07; §4 crux resolved).** This §6 is the self-contained implementer brief; an implementer
works from §6 + 020 + the cited copied modules + herobids traces, not this chat.

### 6.1 Locked decisions (2026-09-07, human — do not re-litigate)
- **(a) COPY the tools verbatim; `ctx.agentId`/`creatorType='agent'` is the M1 ownership scope.** Copy
  `tools/bots.ts` + `tools/trading.ts` byte-faithfully (modulo namespace). Do **not** edit them to re-key
  ownership to `ownerId`; the injected `ownerId` is bound at the persistence/creation seam (where B/C
  already bind it). **Fallback (b)** (copy-and-adapt to an `ownerId`-scoped lookup → logged Intentional
  Divergence) is a **stop-gate path** only if the copied `getBotsByCreator('agent', ctx.agentId)` scope
  proves insufficient to isolate one owner's bots at M1 — surface it, don't pre-emptively diverge.
- **(D-i) Author a 3-constant Traderton `AGENT_MESSAGE_TYPES`** (`DECISION_SUBMIT`, `MANAGE_BOT`,
  `BOT_QUERY`), string values **copied verbatim** from herobids (mirrors the copy). No herobids source-fix.
  The tools reference only `DECISION_SUBMIT` + `MANAGE_BOT` (confirmed); if a copied body references more →
  stop-gate (§10).
- **(i) Add a thin `WorkerRuntime.enqueueLifecycle(command, botId, config?)`** public entry over the queue
  the runtime already owns; the bot-lifecycle handler does not touch BullMQ directly.
- **E stays separate** — D authors the bot-lifecycle handler with the maxBots **call-site seam** present
  (a `botLimitCheck`-shaped hook); item E fills it with per-`ownerId` atomic enforcement.
- **Omit `BOT_QUERY` routing** — neither copied tool emits it; the drive target authors no `BOT_QUERY`
  route (no dead stub); the constant exists only for vocabulary fidelity.

### 6.2 What it is (the clean Traderton drive path)
- **Authored `AGENT_MESSAGE_TYPES`** (3 consts, values verbatim). Absent since Phase 1 deleted
  `agent-protocol.ts`.
- **Authored in-process `publishToInbound` drive target** (the `TradingToolContext.publishToInbound`
  port) — the in-process expression of herobids' Redis-stream hop (`agent.ts:1229` `xadd` →
  `agent-message-broker.processInbound` :140/:277). Dispatches by `type`:
  - `DECISION_SUBMIT` → adapt the tool payload → item C `submitDecision(input)` → JSON-write the typed
    result to `agent:decision:reply:${decisionId}` (what `trading.ts`'s `blpop(replyKey, 30)` awaits).
    Traces broker route :277–283 + the item-C result shape.
  - `MANAGE_BOT` → the authored bot-lifecycle handler (§6.3).
- **Authored bot-lifecycle handler** — `handleManageBot(payload)` for
  `create_and_start`/`start`/`stop`/`restart`(=stop+start)/`adjust_config`. Traces the **trading core** of
  herobids `handleManageBot` (`:552–…`): `BotConfigSchema.safeParse` (copied) → `checkModeEscalation`
  (copied) → item-E limit seam → persist/update via `botRepo` → **`enqueueLifecycle`** a `WorkerRuntime`
  job. venue/venueType/venueAccountId are **injected**; ownership validated by the injected `ownerId`.
  **DROPS** the agent/session/grant/LLM-policy shell (`agentRepo.getAgent`/`getActiveSession`, the
  connection-grant descriptor + `getResolvedVenueAccount`/`isConnectionOwnedBy`, `resolveEffectiveLlmSelection`/
  `getUserAiModelConfig`, `applyAgentCapitalLimit`, `emitInstanceStatus`) — all platform / consumer-owned.
- **Authored `WorkerRuntime.enqueueLifecycle`** — one public entry over the copied lifecycle queue.
- **COPY `tools/trading.ts` + `tools/bots.ts` verbatim** — bind to `TradingToolContext` (all fields
  present). `submit_decision`'s `pending_approval` reply branch is kept byte-faithful though unreachable
  (approvals dropped in C) — NOT authored away.

### 6.3 Copied vs authored (manifest — full table in 020 §5)
- **COPY (verbatim, modulo namespace):** `tools/trading.ts`, `tools/bots.ts` (deps present:
  `convertZodToJsonSchema`, `checkModeEscalation`, `deriveStrategyPreset`, `extractStrategyFromConfig`,
  `TradingToolContext`/`AgentTool`/`ToolResult`); the copied parity tests for both files (the oracle) if
  trading-clean.
- **AUTHORED (seam/wiring):** the 3-const `AGENT_MESSAGE_TYPES` (values verbatim); the in-process
  `publishToInbound` drive target; the bot-lifecycle handler (traces `handleManageBot` trading core); the
  `submit_decision` reply-write; `WorkerRuntime.enqueueLifecycle`.
- **DROPPED (Intentional Divergence):** the `handleManageBot` agent-session + connection-grant +
  LLM-model-policy shell (platform, decisions 7–13); `emitInstanceStatus` managed-bot notifications
  (→ item C2, M1 no-op).

**Ports/invariant check.** The drive path carries a decision/command **value** to Traderton's owned intake
+ bot lifecycle; the handler drives the copied `WorkerRuntime`; no port injects planning/risk/execution. ✓

### 6.4 Verification (authored seam + copied tools)
Build/lint green; existing suite stays green (currently 2253 passed / 15 skipped). Bring across the
herobids `tools/bots.test.ts` + `tools/trading.test.ts` if trading-clean (the copy oracle). Authored
drive-target/handler test (labelled): `MANAGE_BOT:create_and_start` → validates config + `enqueueLifecycle`
(stub runtime); `DECISION_SUBMIT` → routes to a stub `submitDecision` + writes the reply key; ownership
rejection on a foreign `creatorId`. Trace the handler to herobids `handleManageBot` trading core +
`processInbound` for reviewability.

**Resolves / un-quarantines.** The 7 drive-path tool rows (`submit_decision`, `create_bot`, `start_bot`,
`stop_bot`, `list_bots`, `get_bot_status`, `adjust_bot_config`); un-quarantines
`_deferred-config/validate-trade-instrument.test.ts` (needs `tools/trading.ts`) and, after S-2/S-3
reconciliation, `_deferred-authoring/schema.test.ts`. The per-`ownerId` maxBots enforcement behind the
seam is **item E**.

### 6.5 LANDED — item D DONE (2026-09-07)
**Files.** AUTHORED: `packages/domain/src/trading/agent-message-types.ts` (3-const `AGENT_MESSAGE_TYPES`,
string values verbatim from herobids `agent-protocol.ts` — `agent.decision.submit`/`agent.manage_bot`/
`agent.bot.query`) + domain barrel; `packages/worker/src/composition/drive-target.ts` (`createDriveTarget`
`publishToInbound` + `handleManageBot` tracing the trading core); `packages/worker/src/runtime.ts` thin
`enqueueLifecycle(command, botId, config?)`; `create-trading-runtime.ts` exposes `enqueueLifecycle` +
`createDriveTarget(injection)` + a `BotRepository` singleton on `TradingRuntime`; `worker/src/index.ts`
barrel; `composition/drive-target.test.ts` (16 authored cases). COPIED verbatim (modulo `@herobids`→
`@traderton` + the sanctioned `TradingToolContext`/`AgentTool<TradingToolContext>` convention):
`tools/trading.ts`, `tools/bots.ts` + their herobids parity tests (`bots.test.ts` 9, `trading.test.ts` 25).
Build+lint green; **2303 tests / 15 skipped / 0 failed** (+50; no copied test altered).

**Authored-vs-copied-vs-dropped manifest.**
- **COPY (verbatim):** `tools/trading.ts`, `tools/bots.ts` + both parity tests. `ctx.agentId`/
  `creatorType='agent'` scope untouched (decision (a)); the unreachable `pending_approval` branch kept
  byte-faithful.
- **AUTHORED (seam/wiring):** the 3-const `AGENT_MESSAGE_TYPES` (values verbatim); the `publishToInbound`
  drive target (`DECISION_SUBMIT`→item C `submitDecision` + `lpush`/`expire` reply write matching
  `trading.ts`'s `blpop`; `MANAGE_BOT`→handler; no `BOT_QUERY` route); `handleManageBot` tracing the
  herobids trading core over the copied `WorkerRuntime`; `WorkerRuntime.enqueueLifecycle`.
- **DROPPED (Intentional Divergence — platform/consumer-owned, decisions 7–13):** the `handleManageBot`
  agent-session shell (`agentRepo.getAgent`/`getActiveSession`), connection-grant resolution
  (`getRuntimeCapabilityDescriptor`/`getResolvedVenueAccount`/`isConnectionOwnedBy`), LLM-model policy
  (`resolveEffectiveLlmSelection`/`getUserAiModelConfig`), `applyAgentCapitalLimit`, `emitInstanceStatus`
  (→ item C2, M1 no-op). venue/venueType/venueAccountId/ownerId injected; ownership by injected `ownerId`.

**Surfaced seams (refine 021, carried to item E — nothing silently dropped).**
- **create/start persist+limit is ONE item-E seam.** `@traderton/db` `BotRepository` has no bot-insert
  (deleted Phase 2 — it was the agents-row-lock limit primitive = item E). herobids' create/start did an
  atomic count+insert (`tryCreateBotWithLimit`) / count+mark (`tryMarkBotRunningWithLimit`). So D exposes
  an injected optional `BotLimitSeam` (those two method shapes) and authors only its SHAPE + wiring — never
  the limit or the insert. Pre-E (seam absent) → `create_and_start` + non-reclaim `start` return
  `bot_limit_unavailable`; reclaim-start/stop/adjust_config are fully live. Not a degradation (herobids
  always ran with the limit wired). **Item E acceptance line:** E must also claim the DB running-slot on
  `create_and_start` (mirror herobids broker :738) so the persisted bot reads `running` (CodeReviewer
  MEDIUM-2).
- **`_deferred-config/validate-trade-instrument.test.ts` NOT un-quarantined.** Its `tools/trading.ts` dep
  is now satisfied, but it also imports the dropped platform `DecisionSubmitPayloadSchema` (agent-protocol,
  Phase 1). Left quarantined + surfaced (do not author the dropped schema or edit the copy).

**Outstanding Issues (CodeReviewer, 2026-09-07 — no CRITICAL/HIGH; verdict PASS):**
- **[item D] MEDIUM-1 — done-criteria doc updates.** Applied by the coordinator (this §6.5 + the 001
  ledger rows). Resolved.
- **[item D] MEDIUM-2 — `create_and_start` running-slot claim deferred to E.** Carried as the item-E
  acceptance line above (E's create path must mark the DB row running). No item-D code change.
- **[item D] LOW-3 — `handleDecisionSubmit` reads an untyped `DECISION_SUBMIT` payload** (per-field casts).
  Producer is the copied tool (schema-guaranteed); revisit if item F introduces external producers. No action.
- **[item D] LOW-4 — `DriveReplyRedis` interface exported but deps use `Pick<Redis,'lpush'|'expire'>`.**
  Documentation-only type; trivial. No action.

---

## 7. Item E — Per-`ownerId` maxBots enforcement

**What it is.** Authored limit-enforced `create_bot`/`start_bot` in the item-D bot-lifecycle handler:
count running bots for the injected `ownerId`, reject at the limit with the herobids-parity error
(`max_bots_reached` / `409`). Limit value = `AgentRiskDefaultsConfig.maxBots` (default 5) as operator
default, overridable per-owner (injected/config).

**Why authored.** herobids' method row-locked the platform `agents` table (per-agent key), deleted in
Phase 2. The per-`ownerId` key + enforcement point is a Traderton tenancy decision (decided 2026-09-06).
**Highest authored-content item in 9b** — this is authored trading behaviour, not a copy.

**Open decision (surface to reviewer):** atomicity. herobids row-locked `agents`; Traderton has no
`agents` table. Options: (E-i) a Postgres **advisory lock keyed by `ownerId`** around the count+insert
(closest to the atomic original); (E-ii) the non-atomic read-count-then-check the quarantined API
`bots.ts` already uses (simpler, small race window). Recommend **(E-i)** — the original was atomic;
"not weaker than herobids-today" (000) argues for preserving atomicity.

**Ports/invariant check.** The **limit decision/value** may be injected by the consumer at M1; the
**enforcement** is Traderton's and not bypassable through a seam. Must not ship weaker than herobids-today.

**Resolves.** The `create_bot`/`start_bot` `Deferred (required for cutover)` sub-capability + the cutover
gate "All Deferred (required for cutover) entries resolved."

**Divergence to log:** per-agent → per-owner reshape (Intentional Divergence, [001](../001-parity-ledger.md)
+ [004](../004-decision-log.md)).

--- END OF M1 ---

## 8. Item F — M2 REST boundary adapter (sequenced last)

**What it is.** The authored Fastify adapter over the M1 ports, per [005](../005-consumer-boundary-contract.md):
`POST /internal/v1/tools:invoke`, `GET /internal/v1/invocations/:requestId`, `GET /health/{live,ready}`;
HMAC-SHA-256 auth over the canonical string; envelope validation (`TradertonToolInvocationV1` →
toolName → Traderton-owned payload schema); idempotency keyed `(consumer_id, owner_id, tool_name,
idempotency_key)` persisted before side effects; deadline enforcement; the closed
`TradertonBoundaryFailureCode` union; readiness/health.

**Authored-new (no herobids equivalent — 005 is a fresh contract):** the Fastify shell, HMAC middleware,
envelope/idempotency/deadline machinery, the `tools:invoke` dispatcher, health endpoints. herobids' auth
is JWT `request.userId` (user control-plane), **not** the HMAC boundary — not copied.

**Copied-and-adapted (the tool logic behind the dispatcher):** the 10 quarantined route handlers in
`_deferred-authoring/api-routes/` become tool implementations, rewired `request.userId → subject.ownerId`
and `userId → ownerId` columns (authored edits to copied files — logged Intentional Divergence). Cheapest:
`reconciliation.ts`, `datasets.ts` (only #1+#2 blockers).

**Ports/invariant check.** The adapter is a **driver over the same M1 ports**; it injects values, not
behaviour; unknown tool/payload/envelope → terminal validation failure before any side effect.

**Open decision / possible Gap (surface to reviewer):** several route handlers reference platform tables
absent from `@traderton/db` (`agents`, `connections`, `blueprints`, `blueprintRevisions`,
`agentRuntimeSessions`). Options per route: inject the needed data at the boundary (value port), or
declare the route out-of-scope for Traderton (a signed-off **Gap** — it stays a herobids control-plane
route). This must be decided route-by-route at F step 1; flag any that can't be cleanly ported.

**Resolves / un-quarantines.** The API-surface rows; "Consumer boundary contract validated" cutover gate;
un-quarantines `_deferred-authoring/api-routes/**` as adapted.

---

## 9. Authored-vs-copied manifest (maintained through implementation)

Buckets (§1a): **COPY** = verbatim / fused-file line-trim; **SEAM** = copied file + 1 authored cut;
**AUTHORED** = no source subset; **IMPROVEMENT** = deferred out of 9b.

| Surface | Bucket | COPY / copied-adapted | AUTHORED (minimal) | Un-quarantines |
|---------|--------|-----------------------|--------------------|----------------|
| A config schema | COPY (fused-file trim) | re-sync `AppConfigSchema` object literal + `AgentRiskDefaultsSchema` + `candleFetch*`; delete platform keys + `superRefine` in place | — | (enables `_deferred-config/*`) |
| A′ S-1 narrowing | AUTHORED (1 line + test) | (copied `StrategySchema` untouched — wrapper) | mechanical-only wrapper + live assertion | — |
| A″ config loader | COPY (fused-file trim) | `config.ts`, `public-stream-routing.ts`, `agent-risk-limits.ts` (+tests); delete platform `ENV_OVERRIDES` + billing guard | — | `_deferred-config/*` |
| B composition root (bot-lifecycle only) | AUTHORED | (wires already-copied modules; actor test files = dep template) | `createTradingRuntime(ports)` factory + tiny bin entry + worker `index.ts` barrel + copied `idGen` util + authored smoke test. (NOT here: tool registry → D; `ActorStateOwner`/agent-direct → C.) | worker barrel |
| C intake | COPY (fused-file) + 1 SEAM | copy `agent-intake-resolver` bodies (`getIntakeDeps`/context/position/`buildPersistence`) + slim handler; delete platform paused/session/telegram/approval branches | `resolveActiveBinding` → venue-account-direct (injected `venueAccountId`) | intake execution capability |
| D drive tools | COPY + AUTHORED seam + DROP | **`tools/bots.ts`, `tools/trading.ts` verbatim** (+ their copied parity tests) | 3-const `AGENT_MESSAGE_TYPES` (values verbatim) + in-process `publishToInbound` target + bot-lifecycle handler (traces `handleManageBot` trading core over the copied `WorkerRuntime`) + `WorkerRuntime.enqueueLifecycle`. DROP: `handleManageBot` agent/grant/LLM shell (platform). maxBots seam → E. | `validate-trade-instrument.test.ts`, `schema.test.ts` |
| E maxBots | AUTHORED (thin primitive) | — | per-`ownerId` atomic count+write via advisory lock | — |
| G events (vocab/emitter) | COPY | event envelope + per-event trading emitter methods (Redis-window, parity) | — | — |
| G events (durable outbox) | IMPROVEMENT (deferred) | — | — (tracked in [014](./014-decision-response-and-event-model.md), NOT 9b) | — |
| F REST adapter | AUTHORED + COPY-adapt | trading route handlers (`userId`→`ownerId`); agent-only routes hand-back (Gap) | Fastify shell, HMAC, envelope/idempotency/deadline, dispatcher, health | `_deferred-authoring/api-routes/**` |

## 10. Stop-gates specific to 9b (state the guard)

- **D — `AGENT_MESSAGE_TYPES` scope:** if the copied tool bodies reference more than the 3 trading
  message types, or a subset can't be authored cleanly → stop-gate (source-fix #4 decision).
- **F — platform-table routes:** any trading route that can't be ported without a platform table and
  can't be boundary-injected → stop-gate → signed-off Gap (not a silent drop).
- **Any authored seam that would carry trading behaviour** (risk/planner/executor override) → the seam
  is mis-drawn; stop and re-draw (ports-carry-values, 000/004).
- **E atomicity:** if per-owner atomic enforcement needs non-trivial authored trading logic beyond a
  lock+count → surface it (it's the highest-authoring item; keep it reviewable).

## 11. Acceptance / deliverables

- All 25 tools execute through the M1 in-process surface; the 7 drive-path tools copied + wired; the
  006 inventory fully Met/accounted in [001](../001-parity-ledger.md).
- Traderton-owned config + composition root authored; `@traderton/worker` consumable via its barrel.
- Intake **execution** surface authored (venue-account-direct; no approvals — consumer-owned); per-`ownerId` maxBots authored.
- Mechanical-only enforced + asserted at the Traderton config boundary (S-1 (a)).
- M2 REST adapter per 005 with the required-verification tests (005 §"Required Verification").
- Forbidden-import sweep stays clean; authored-vs-copied manifest (§9) complete; every deleted/authored
  piece has a ledger row (nothing silent).
- Build + lint + tests green; cutover-gate `Deferred (required for cutover)` entries resolved.

## 12. Sequencing note / how to run

Run A→E first (M1), landing each with build+lint+tests green and un-quarantining as we go; **pause after
E** for a short M1-complete check (the in-process library is now whole). Then run F (M2) — optionally as
its own sub-phase/plan given its size. Honor the stop-gates in §10.

---

## Review checkpoint

**This plan does not authorize implementation.** It is presented for review per the 009 subtraction/
authoring-phase discipline.

**Decisions already settled (2026-09-07):** go-ahead for 9b; S-1 = option (a) narrow-and-diverge;
Traderton does **not** own human approvals (item A carries no approval config; item C is execution-only;
the orphan `decision_approvals` table was deleted).

**Open decisions still requiring a steer** (recommendations given inline):
- **A′** — mechanical-only narrowing shape: Traderton wrapper (a-i, recommended) vs in-place enum edit (a-ii).
- **B** — composition root shape: `createTradingRuntime` factory + tiny bin entry (recommended).
- **C** — `InstanceEventPublisher`: authored thin event/value port (recommended) — the only remaining
  item-C platform-edge question.
- **D** — `AGENT_MESSAGE_TYPES`: author a 3-constant trading subset (D-i, recommended) vs herobids source-fix #4 (D-ii).
- **E** — per-owner maxBots atomicity: advisory lock keyed by `ownerId` (E-i, recommended) vs non-atomic read-count (E-ii).
- **F** — platform-table routes: boundary-inject vs signed-off Gap, decided route-by-route.

On approval, implementation proceeds A→E (M1), pause for an M1-complete check, then F (M2).
