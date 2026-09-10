# 016 — Item B Implementer Prompt (composition root)

**Status:** ready to hand to an implementer.
**Task:** implement Phase 9b **item B** — the trading composition root (`createTradingRuntime`).
**Authoritative brief:** [013 §4](./013-9b-authoring-plan.md) (the LOCKED decisions + recipe) and
[015](./015-composition-root-proposal.md) (design record + herobids line-by-line trace). Read both.
This prompt is the actionable checklist; 013 §4 wins on any conflict.

---

## 0. Orient first (do not skip)

You are working in **Traderton** (`/Users/chinomso.ikwuagwu/dev_ai/traderton`), a trading library being
extracted from **herobids** (`/Users/chinomso.ikwuagwu/dev_ai/herobids`, READ-ONLY source) by
copy-and-delete. Read the project memory named in [AGENTS.md](../../AGENTS.md) (000/001/004 at minimum),
then [013 §1 + §4](./013-9b-authoring-plan.md) and [015](./015-composition-root-proposal.md).

**The governing law still applies even here:** item B is one of the few *authored* pieces. You author
**wiring only** — every trading primitive (risk gate, planner, executors, actors, mark sources, venue
adapters, strategies, scanner, reconciliation) is ALREADY COPIED into `@traderton/*`. You must not
re-implement or alter any of them. If you find yourself writing trading logic (not wiring), STOP — the
seam is mis-drawn.

**Ports-carry-values invariant (000/004):** the factory may receive config **values** and platform-owned
**values** (`AppConfig`, `redis`, a bot loader, injected `venueAccountId`/`ownerId`). It must NOT accept
any port that injects trading behaviour (risk/planner/executor/reconciliation). Those are constructed
from the copied engine internally and are not overridable.

## 1. Scope — what you are building (and NOT building)

**Building:** `createTradingRuntime(ports)` — an authored factory that constructs the once-per-process
trading singletons and hands `WorkerRuntime` a per-bot `ActorFactory` that builds a `TradingActor` per
running bot. Plus a tiny bin entry, the copied `idGen` literal, an authored smoke test, and the worker
`index.ts` barrel export.

**Scope is BOT `TradingActor` ONLY** (locked decision 013 §4.1a). Do NOT wire `AgentTradingActor`, the
`actorRegistry`, `submitDecision`/intake, the tool registry, `ActorStateOwner`, maxBots, or any REST — see
the exclusions table (§5 below) for which later item owns each. Exposing seams for them is fine; authoring
them here is out of scope.

## 2. The four LOCKED decisions (013 §4.1 — do not re-litigate)

- **(a) Scope:** bot `TradingActor` only. Agent-direct + registry + intake → item C.
- **(b) Ports:** the factory receives `{ config: AppConfig, redis: Redis, instanceLoader: InstanceLoader }`.
  Reuse the copied `WorkerRuntime` types (`InstanceLoader`, `PersistedInstance`). No bespoke new port surface.
- **(c) `idGen`:** relocate the herobids inline literal VERBATIM (see §3 step 3 — it is NOT a separate file).
- **(d) `createStrategy`:** author `dca` + `mechanical` branches only, `throw` on anything else. `llm`/`hybrid`
  are absent from `@traderton/strategy` and already rejected by the mechanical-only `BotConfigSchema` (item
  A′) before this runs, so those branches are unreachable via a valid config. **No new Gap/ledger row** —
  cross-reference the existing mechanical-only Intentional Divergence in a code comment.

## 3. Exact steps

Proposed layout: `packages/worker/src/composition/create-trading-runtime.ts` (factory) +
`packages/worker/src/composition/id-gen.ts` (relocated idGen) + `packages/worker/src/bin/worker.ts` (tiny
entry) + `packages/worker/src/composition/create-trading-runtime.test.ts` (smoke test). Confirm the layout
matches Traderton conventions before committing; the guard is "whichever compiles green and reads clean."

