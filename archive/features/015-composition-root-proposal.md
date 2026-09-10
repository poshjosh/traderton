# 015 — Composition Root (`createTradingRuntime`) — Proposal (item B)

**Status:** APPROVED (2026-09-07, human) — decisions in §5 are LOCKED. Implementer brief lives in
[013 §4](./013-9b-authoring-plan.md); this doc is the design record + herobids line-by-line trace.
**Phase:** 9b item B (the largest genuinely-authored piece).
**Feeds:** [013-9b-authoring-plan.md](./013-9b-authoring-plan.md) item B.
**Grounding:** read-only investigation of the copied Traderton worker modules + herobids
`apps/worker/src/index.ts` trading-half construction (2026-09-07). Governed by
[000](../../docs/000-vision.md) (ports-carry-values; M1→M2), [004](../../docs/004-decision-log.md) (decisions 10–13),
[005](../../docs/005-consumer-boundary-contract.md).

> **This is the first high-authoring-risk item.** The proposal is deliberately explicit about
> what is authored (wiring only), what is constructed from already-copied modules, what is
> injected, and — critically — the **four boundary decisions** (§5) I will not settle
> unilaterally. Nothing is implemented until this is reviewed.

---

## 1. What item B is

herobids `apps/worker/src/index.ts` (~3050 lines) is a platform-fused startup script that, among
much else, constructs the trading actors. It has **no faithful trading-only subset** (confirmed
Phase 8). Item B authors a `createTradingRuntime(...)` **factory** that wires the already-copied
trading modules into a runnable runtime — the in-process surface herobids (M1) consumes and the
M2 REST adapter later drives (same core, two adapters).

**Authored = wiring only.** Every trading primitive (risk gate, planner, executors, actors,
reconciliation, mark sources, venue adapters, strategies, scanner) is already copied. The factory
constructs and connects them; it re-implements none of them. (Ports-carry-values invariant holds:
the factory injects values/config, never trading behaviour.)

## 2. The shape (proposed)

A factory that constructs the once-per-process singletons, then hands `WorkerRuntime` a per-bot
`ActorFactory` closure. `WorkerRuntime(config, actorFactory, instanceLoader?, lease?)` already
exists (copied); the factory supplies its arguments.

```ts
// packages/worker/src/composition/create-trading-runtime.ts  (authored)
export interface TradingRuntimePorts {
  /** Operator config — the Traderton-owned AppConfig (item A). */
  config: AppConfig;
  /** BullMQ/Redis connection (lifecycle jobs + lease + scanner breaker + dedup store). */
  redis: Redis;
  /** Loads bots to rehydrate (status='running'), keyed by owner scope the consumer controls.
   *  Each PersistedInstance.config carries the INJECTED venueAccountId + soft ownerId
   *  (decisions 11–13) — NOT connectionId/userId. This is the M1 injection point. */
  instanceLoader: InstanceLoader;
  // (optional, later items — NOT authored in B):
  //   eventSink?  -> item C2 (trading event producer); M1 default = no-op
  //   onLifecycle? -> status callbacks; M1 default = no-op
}

export interface TradingRuntime {
  /** Start rehydration + lifecycle-job consumer + reclaim loop. */
  start(): Promise<void>;
  /** Graceful shutdown. */
  shutdown(): Promise<void>;
  /** The BullMQ-backed lifecycle control (start/stop/restart a bot) — the drive target
   *  item D publishes to. Exposed so item D / M2 can enqueue lifecycle jobs. */
  runtime: WorkerRuntime;
  // Later (item C/D): submitDecision(...) intake + the ExecutionActor registry.
  // NOT part of B — B builds the bot-lifecycle runtime; intake is item C.
}

export function createTradingRuntime(ports: TradingRuntimePorts): TradingRuntime;
```

