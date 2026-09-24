# Traderton Env File Design And Variable Mapping

## Purpose

Traderton currently documents runtime env, validator env, and operator/test env in a single `.env.example`. That collapses distinct concerns into one surface and creates avoidable confusion:

- app runtime vs operator scripts
- config overrides vs validator-only inputs
- optional self-skipping tests vs required boundary boot inputs
- local dev credentials vs remote staging/production operator credentials

This document proposes a file layout that mirrors the role-based split already used in herobids while also following Traderton's stricter rule that every real `.env*` file should have a committed `.example` twin.

## Target File Families

| Real file | Committed example | Purpose |
|---|---|---|
| `.env` | `.env.example` | Local boundary/runtime env only |
| `.env.ops.dev` | `.env.ops.dev.example` | Local operator scripts, validator runs, integration-test credentials |
| `.env.ops.staging` | `.env.ops.staging.example` | Remote operator scripts against staging |
| `.env.ops.production` | `.env.ops.production.example` | Remote operator scripts against production |
| `infra/hetzner/.env.backend` | `infra/hetzner/.env.backend.example` | Terraform backend and deploy-backend secrets only |
| `infra/hetzner/.env.staging` | `infra/hetzner/.env.staging.example` | Staging server runtime env |
| `infra/hetzner/.env.production` | `infra/hetzner/.env.production.example` | Production server runtime env |

## Design Rules

1. `.env.example` documents only variables read by the Traderton boundary/runtime process or its config override layer.
2. `.env.ops.*.example` documents only operator-script, validator, integration-test, and setup credentials.
3. `infra/hetzner/.env.*.example` documents deploy-time server env and must not contain local-only testing conveniences.
4. `infra/hetzner/.env.backend.example` is reserved for Terraform/backend credentials and never mixes with application secrets.
5. Variables backed by `config/default.yaml` stay optional overrides in runtime env examples; they must not be presented as mandatory unless the process actually requires them.
6. Test-only or validator-only secrets must not appear as if the boundary itself requires them.
7. Status messaging in scripts should match the role split: missing optional ops/test vars produce `SKIP` or `WARN`, not pseudo-failures.

## Naming Guidance

### Primary naming rule

Use one documented primary env name per concept.

### Known drift to resolve

| Concept | Current names in repo | Proposed primary name | Compatibility note |
|---|---|---|---|
| 1inch RPC for local validator/tests | `BASE_RPC_URL`, `ONEINCH_RPC_URL` | `BASE_RPC_URL` in `.env.ops.*`; `ONEINCH_RPC_URL` only as runtime override in `.env.example` if code still reads it | Validators/tests may continue to accept both during migration |
| 1inch API endpoint override | `ONEINCH_API_URL`, `ONEINCH_BASE_URL` | `ONEINCH_API_URL` in `.env.ops.*`; `ONEINCH_BASE_URL` in `.env.example` only if runtime override remains | Scripts should make one name primary and label the other an alias |
| Jupiter API endpoint override | `JUPITER_API_URL`, config `venues.jupiter.baseUrl` | `JUPITER_API_URL` | Runtime/config mapping should be explicit in comments |
| Remote ops templates | one shared remote example in herobids | separate `.env.ops.staging.example` and `.env.ops.production.example` in Traderton | Better fit for Traderton AGENTS rule |

## Variable Mapping Table

The table below maps the current env surface into the proposed file families. `Keep` means stay in `.env.example`. `Move` means remove from `.env.example` and document in a new ops example instead. `Add` means not currently documented where it should be. `Duplicate` means the value belongs in more than one example family because different environments of the same role need the same key shape.

