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
| **C. Intake router + registry + AgentTradingActor wiring** (decisions LOCKED — §5) | **COPY (already, Phase 8) + AUTHORED wiring/seam + DROP** | Re-verified 2026-09-07 (post-investigation): the actor-owned intake (`AgentTradingActor.getIntakeDeps`/`getDecisionContext`/`getPosition`), `ExecutionActor`, `TradingActor`, `validate-trade-instrument`, `venue-instrument-cache` were **already COPIED in Phase 8** — C reuses them. C **authors** only wiring: a slim decision router (`submitDecision`), a plain `Map<string, ExecutionActor>` registry (owned by B's factory), the venue-account-direct resolver seam (injected `venueAccountId` + the venue-account guards), and `AgentTradingActor` construct+register. It **DROPS** (Intentional Divergence) the `AgentIntakeResolver` grant-fallback + `ActorStateOwner` — the `agentConnections ⋈ connections` grant front-end / agent-session wrapper, both platform (crux resolved = option (a); require a running actor else `instance_not_running`). Handler drops the platform paused/session/telegram/approval branches. |
| **D. Drive-path tools** (`bots.ts`, `trading.ts`) | **COPY** (after a tiny authored target) | Both copy verbatim once available: their only Traderton-absent dep is `AGENT_MESSAGE_TYPES` (3 trading consts) + an in-process `publishToInbound` target. Author the 3 consts + the drive target (small); then **copy the tools**. Do NOT copy the 1941-line platform broker. |
| **D-target. In-process drive target** | **AUTHORED (small)** | Routes `DECISION_SUBMIT`→handler (C), `MANAGE_BOT`→bot-lifecycle (E), + the sync reply. Small authored wiring. |
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

## 5. Item C — Decision-intake surface (execution only; NO approvals)

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

**What it is.**
- An authored **in-process `publishToInbound` drive target** (the `ToolContext.publishToInbound` port):
  routes `DECISION_SUBMIT` → item C's decision handler; `MANAGE_BOT` (`create_and_start`/`start`/`stop`/
  `restart`) → an authored **bot-lifecycle handler**; and services the `agent:decision:reply:${id}` Redis
  reply that `submit_decision`'s `blpop` awaits.
- A **trading subset of `AGENT_MESSAGE_TYPES`** (`DECISION_SUBMIT`, `MANAGE_BOT`, `BOT_QUERY`) — the enum
  was deleted with `agent-protocol.ts` in Phase 1.
- Then **COPY `tools/bots.ts` + `tools/trading.ts` verbatim** (modulo namespace). Their only
  Traderton-absent dependency is `AGENT_MESSAGE_TYPES`; the contract types + `checkModeEscalation` /
  `deriveStrategyPreset` / `extractStrategyFromConfig` / `convertZodToJsonSchema` are all present.

**Why authored (partly).** The drive *target* is authored (it's the in-process expression of the
herobids message-broker route). The tool *modules* are then copied — no further herobids source-fix is
required (confirmed in the M1 review).

**Open decision (surface to reviewer) — mild stop-gate candidate.** `AGENT_MESSAGE_TYPES` is a coherent
single-channel agent+trading enum; the anomaly log flagged that carving a trading subset risks
duplicating `agent.*` strings / drift. Two options:
- **(D-i) Author a minimal Traderton trading message-type constant set** (just the 3 trading types) —
  no herobids change; small authored constant, low risk. **Recommended.**
- **(D-ii) herobids source-fix #4** to split a trading message-type subset — heavier (a full herobids
  release cycle) for little gain, since Traderton only needs 3 constants.
Recommend **(D-i)**; escalate to a stop-gate only if the tool bodies turn out to reference more of the
enum than the 3 trading types.

**Ports/invariant check.** The drive path carries a decision/command **value** to Traderton's owned
intake + bot lifecycle; the caller cannot inject planning/risk/execution.

**Resolves / un-quarantines.** The 7 drive-path tool rows (`submit_decision`, `create_bot`, `start_bot`,
`stop_bot`, `list_bots`, `get_bot_status`, `adjust_bot_config`); un-quarantines
`_deferred-config/validate-trade-instrument.test.ts` (needs `tools/trading.ts`) and, after S-2/S-3
reconciliation, `_deferred-authoring/schema.test.ts`.

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
| D drive tools | COPY (after small target) | **`tools/bots.ts`, `tools/trading.ts` verbatim** | 3 trading `AGENT_MESSAGE_TYPES` consts + in-process `publishToInbound` target + bot-lifecycle handler | `validate-trade-instrument.test.ts`, `schema.test.ts` |
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