1. **`idGen` (locked 4.1c) — relocate verbatim.** herobids has NO discrete id-gen file; it is an inline
   object literal at `apps/worker/src/index.ts:463–468`:
   ```ts
   const idGen: IdGenerator & { planId(): string; decisionId(): string } = {
     orderId: () => crypto.randomUUID() as OrderId,
     fillId: () => crypto.randomUUID() as FillId,
     planId: () => crypto.randomUUID(),
     decisionId: () => crypto.randomUUID(),
   };
   ```
   Relocate this literal verbatim into `id-gen.ts` (export a `createIdGen()` returning it, or the literal).
   `IdGenerator` is from `@traderton/engine` (`packages/engine/src/paper-executor.ts`); `OrderId`/`FillId`
   from `@traderton/domain`. This is trading scaffolding — a verbatim relocation, not authoring. (Note the
   "UUIDv7" comment is aspirational; it is `crypto.randomUUID()` — keep as-is.)

2. **Singletons (013 §4.2; herobids trace in 015 §2.1).** Construct once, from copied modules:
   `createDatabase(config.database.url)` → the 8 trading repos (`FillRepository`, `PositionRepository`,
   `ExecutionPlanRepository`, `OrderRepository`, `BalanceSnapshotRepository`, `ReconciliationEventRepository`,
   `DecisionRepository`, `BacktestingRepository`) + `PgJournal` (all `@traderton/db`); `idGen`;
   `createProviderRegistry(config.marketData)` (optional; undefined when `marketData` absent) →
   scanner infra: `TokenBucketRateLimiter` ×2 + `createScannerCandleFetcher` + `CandleFetchBreaker`;
   mark sources: `OracleMarkSource` + `HyperliquidMarkSource` + a `MarkSelector` composite fallback
   (staleness 30000ms); `PublicStreamPool` via `buildPublicStreamConnectors(config.venues)` (undefined when
   no connectors); `VenueAdapterFactory({ db, journal, venues: config.venues, streamConfig: config.streams.private })`;
   `InstanceLease(redis, workerId)`; then `new WorkerRuntime(cfg, actorFactory, instanceLoader, lease)`.