| Variable | Current status | Target example file(s) | Action | Reason |
|---|---|---|---|---|
| `DATABASE_URL` | In `.env.example` | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Boundary runtime input |
| `REDIS_URL` | In `.env.example` | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Boundary runtime input |
| `CREDENTIAL_ENCRYPTION_KEY` | In `.env.example` | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Boundary runtime input |
| `BOUNDARY_CONSUMER_ID` | In `.env.example` | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Boundary runtime input |
| `BOUNDARY_KEY_ID` | In `.env.example` | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Boundary runtime input |
| `BOUNDARY_SIGNING_SECRET` | In `.env.example` | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Boundary runtime input |
| `BOUNDARY_HOST` | In `.env.example` | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Runtime tuning |
| `BOUNDARY_PORT` | In `.env.example` | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Runtime tuning |
| `BOUNDARY_CLOCK_SKEW_MS` | In `.env.example` | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Runtime tuning |
| `BOUNDARY_IDEMPOTENCY_RETENTION_HOURS` | In `.env.example` | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Runtime tuning |
| `SCRAPFLY_API_KEY` | In `.env.example` | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Runtime feature input |
| `LLM_BASE_URL` | In `.env.example` | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Runtime feature input |
| `LLM_MODEL` | In `.env.example` | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Runtime feature input |
| `LLM_API_KEY` | In `.env.example` | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Runtime feature input |
| `LLM_TIMEOUT_MS` | In `.env.example` | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Runtime feature input |
| `JUPITER_API_KEY` | In `.env.example` | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example`, `.env.ops.dev.example`, `.env.ops.staging.example`, `.env.ops.production.example` | Keep and duplicate | Runtime override and local/remote validator input |
| `ONEINCH_API_KEY` | In `.env.example` | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example`, `.env.ops.dev.example`, `.env.ops.staging.example`, `.env.ops.production.example` | Keep and duplicate | Runtime override and local/remote validator input |
| `BIRDEYE_API_KEY` | In `.env.example` | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Runtime override |
| `COINMARKETCAP_API_KEY` | In `.env.example` | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Runtime override |
| `COINGECKO_API_KEY` | In `.env.example` | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Runtime override |
| `ONEINCH_PRIVATE_KEY` | In `.env.example` | `.env.ops.dev.example`, `.env.ops.staging.example`, `.env.ops.production.example` | Move | Validator/integration secret, not a boundary runtime input |
| `SOLANA_WALLET_PRIVATE_KEY` | In `.env.example` | `.env.ops.dev.example`, `.env.ops.staging.example`, `.env.ops.production.example` | Move | Validator/integration secret |
| `SOLANA_RPC_URL` | In `.env.example` | `.env.ops.dev.example`, `.env.ops.staging.example`, `.env.ops.production.example` | Move | Validator/runtime convenience for ops flows, not needed in boundary runtime env when config default is sufficient |
| `JUPITER_WALLET_ADDRESS` | In `.env.example` | `.env.ops.dev.example`, `.env.ops.staging.example`, `.env.ops.production.example` | Move | Validator-only input |
| `JUPITER_PRIVATE_KEY` | In `.env.example` | `.env.ops.dev.example`, `.env.ops.staging.example`, `.env.ops.production.example` | Move | Validator-only input |
| `SWAP_AMOUNT` | In `.env.example` | `.env.ops.dev.example`, `.env.ops.staging.example`, `.env.ops.production.example` | Move | Validator-only tuning |
| `SLIPPAGE_BPS` | In `.env.example` | `.env.ops.dev.example`, `.env.ops.staging.example`, `.env.ops.production.example` | Move | Validator-only tuning |
| `JUPITER_API_URL` | Commented in `.env.example` overrides | `.env.example`, `.env.ops.dev.example`, `.env.ops.staging.example`, `.env.ops.production.example` | Keep in runtime example; add to ops examples | Optional override used by validator scripts |
| `HYPERLIQUID_BASE_URL` | Commented in `.env.example` overrides | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Runtime override |
| `HYPERLIQUID_WS_URL` | Commented in `.env.example` overrides | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Runtime override |
| `HYPERLIQUID_TESTNET` | Commented in `.env.example` overrides | `.env.example` | Keep | Runtime override |
| `BYBIT_BASE_URL` | Commented in `.env.example` overrides | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Runtime override |
| `BYBIT_WS_URL` | Commented in `.env.example` overrides | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Runtime override |
| `BYBIT_WS_PUBLIC_URL` | Commented in `.env.example` overrides | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Runtime override |
| `BYBIT_TESTNET` | Commented in `.env.example` overrides | `.env.example` | Keep | Runtime override |
| `ONEINCH_BASE_URL` | Commented in `.env.example` overrides | `.env.example` | Keep, but relabel as runtime override alias | Runtime override name drifts from validator's `ONEINCH_API_URL` |
| `ONEINCH_RPC_URL` | Commented in `.env.example` overrides | `.env.example` | Keep, but relabel as runtime override alias | Runtime override name drifts from validator's `BASE_RPC_URL` |
| `ONEINCH_CHAIN_ID` | Commented in `.env.example` overrides | `.env.example`, `.env.ops.dev.example`, `.env.ops.staging.example`, `.env.ops.production.example` | Keep in runtime example; add to ops examples if validator supports override | Used by 1inch validator |
| `ONEINCH_ROUTER_ADDRESS` | Commented in `.env.example` overrides | `.env.example`, `.env.ops.dev.example`, `.env.ops.staging.example`, `.env.ops.production.example` | Keep in runtime example; add to ops examples | Validator/recovery hardening input |
| `RECONCILIATION_INTERVAL_MS` | Commented in `.env.example` overrides | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Runtime override |
| `RECONCILIATION_DRIFT_ALERT_ONLY` | Commented in `.env.example` overrides | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Runtime override |
| `RECONCILIATION_POSITION_THRESHOLD` | Commented in `.env.example` overrides | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Runtime override |
| `RECONCILIATION_BALANCE_THRESHOLD` | Commented in `.env.example` overrides | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Runtime override |
| `RECONCILIATION_AUTO_CORRECT` | Commented in `.env.example` overrides | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Runtime override |
| `STREAM_RECONNECT_BASE_MS` | Commented in `.env.example` overrides | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Runtime override |
| `STREAM_RECONNECT_MAX_MS` | Commented in `.env.example` overrides | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Runtime override |
| `STREAM_MAX_RECONNECT_ATTEMPTS` | Commented in `.env.example` overrides | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Runtime override |
| `MARKING_STALENESS_MS` | Commented in `.env.example` overrides | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Runtime override |
| `MARKING_ORACLE_BASE_URL` | Commented in `.env.example` overrides | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Runtime override |
| `BACKTEST_MAX_DATA_GAP_MS` | Commented in `.env.example` overrides | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Runtime override |
| `LIVE_ROLLOUT_ENABLED` | Commented in `.env.example` overrides | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Runtime override |
| `LIVE_ROLLOUT_MAX_ORDER_NOTIONAL_USD` | Commented in `.env.example` overrides | `.env.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Runtime override |
| `NODE_ENV` | In `.env.example` | `.env.example`, `.env.ops.dev.example`, `.env.ops.staging.example`, `.env.ops.production.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Runtime selection and script behavior |
| `LOG_FORMAT` | In `.env.example` | `.env.example`, `.env.ops.dev.example`, `.env.ops.staging.example`, `.env.ops.production.example`, `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` | Keep and duplicate | Runtime/logging behavior |
| `HEROBIDS_CONFIG_DIR` | Commented in `.env.example` | `.env.example` | Rename to `TRADERTON_CONFIG_DIR` if code permits; otherwise keep and flag anomaly | Name appears inherited from source system |
| `HYPERLIQUID_TESTNET_API_KEY` | Missing from `.env.example` | `.env.ops.dev.example`, `.env.ops.staging.example`, `.env.ops.production.example` | Add | Needed to run hyperliquid integration tests instead of self-skip |
| `HYPERLIQUID_TESTNET_SECRET` | Missing from `.env.example` | `.env.ops.dev.example`, `.env.ops.staging.example`, `.env.ops.production.example` | Add | Needed to run hyperliquid integration tests instead of self-skip |
| `HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS` | Missing from `.env.example` | `.env.ops.dev.example`, `.env.ops.staging.example`, `.env.ops.production.example` | Add | Needed to run hyperliquid integration tests instead of self-skip |
| `BYBIT_TESTNET_API_KEY` | Missing from `.env.example` | `.env.ops.dev.example`, `.env.ops.staging.example`, `.env.ops.production.example` | Add | Needed to run bybit integration tests instead of self-skip |
| `BYBIT_TESTNET_SECRET` | Missing from `.env.example` | `.env.ops.dev.example`, `.env.ops.staging.example`, `.env.ops.production.example` | Add | Needed to run bybit integration tests instead of self-skip |
| `BASE_RPC_URL` | Missing from `.env.example` | `.env.ops.dev.example`, `.env.ops.staging.example`, `.env.ops.production.example` | Add | 1inch integration tests and validator read this exact name today |
| `ONEINCH_API_URL` | Missing from `.env.example` | `.env.ops.dev.example`, `.env.ops.staging.example`, `.env.ops.production.example` | Add | 1inch validator reads this exact name today |

## Minimum First-Cut Split

If the full seven-example layout feels too large for one change, the minimum viable split that still reduces most confusion is:

1. keep `.env.example` for boundary runtime only
2. add `.env.ops.dev.example` for all validator/test/operator-local inputs
3. add `.env.ops.staging.example` and `.env.ops.production.example` for remote operator flows
4. move validator/test-only variables out of `.env.example`
5. leave `infra/hetzner/*` for the first deploy-focused follow-up if Traderton is not yet carrying Hetzner infra code

That first cut resolves the most important confusion without blocking future infra alignment.

## Non-Goals

1. This document does not require code changes immediately.
2. This document does not force a deployment stack decision for Traderton.
3. This document does not change config/default.yaml semantics.
4. This document does not remove backward-compatible env aliases in the same change unless the calling scripts are migrated first.
