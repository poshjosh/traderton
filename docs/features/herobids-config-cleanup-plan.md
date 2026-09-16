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
