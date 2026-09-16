# herobids operator-config cleanup — DELETE plan (copy-and-delete debt)

**Status:** DRAFT — table only. **Nothing has been deleted.** This records which trading
config blocks in herobids' `config/default.yaml` (and its Zod `AppConfigSchema`) are now dead
after the trading extraction, so they can be removed in a future herobids slice.

**Why:** the extraction is copy-**and-delete**. Traderton now owns the trading engine/runtime,
so the operator config blocks that only the (now-removed) trading engine/worker read are dead
weight in herobids. They were copy-trimmed into `traderton/config/default.yaml` (F2c); the
copy landed but the delete side never happened.

**Method (ripgrep, the reliable tool — the glob search tool false-greens here):** for each
trading block, counted live readers of the OPERATOR config (`appConfig.<block>` / `config.<block>`)
across `apps/**/src` + `packages/**/src` (ex-tests). Distinguished from same-named but unrelated
things (bot INSTANCE config `config.risk`, message-type strings, blueprint presets).

## DELETE candidates — zero live operator-config readers in herobids

| Block (`default.yaml`) | apps readers | packages readers | Also remove from `AppConfigSchema`? | Notes |
|---|---|---|---|---|
| `liveRollout` | 0 | 0 | Yes (`packages/domain/src/config/schema.ts`) | Live-execution gating is Traderton's engine now |
| `simulation` | 0 | 0 | Yes (schema.ts) | Paper/shadow fill fees are engine-side (Traderton) |
| `risk` (top-level) | 0 | 0* | Yes (schema.ts) | *pkg hits are bot-instance `config.risk` + preset.risk, NOT `appConfig.risk` — unrelated |
| `reconciliation` | 0 | 0* | Yes (schema.ts) | *pkg hit is the `instance.reconciliation.notice` message-type string — unrelated |
| `streams` | 0 | 0 | Yes (schema.ts) | Venue stream reconnection is Traderton's |
| `marking` | 0 | 0 | Yes (schema.ts) | Fill-first mark source is Traderton's engine |
| `marketDataRecording` | 0 | 0 | Yes (schema.ts) | Market-data recording is Traderton-side |

## KEEP — still read by the herobids agent-reasoning runtime (do NOT delete)

| Block | Why kept |
|---|---|
| `agentRiskDefaults` | Agent risk-contract resolution + forwarded to agent containers (agent runtime stays in herobids) |
| `marketData` | Agent runtime forwards it (`marketDataConfigJson`) + reads rate-limit/base-url fields; economic-calendar/market-intel context |
| `venues` | Read by `setupRoutes`/`providerRoutes`/`chatRoutes` (provider-setup + chat surfaces). ⚠ Possibly trimmable to a venue *list* — verify separately, not a clean delete |
| `execution` | Only `execution.defaultSlippageBps` is read (by `venueDefaultsRoutes`). ⚠ Could trim to that single field |

## Execution notes for the future delete slice (NOT done here)

1. Delete the 7 blocks from `herobids/config/default.yaml` AND their fields from
   `packages/domain/src/config/schema.ts` (`AppConfigSchema`) in the same change — deleting the
   YAML alone leaves Zod still declaring/defaulting them (dead schema).
2. Re-run herobids `loadConfig()` + build + `pnpm lint` to confirm nothing referenced them.
3. `venues`/`execution` are KEEP-but-possibly-trimmable — treat as a separate, carefully-audited
   refinement (which sub-fields are actually read), not part of the clean 7-block delete.
4. This is a herobids `consume-traderton` branch change; nothing merges to `main`.
5. `backtesting` — present in both files; herobids still exposes backtesting (KEEP unless a
   separate audit shows the backtest runtime is also extracted).

---

## Outstanding Issues (post-implementation, non-blocking)

Recorded after executing the 7-block delete (herobids `consume-traderton`). No CRITICAL/HIGH
remain (the one HIGH — dead `LIVE_ROLLOUT_*` refs in `.env.example` — was fixed in the same slice).

**[Slice 1 — 7-block delete]**
- **LOW:** The plan's KEEP list named `backtesting` as a block to protect, but no `backtesting`
  config block or schema field actually exists in herobids `config/default.yaml` / `AppConfigSchema`
  (nothing to protect, nothing touched). Treat the plan's KEEP list as indicative, not exhaustive.
- **Note (not a defect):** the delete was extended beyond the literal 7 YAML blocks to complete the
  cleanup the build demanded — dead worker `live-gate.ts` (+test) that still imported
  `LiveRolloutConfig` (no production caller), dead `ENV_OVERRIDES` entries, `production.yaml`/
  `staging.yaml` `liveRollout` overlay overrides, and orphaned sub-schemas
  (`LiveRolloutConfigSchema`, `ReconciliationConfigSchema`, `StreamConfigSchema`,
  `MarkingConfigSchema`, `MarketDataRecordingConfigSchema`, `PublicStreamConfigSchema`,
  `SUPPORTED_LIVE_VENUES`, `SupportedLiveVenue`). All verified orphaned via ripgrep before removal.

**[Slice 2 — herobids env-example drift-check mirror]**
- Added `herobids/apps/worker/src/env-example-drift.test.ts` (mirrors traderton's guard; scans BOTH
  `apps/worker/src/config.ts` AND `apps/api/src/config.ts` ENV_OVERRIDES maps + `process.env['X']`
  literals across `apps/*/src` + `packages/*/src`). Resolved pre-existing drift by documenting the
  missing operator vars in `.env.example` (incl. the `TRADERTON_BOUNDARY_*` cutover set) and adding
  `llm.serverCostUsdPerHour: 0.02` to `default.yaml`. 4/4 guard cases pass; `pnpm lint` clean.
- **No CRITICAL/HIGH.** Two MEDIUM findings (ignore-set accuracy) were FIXED in-slice: `DATASETS_DIR`
  (real API operator input, not deferred/dev), `RUNTIME_BACKEND` + `NOMAD_AGENT_IMAGE` (documented
  deploy overrides) moved from IGNORED → documented in `.env.example`.
- **LOW (accepted, documented):** `SOLANA_RPC_URL` (no live reader) and `BASE_RPC_URL` (test-only
  reader) remain in `.env.example` as operator RPC docs and are stale-exempted in the guard — optional
  future cleanup if those doc entries are confirmed dead.