### 2.1 Construction recipe (authored, from the copied modules)
Singletons, once: `createDatabase(config.database.url)` → the 8 trading repos + `PgJournal`;
`idGen` (see §5c); `createProviderRegistry(config.marketData)` (optional) → scanner infra
(`TokenBucketRateLimiter` ×2 + `createScannerCandleFetcher` + `CandleFetchBreaker`); mark sources
(`OracleMarkSource` + `HyperliquidMarkSource` + `MarkSelector` composite); `PublicStreamPool` via
`buildPublicStreamConnectors(config.venues)`; `VenueAdapterFactory({db, journal, venues, streamConfig})`;
`InstanceLease(redis, workerId)`; then `new WorkerRuntime(cfg, actorFactory, instanceLoader, lease)`.

### 2.2 Per-bot `ActorFactory` (the crux — authored closure)
`async (botId, rawConfig) => TradingActor`:
1. `BotConfigSchema.safeParse(rawConfig)` (throw on failure) — note this is now the **mechanical-only**
   `BotConfigSchema` (item A′), so llm/hybrid bot configs are rejected here.
2. Read the **injected `venueAccountId`** from the parsed config (NOT `resolveBotStartupContext` — that
   platform grant front-end was deleted Phase 8; venueAccountId is injected per decisions 11–13).
3. `venueAdapterFactory.buildOrderbookAdapter(...)` / `buildSwapAdapter(...)` (credential decrypt via the
   retained `venue_accounts`/`user_credentials` tables + `CREDENTIAL_ENCRYPTION_KEY`).
4. `createStrategy(config.strategy, candleFetcher)` — **mechanical/dca only** (§5d).
5. `riskLimits` inline from `config.risk` (herobids builds bots this way — NOT `buildAgentRiskLimits`).
6. per-bot `createFillFirstMarkSource({ actorId: botId, fallbackSource: markSelector, fillLookup: fillRepo })`.
7. scoped `streamPool` (orderbook) / undefined (swap).
8. assemble `TradingActorDeps` (operator-config fields from `config`) + `new TradingActor(...)`.

## 3. What is authored vs copied vs injected

- **Authored (new):** `create-trading-runtime.ts` (the factory + the per-bot ActorFactory closure +
  `createStrategy` gated to mechanical/dca) and the worker `index.ts` barrel that exports it. Wiring only.
- **Copied (already in tree):** every module the factory constructs — actors, runtime, venue-adapter
  factory, mark sources, scanner infra, strategies, repos, risk-limit builder.