3. **Per-bot `ActorFactory` closure (013 §4.3; herobids `index.ts:1878–2249`).**
   `async (botId, rawConfig) => TradingActor`:
   1. `BotConfigSchema.safeParse(rawConfig)` → throw on failure (this is the mechanical-only schema; A′).
   2. Read the **injected `venueAccountId`** from the parsed config. **Do NOT call `resolveBotStartupContext`**
      (deleted Phase 8 — the connection grant front-end). venueAccountId is injected (decisions 11–13).
   3. `venueAdapterFactory.buildOrderbookAdapter({...})` or `buildSwapAdapter({...})` per `venueType`.
      Credentials decrypt via the retained `venue_accounts`/`user_credentials` tables + `CREDENTIAL_ENCRYPTION_KEY`
      (the copied factory does this; you inject only `venueAccountId`).
   4. `createStrategy(config.strategy, candleFetcher)` — mechanical/dca only (4.1d).
   5. `riskLimits` INLINE from `config.risk` (bots do this; NOT `buildAgentRiskLimits` — that's the agent path).
      Match the herobids field mapping at `index.ts:2079–2086` (maxOpenPositions, maxPositionSizePct,
      dailyMaxLossPct, stopLossCooldownMs, stopLossMaxUnrealizedLossPct = config.risk.stopLossPct,
      maxOrderNotional). **Live-gate note:** herobids sources `maxOrderNotional` from `assertLiveReadiness`
      (`liveGateResult.effectiveMaxOrderNotional`). Check whether the live-gate helper is copied in Traderton;
      if it is, wire it; if not, that is a seam — STOP and surface it (do not hand-author a live gate).
   6. per-bot `createFillFirstMarkSource({ fillLookup: fillRepo, actorId: botId, fallbackSource: markSelector, stalenessThresholdMs })`.
   7. scoped `streamPool` = `createScopedStreamPoolHandle(publicStreamPool, venue, testnet)` (orderbook) / undefined (swap).
   8. assemble `TradingActorDeps` (operator-config fields from `config`) + `new TradingActor(botId, config.strategy.params as Record<string,unknown>, deps)`. Return it.

4. **`WorkerRuntimeConfig` callbacks (M1 = no-op stubs).** `onStartFailed`/`onStopped`/`onStarted` — wire to
   no-ops for M1 (their herobids bodies update the bots table + publish status → item C2). **Keep**
   `onCrashed → runtime.handleActorCrash(botId)` (that is trading lifecycle, not a status publish).

5. **Barrel + bin.** Export `createTradingRuntime` (+ the `TradingRuntime`/`TradingRuntimePorts` types) from
   `packages/worker/src/index.ts` (currently `export {};`). Add a tiny `bin/worker.ts` that loads config
   (the copied `loadConfig`), builds a real `instanceLoader` (bots WHERE status='running', each config
   carrying `venueAccountId` + `ownerId`), calls `createTradingRuntime(...)`, and `start()`s it.

## 4. `TradingRuntime` return shape (expose seams for later items; author none of them)

```ts
export interface TradingRuntime {
  start(): Promise<void>;
  shutdown(): Promise<void>;
  runtime: WorkerRuntime; // exposed so item D (drive) / M2 can enqueue lifecycle jobs
}
```

## 5. Exclusions — do NOT author these here (route to the owning item)

| Excluded | Goes to | Note |
|----------|---------|------|
| `AgentTradingActor` + `actorRegistry` decision routing | item C | needs venue-account-direct resolver |
| `submitDecision` / decision handler | item C | expose seams only |
| tool registry (`createToolRegistry`/`assertToolCatalogMatchesRegistry`) | item D | NOT part of B |
| `ActorStateOwner` | item C | agent-direct/intake path |
| who publishes lifecycle jobs / in-process `publishToInbound` | item D | B builds the BullMQ *consumer* (`WorkerRuntime`) |
| `onJournalEvent`/`emitAgentWake`/status publishes | item C2 | M1 = no-op stubs |
| per-`ownerId` maxBots | item E | — |
| advertised `create_bot.config.strategy` tool-schema narrowing | item D | A′ follow-up |
| M2 REST boundary | item F | — |

## 6. Guardrails / stop-gates (surface, do not push past)

- **A missing copied dependency** (e.g. the live-gate helper `assertLiveReadiness`, or any symbol the
  ActorFactory needs that isn't in a Traderton barrel) → STOP; it's a seam, not something to author.
- **Any temptation to write trading logic** (not wiring) → STOP; the seam is mis-drawn (ports-carry-values).
- **`AgentTradingActor` turns out to be needed for a bot to run** → STOP; that contradicts the bot-only scope.
- Do NOT edit any copied module to make wiring fit — if a copied module doesn't compose, surface it.

## 7. Verification (no copy oracle — this is authored)

- `pnpm build` green, `pnpm lint` clean.
- **Existing 2240 copied tests stay green** (you add a surface; you change no module). If any copied test
  breaks, you altered something you shouldn't have — revert and reconsider.
- **Authored smoke test** (`create-trading-runtime.test.ts`, clearly labelled AUTHORED — not a copied
  oracle): with a paper/in-memory `AppConfig` + a stub `instanceLoader` returning one paper bot config,
  `createTradingRuntime(...)` returns a `TradingRuntime`; `start()` then `shutdown()` run clean; the paper
  bot rehydrates into a `TradingActor`. Keep it small and deterministic (no real Redis/DB/network — stub
  what you must, but do not stub the factory's own wiring).
- Cross-check the per-bot ActorFactory against herobids `index.ts:1878–2249` (015 documents each step's
  source line) — the closure should be traceable to the reference, diverging only where 013 §4 says
  (injected venueAccountId, mechanical-only strategy, no-op status callbacks).

## Outstanding Issues (from CodeReviewer, 2026-09-07) — resolve before item B is DONE

Review found **no CRITICAL/HIGH** (commit not gated on code). Three MEDIUM findings, all "silently-dropped
behaviour must be recorded/wired, never silent" (AGENTS.md):

- **[item B] MEDIUM-2 — market-data recorder omitted → WIRE IT (copyable).** herobids `index.ts:1980–2033`
  wires `recordMarketSnapshot`/`recordReferenceMark` when `config.marketDataRecording.enabled`, via
  `MarketDataRecorder` — which **is copied + exported from `@traderton/backtesting`** and whose
  `backtestingRepo` methods are present. So it is a clean wire, not a seam → copy the recorder block into
  the ActorFactory (guarded by `config.marketDataRecording.enabled`), rather than defer. Coordinator
  decision: **wire it** (deferring copyable behaviour = an avoidable silent drop).
- **[item B] MEDIUM-1 + MEDIUM-3 — swap token-safety deferral → RECORD as Deferred (genuinely not copyable).**
  `swapTokenSafety` (and the paired 1inch `swapNetwork` fail-closed guard, herobids `index.ts:2043–2047`)
  depend on the herobids inline `enrichTokenWithDiscovery` (index.ts:93), which was NOT copied. Reproducing
  it is non-wiring authoring → keep `swapTokenSafety: undefined` for now, but **add one coherent ledger
  entry** (001 + 003) recording the deferral (swap-venue token-safety gating; blocked on
  `enrichTokenWithDiscovery`; affects swap bots only; resolve before swap bots run live — via a follow-up
  copy or a source-fix). Not needed for the bot-lifecycle wiring itself.
- **[item B] LOW-1..4** — smoke-test `actorFactory` cast fragility; two verbatim-from-source casts
  (`as unknown as RedisEvalClient`, `resolveSwapNetwork(..., undefined, ...)`); `config_.venue!`/`venueType!`
  non-null (matches source contract). All acceptable/verbatim; no action required (optional comments).

## 8. Done criteria + docs

- Build/lint/tests green; `@traderton/worker` consumable through its barrel (its `index.ts` is no longer
  `export {};`); the "Trading loop — assembled runtime / composition `Deferred (required for cutover)`"
  ledger row can move to Met-for-the-bot-lifecycle (note agent-direct still pending item C).
- Update: [001](../../docs/001-parity-ledger.md) (composition-root progress), [013](./013-9b-authoring-plan.md)
  item B → DONE with the authored-vs-copied manifest of what you actually wrote, and note any seam you
  surfaced (e.g. live-gate). Commit as its own logical commit ("9b item B: trading composition root").
- **Then PAUSE** — item C (intake) is the next item and is gated on human review of B.

## 9. Key file map (start here)

- `packages/worker/src/runtime.ts` — `WorkerRuntime`, `WorkerRuntimeConfig`, `ActorFactory`, `InstanceLoader`, `PersistedInstance`, `InstanceActor`, `InstanceLease` usage.
- `packages/worker/src/trading-actor.ts` — `TradingActor` + `TradingActorDeps` (the struct the ActorFactory populates).
- `packages/worker/src/venue-adapter-factory.ts` — `VenueAdapterFactory` (credential resolution + adapter construction).
- `packages/worker/src/public-stream-routing.ts` — `buildPublicStreamConnectors` / `createScopedStreamPoolHandle`.
- `packages/worker/src/agent-risk-limits.ts` — `buildAgentRiskLimits` (agent path — reference only; bots use inline riskLimits).
- `@traderton/engine` — `MarkSelector`, `createFillFirstMarkSource`, `IdGenerator`, `PaperExecutor` (idGen type).
- `@traderton/venues` — `OracleMarkSource`, `HyperliquidMarkSource`, `PublicStreamPool`, `VenueCandleFetcher`.
- `@traderton/market-data` — `createProviderRegistry`, `createPriceService`, `TokenBucketRateLimiter`.
- `@traderton/strategy` — `MechanicalStrategy`, `DcaStrategy` (llm/hybrid ABSENT — expected).
- `@traderton/db` — the 8 repos + `PgJournal` + `createDatabase`.
- herobids `apps/worker/src/index.ts` — READ-ONLY reference: idGen `:463`, singletons `~209–321,780–791,1657–1678`, createStrategy `1621–1656`, per-bot ActorFactory `1878–2249`, instanceLoader `2251`.
