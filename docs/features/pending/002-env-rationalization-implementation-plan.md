# Traderton Env Rationalization Implementation Plan

## Goal

Adopt a role-based environment-file layout that mirrors herobids' operator workflow while satisfying Traderton's stricter `.example`-twin rule and reducing ambiguity around test skips, validator warnings, and runtime-vs-ops ownership.

This plan uses the variable mapping table in `docs/features/pending/001-env-file-design-and-variable-mapping.md` as the source of truth for file placement.

## Success Criteria

1. A new operator can tell which file to edit without reading shell scripts.
2. Boundary/runtime env examples no longer imply that validator-only secrets are required for process boot.
3. Local extra-test runs default to an ops-oriented env file rather than the runtime `.env`.
4. Test output distinguishes `PASS`, `SKIP`, `WARN`, and `FAIL` consistently.
5. Every real `.env*` variant introduced by the change has a committed `.example` twin.
6. Docs and script help text all point at the same file names.

## Proposed Target Layout

| Role | Real files | Example files |
|---|---|---|
| Local runtime | `.env` | `.env.example` |
| Local ops/testing | `.env.ops.dev` | `.env.ops.dev.example` |
| Remote ops | `.env.ops.staging`, `.env.ops.production` | `.env.ops.staging.example`, `.env.ops.production.example` |
| Infra backend | `infra/hetzner/.env.backend` | `infra/hetzner/.env.backend.example` |
| Infra runtime | `infra/hetzner/.env.staging`, `infra/hetzner/.env.production` | `infra/hetzner/.env.staging.example`, `infra/hetzner/.env.production.example` |

## Work Phases

### Phase 1 — Establish file families

1. Add `.env.ops.dev.example`.
2. Add `.env.ops.staging.example`.
3. Add `.env.ops.production.example`.
4. If Traderton is ready to own Hetzner deployment files, add `infra/hetzner/.env.backend.example`, `infra/hetzner/.env.staging.example`, and `infra/hetzner/.env.production.example` together with the matching ignore rules and README guidance.
5. Keep `.env.example` but narrow its scope to runtime/boundary inputs only.

### Phase 2 — Move variables to the correct family

1. Remove validator-only secrets and knobs from `.env.example`.
2. Add all Tier 5 and Tier 6 test credentials to `.env.ops.dev.example`.
3. Mirror the remote-operator subset into `.env.ops.staging.example` and `.env.ops.production.example`.
4. Keep runtime overrides in `.env.example`, but clearly label them as optional config overrides rather than required env.
5. Add the currently missing test variables from the mapping table:
   - `HYPERLIQUID_TESTNET_API_KEY`
   - `HYPERLIQUID_TESTNET_SECRET`
   - `HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS`
   - `BYBIT_TESTNET_API_KEY`
   - `BYBIT_TESTNET_SECRET`
   - `BASE_RPC_URL`
   - `ONEINCH_API_URL`

### Phase 3 — Normalize script defaults and env-name semantics

1. Change local operator scripts such as `scripts/shell/tests/run-extra-tests.sh`, `scripts/shell/tests/validate-1inch.sh`, and `scripts/shell/tests/validate-jupiter.sh` to default to `.env.ops.dev` rather than `.env`.
2. For remote operator scripts, default to `.env.ops.staging` or `.env.ops.production` where the script role is explicit.
3. Keep backward-compatible alias reads temporarily where necessary, but document one primary env name per concept.
4. Resolve the `BASE_RPC_URL` versus `ONEINCH_RPC_URL` split explicitly:
   - use one as the documented primary name in ops examples
   - if compatibility is needed, scripts should accept the alias but mention it as secondary
5. Resolve the `ONEINCH_API_URL` versus `ONEINCH_BASE_URL` split the same way.

### Phase 4 — Clarify test and validator output

1. Update `run-extra-tests.sh` so the summary distinguishes:
   - executed and passed suites
   - skipped suites due to missing optional credentials
   - validator warnings
   - actual failures
2. Update `validate-1inch-launch.ts` so missing `ONEINCH_ROUTER_ADDRESS` is emitted as `WARN`, not `FAIL`, when it is the only issue.
3. Ensure the final summary reflects the same semantics as the individual lines.
4. Prefer summaries like `0 executed, 3 skipped` over generic green success messages when no credential-gated suites actually ran.

### Phase 5 — Add drift protection

1. Add or extend drift tests so each `.example` file stays aligned with the code/scripts that read it.
2. Add a script-level check for the new ops env examples, not just the runtime `.env.example`.
3. Ensure any new `.env` variant added later fails review unless its `.example` twin exists.

### Phase 6 — Update repo documentation

1. Update the root README with the new file families and intended usage.
2. Update shell script help text to reference the correct default env file.
3. Update any deployment or verification docs that still assume `.env` is the home for operator credentials.
4. Record any retained alias or naming anomaly in the deviations log if it cannot be removed immediately.

## Recommended Sequencing

### Slice A

1. Create the new `.example` files.
2. Move variable documentation according to the mapping table.
3. Update `.gitignore` for the new real-file variants.

### Slice B

1. Change script defaults from `.env` to `.env.ops.dev`.
2. Update help text and README references.
3. Preserve alias compatibility where needed.

### Slice C

1. Improve test and validator messaging.
2. Add summary counts for executed/skipped/warned checks.

### Slice D

1. Add drift/consistency tests.
2. Run the relevant shell/test validation.

## Risks And Controls

| Risk | Why it matters | Control |
|---|---|---|
| Breaking existing local operator workflows | People may already rely on `.env` for validators/tests | Keep `--env-file` override support and, if necessary, temporary fallback behavior during migration |
| Name churn across scripts | Renaming env vars too aggressively can silently break operators | Choose a documented primary name, keep aliases briefly, then remove later |
| Incomplete example coverage | New split can increase drift surface if not tested | Add drift checks for every example family |
| Premature infra scaffolding | Traderton currently may not own a Hetzner tree | Keep infra env examples as a follow-up slice unless deploy code lands in the same branch |

## Recommended First Implementation Branch Scope

The smallest high-value branch is:

1. add `.env.ops.dev.example`, `.env.ops.staging.example`, `.env.ops.production.example`
2. slim `.env.example` to runtime/boundary inputs
3. update local test/validator scripts to default to `.env.ops.dev`
4. fix the misleading validator/test summary messaging
5. add drift protection for the new examples

This delivers the cognitive-load win without requiring a deploy-stack expansion in the same change.

## Acceptance Checklist

- [ ] `.env.example` contains runtime/boundary env only
- [ ] validator-only and integration-test-only vars are moved to ops examples
- [ ] missing Tier 5/Tier 6 env vars are documented in ops examples
- [ ] local ops scripts default to `.env.ops.dev`
- [ ] router-address absence is rendered as `WARN`, not `FAIL`
- [ ] extra-test summary differentiates executed from skipped suites
- [ ] new `.env*` variants each have committed `.example` twins
- [ ] docs and help text reference the same filenames everywhere