- **Injected (M1 consumer supplies):** `config: AppConfig`, `redis`, the `instanceLoader` (bots keyed by
  the consumer's owner scope, each carrying the resolved `venueAccountId` + soft `ownerId`).

## 4. Ports-carry-values check
The factory receives config **values** and a bot **loader** (data), and injects the resolved
`venueAccountId` (value) per bot. It does not accept any port that injects risk/planner/executor
behaviour — those are constructed from the copied engine internally and are not overridable. ✓

## 5. Boundary decisions — APPROVED 2026-09-07 (recommendations accepted; now LOCKED)

> All four below were approved as recommended. They are recorded in the implementer brief
> [013 §4.1](./013-9b-authoring-plan.md). Kept here as the decision record + rationale.

**(a) Scope: bot `TradingActor` only, or also `AgentTradingActor`?**
`TradingActor` (bots) is the clean `WorkerRuntime` fit (implements `InstanceActor`; lifecycle via BullMQ
jobs). `AgentTradingActor` implements `ExecutionActor` and in herobids is started via the agent/session
path + registered in an `actorRegistry` for **decision routing** — which is the **intake surface (item
C)**. Recommendation: **item B builds the bot-lifecycle runtime only**; the agent-direct actor + its
registry come with item C (intake). This keeps B a clean, testable unit and honors the dependency order
(B before C). Confirm, or do you want B to also stand up the agent-direct actor now?

**(b) Injected config/bot-loader port shape.** Recommendation: inject the whole `AppConfig` (item A) +
an `instanceLoader` callback the consumer implements (returns running bots, each config carrying
`venueAccountId` + `ownerId`). This is the M1 injection seam. Alternative: a narrower typed "bot record"
port. Recommendation: reuse `AppConfig` + `InstanceLoader` (already the copied `WorkerRuntime`'s type) —
minimal new surface. Confirm?

**(c) `idGen` provenance.** herobids uses a module-level UUIDv7 generator (`idGen` with `planId()`/
`decisionId()`), not visibly exported from a Traderton barrel. Options: copy the small herobids id-gen
util verbatim into the worker (if it exists as a discrete file) or construct it in the factory. This is
a minor seam. Recommendation: **locate + copy the herobids id-gen util verbatim** (it's trading
scaffolding) rather than author one. I will confirm the source file before writing anything. Agree?

**(d) llm/hybrid strategy gating (this is the one with a parity implication).**
`LlmStrategy`/`HybridStrategy` are **absent** from `@traderton/strategy` (correctly — decisions 7–9,
mechanical-only). But `createStrategy` in herobids switches on `decisionMode` including `llm`/`hybrid`.
Since item A′ already makes `BotConfigSchema` reject llm/hybrid **before** the ActorFactory runs, the
authored `createStrategy` only needs `dca` + `mechanical` branches; llm/hybrid are unreachable via a
valid bot config. Recommendation: author `createStrategy` with **mechanical/dca only**, and a defensive
`throw` on any other decisionMode (belt-and-suspenders, since config already gates it). This is
consistent with the existing mechanical-only Intentional Divergence — no new ledger entry needed beyond
a cross-reference. Confirm this is the intended handling (vs. a `Gap` entry)?

## 6. What B explicitly does NOT include (deferred to later items)
- **Intake / decision routing** (`submitDecision`, actorRegistry, venue-account-direct resolver) → item C.
- **Drive target** (who publishes lifecycle jobs / the in-process `publishToInbound`) → item D.
- **Event producer** (`onJournalEvent`/`emitAgentWake`/status publishes) → item C2; M1 default = no-op stubs.
- **maxBots enforcement** → item E.
- **M2 REST** → item F.
The factory exposes the seams (the `WorkerRuntime`, the constructed singletons) so C/D/C2 can attach
without re-opening B.

## 7. Verification plan (how B is validated without a copy oracle)
- Build + lint green.
- **Authored-code test:** a factory smoke test — `createTradingRuntime` with an in-memory/paper config +
  a stub `instanceLoader` returns a `TradingRuntime`; `start()`/`shutdown()` cleanly; a paper bot config
  rehydrates into a `TradingActor` that ticks. (Authored test, clearly labeled — not a copied oracle.)
- **herobids-as-oracle:** the per-bot ActorFactory recipe (§2.2) is traced line-for-line to herobids
  `index.ts:1878–2249`; the proposal documents each step's source line so the authored closure is
  reviewable against the reference. (Optional deeper check: the clone-herobids2-and-drive-Traderton A/B.)
- Existing 2240 copied tests stay green (the factory adds a surface; it doesn't change the modules).

## 8. Recommendation summary (for your decisions on §5)
- (a) **bot-only** in B; agent-direct + registry with item C.
- (b) inject `AppConfig` + `InstanceLoader`.
- (c) copy the herobids id-gen util verbatim (confirm source file first).
- (d) `createStrategy` mechanical/dca only + defensive throw; cross-reference the mechanical-only
  divergence, no new Gap.

**APPROVED 2026-09-07.** §5 (a)–(d) accepted as recommended and LOCKED into [013 §4.1](./013-9b-authoring-plan.md).
Implementation of B = `create-trading-runtime.ts` (+ tiny bin entry + smoke test + barrel), isolated and
reviewed, then pause before item C. Any implementer works from [013 §4](./013-9b-authoring-plan.md) + this
doc's §2/§3 (recipe) — no dependence on the originating chat.
