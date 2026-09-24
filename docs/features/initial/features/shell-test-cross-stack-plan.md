# Shell-Test Cross-Stack Plan — testing herobids-consuming-traderton before merge

Status: PLAN ONLY (do not implement from this doc directly; hand to the Implementer slice by slice).
Doc home convention: mirrors `traderton/docs/features/initial/features/herobids-config-cleanup-plan.md`.

## 0. Goal & framing

Make herobids' existing shell tests exercise the **herobids → boundary → traderton** path
end-to-end, so we can validate `herobids-consuming-traderton` before any merge to `main`.

The core insight (established ground truth — do NOT re-investigate): the agent/trading shell
tests are **black-box HTTP clients**. They drive herobids REST endpoints via `API_BASE_URL`
(default `http://localhost:3000`) with `fetch` — `/bots`, `/decisions`, `/positions`,
`/agents/:id/capabilities/trading/positions`. They do NOT import the herobids trading engine.
herobids' API (`apps/api/src/routes/bots.ts` → `tradertonClient.invoke`, boundary MANDATORY) and
worker tools (`tools/bots.ts`, `tools/trading.ts`) delegate trading to the traderton boundary.
So these tests already exercise the cross-stack path **by construction** — their test logic needs
**no rewrite**. What is missing is a **run harness** that stands up both stacks with the boundary
wired.

Therefore this is mostly a **harness + migration** effort, not a test-rewrite effort.

### Copy-never-author (applies to every slice)
- Tests migrated to traderton are **COPIED** (the parity harness travels with the behaviour), not
  rewritten from a model of how they "should" work.
- The only things authored are **deletions** and **thin seams** (import repoints, harness glue,
  compose wiring).
- After any deletion in a repo: that repo's build compiles and its copied tests pass.

### Branch & repo discipline (applies to every slice)
- herobids edits happen ONLY on branch `consume-traderton`. traderton work on `l3-integration`.
- **NOTHING merges to `main`** in either repo — human-gated (see §7).
- Commit herobids and traderton **separately**, each in its own repo, with explicit
  `git add <paths>` (never `git add -A`/`.`). Single-line `-m` messages, no backticks. Never
  `--no-verify`.
- `.env.example` twin rule: any new/changed env var updates the matching `.example` in the SAME
  change (and add a `!.env.<name>.example` un-ignore line to `.gitignore` for any new twin).
- Verify with **ripgrep** (`rg`) — the glob/grep tooling false-greens in these repos.

---

## Ground truth confirmed against the repos (file-level anchors)

herobids (`/Users/chinomso.ikwuagwu/dev_ai/hero-trade/herobids`):
- Composes: `docker-compose.yaml` (base: postgres `5432`, redis `6379`, api `3000`, worker, web
  `5173`, plus docker-proxy/skills-api), `docker-compose.dev.yaml` (hot-reload overlay).
- api & worker: `env_file: .env` + inline `environment:`. **No `TRADERTON_BOUNDARY_*` keys in
  either compose** — boundary config reaches the containers ONLY via `.env`. api/worker sit on the
  default `herobids_default` network; **no `extra_hosts` / `host.docker.internal` mapping exists
  today.**
- Test entrypoints: `scripts/shell/tests/run-all-tests.sh`, `scripts/shell/tests/run-extra-tests.sh`.
- ADAPT-FOR-REST scripts live in `scripts/shell/tests/`: `bot-trade-test.sh`, `agent-trade-test.sh`,
  `agent-scanner-gated-lifecycle-test.sh`, `scanner-provider-smoke-test.sh`,
  `preset-review-gap-closure-test.sh`, `platform-preset-assessment-test.sh`, `agent-bot-e2e-test.sh`
  (+ helper `scripts/ts/agent-bot-cascade-test.ts`), `agent-watch-invariants.sh`,
  `agent-evaluation-test.sh`.
- Venue validators (MIGRATE): `scripts/shell/tests/validate-1inch.sh` and `validate-jupiter.sh` are
  thin bash wrappers that `source .env.ops.dev` then `exec npx tsx ts/validate-{1inch,jupiter}-launch.ts`.
  The real logic is `scripts/ts/validate-1inch-launch.ts` and `scripts/ts/validate-jupiter-launch.ts`,
  which import `@herobids/venues` (`JupiterSwapAdapter`, `JupiterConfirmationPoller`, `SolanaSigner`;
  `OneInchSwapAdapter`, `EvmSigner`, `EvmConfirmationPoller`) and `@herobids/domain` (`quantity`).
  `validate-swap-venue.sh` is **pure bash** — probes API `/health` + hits venue quote HTTP directly;
  imports nothing; NOT in CI (operator-only).
- Unstable-test gate already exists in `run-extra-tests.sh`: `RUN_UNSTABLE_LLM_LATENCY_TESTS=1`
  un-skips `agent-trade-test`, `preset-review-gap-closure`, `scanner-provider-smoke` (Tier 5),
  documented against bug `docs/features/initial/ug-reports/2026/09/05/001-agent-activation-timeout-cumulative-launch-latency.md`.

traderton (`/Users/chinomso.ikwuagwu/dev_ai/hero-trade/traderton`):
- Compose: `docker-compose.yml` — services `postgres` (`5432`), `redis` (`6379`), `migrate`,
  `boundary` (`8080`, `/health/ready` gate). Boundary bakes LOCAL-DEV signing creds:
  `BOUNDARY_CONSUMER_ID=dev-consumer`, `BOUNDARY_KEY_ID=dev-key`,
  `BOUNDARY_SIGNING_SECRET=dev-signing-secret`,
  `CREDENTIAL_ENCRYPTION_KEY=0000…` (64 hex). **Its postgres/redis ports collide with herobids.**
- Harness: `scripts/shell/tests/run-all-tests.sh` (unit + integration + `--e2e` boundary stack +
  signed invokes via `packages/boundary/dist/dev/boundary-e2e.js`), `run-extra-tests.sh`,
  `scripts/run-integration.sh`.
- Venues: `@traderton/venues` (`packages/venues`) exports `JupiterSwapAdapter`, `OneInchSwapAdapter`,
  `JupiterConfirmationPoller`, `EvmConfirmationPoller`, `SolanaSigner`, `deriveSolanaAddress`,
  `EvmSigner`, `quantity` lives in `@traderton/domain`. Adapters already exist at
  `packages/venues/src/{jupiter-swap,oneinch-swap}.ts`.

---

## Slice ordering (execute in this order)

1. **Slice 1 — herobids cross-stack run harness** (the always-on boundary). Delivers the ability to
   run the ADAPT-FOR-REST tests against the real cross-stack path.
2. **Slice 2 — migrate venue-parity validators to traderton** (copy + repoint + delete originals).
   Independent of Slice 1; can run in parallel but is ordered second because Slice 1 is the
   critical path for "can we test the consumer at all."
3. **Slice 3 — prune / repoint herobids entrypoints & docs** (reflect the always-on boundary and the
   moved venue validators). Depends on Slices 1 and 2 being landed.

---

## Slice 1 — herobids cross-stack run harness (always-on boundary)

**Repo/branch:** herobids on `consume-traderton`.

**Intent:** the herobids test entrypoint(s) must ALWAYS bring up the traderton boundary and wire
herobids api/worker to it. There is **NO `--cross-stack` flag** — trading is always behind the
boundary now (the tools fail-closed without it), so standing up the herobids stack for tests
ALWAYS includes the boundary. Re-use the two EXISTING composes under different project names with
remapped host ports; do NOT author a third duplicate compose.

### The three specifics that must be solved

1. **Port collision.** Both composes publish postgres `5432` and redis `6379`. Keep herobids on
   `5432/6379/3000`. Remap the traderton stack's published host ports to **postgres `5433`, redis
   `6380`**; boundary stays **`8080`**. Do the remap without editing traderton's committed
   `docker-compose.yml` (Slice 2/other traderton work must not fight this): use a
   herobids-side overlay or env-substituted publish, e.g. run the traderton stack with
   `-p traderton_xstack` (project-name isolation) and a small overlay file kept in herobids
   (proposed `docker/traderton-xstack.override.yml`) that only remaps `ports:` for postgres/redis.
   Rationale: traderton's internal service-to-service ports are unchanged (boundary still talks to
   its own pg/redis over the compose network); only the HOST publish is remapped to avoid the
   collision on the developer machine.

2. **Network reachability.** The two composes are **separate Docker networks**. From INSIDE the
   herobids api/worker containers, the boundary is NOT at `localhost:8080`. It must be reached at
   `host.docker.internal:8080` (Docker Desktop/macOS), i.e. the traderton boundary published on the
   host (`8080`) and herobids pointed at `host.docker.internal:8080`. herobids api/worker need
   `extra_hosts: ["host.docker.internal:host-gateway"]` added (they have none today). This goes in a
   herobids test overlay (proposed `docker/xstack.override.yml`) applied on top of
   `docker-compose.yaml`, NOT baked into the base compose (base must stay boundary-agnostic for
   non-test use).

3. **HMAC match.** herobids' `TRADERTON_BOUNDARY_CONSUMER_ID / KEY_ID / HMAC_SECRET` MUST equal
   traderton's `BOUNDARY_CONSUMER_ID / KEY_ID / BOUNDARY_SIGNING_SECRET`. For LOCAL runs mirror the
   traderton compose dev values (`dev-consumer` / `dev-key` / `dev-signing-secret`) into herobids'
   env. These are **non-secret local-dev values**, safe to document in an `.example`. herobids
   api/worker read `TRADERTON_BOUNDARY_URL` + HMAC creds
   (`TRADERTON_BOUNDARY_HMAC_SECRET / CONSUMER_ID / KEY_ID / TIMEOUT_MS`) via `ENV_OVERRIDES` →
   `boundary.*` config; today they arrive ONLY through `.env`. The overlay must set (or `.env` must
   carry):
   - `TRADERTON_BOUNDARY_URL=http://host.docker.internal:8080`
   - `TRADERTON_BOUNDARY_CONSUMER_ID=dev-consumer`
   - `TRADERTON_BOUNDARY_KEY_ID=dev-key`
   - `TRADERTON_BOUNDARY_HMAC_SECRET=dev-signing-secret`
   - `TRADERTON_BOUNDARY_TIMEOUT_MS` (carry existing default; only set if the code needs it)

   > OPEN QUESTION (verify at implementation, do NOT guess): confirm the EXACT env-var names the
   > herobids `ENV_OVERRIDES` map expects for the boundary block by ripgrepping the herobids config
   > loader (`rg -n "TRADERTON_BOUNDARY" apps config packages`). The names above are from the
   > established ground truth; reconcile against the code before writing the overlay/`.example`.

### File-level changes (Slice 1)

- ADD `docker/xstack.override.yml` (herobids) — test-only overlay applied over `docker-compose.yaml`:
  - `api` and `worker`: add `extra_hosts: ["host.docker.internal:host-gateway"]` and the
    `TRADERTON_BOUNDARY_*` `environment:` entries above (or rely on `.env` — pick one, document it).
- ADD `docker/traderton-xstack.override.yml` (herobids) — overlay for the traderton stack that ONLY
  remaps published host ports (postgres `5433:5432`, redis `6380:6379`; boundary `8080:8080`
  unchanged). Applied when bringing the traderton stack up from herobids via `../traderton`.
- ADD a harness entrypoint (proposed `scripts/shell/run/with-boundary.sh`, or fold into the existing
  entrypoints in Slice 3) that:
  1. brings up the traderton boundary stack:
     `docker compose -p traderton_xstack -f ../traderton/docker-compose.yml -f docker/traderton-xstack.override.yml up -d --build`
  2. waits for `curl -sf http://localhost:8080/health/ready`
  3. brings up herobids with the overlay:
     `docker compose -f docker-compose.yaml -f docker/xstack.override.yml up -d --build api worker`
  4. waits for herobids `/health`
  5. runs the ADAPT-FOR-REST scripts unchanged against `API_BASE_URL=http://localhost:3000`
  6. tears down ONLY what it started (mirror the existing lifecycle discipline in
     `run-all-tests.sh` / `run-extra-tests.sh`).
- UPDATE `.env.example` (herobids) — add the four `TRADERTON_BOUNDARY_*` keys with safe local-dev
  placeholder values + one inline `#` comment each. If a new `.env` variant is introduced, create its
  `.example` twin AND add the `!.env.<name>.example` un-ignore line to `.gitignore` in the SAME change.
  (No new secret is introduced — the dev HMAC values are non-secret.)

### Verification (Slice 1) — commands + expectations

Run from the herobids repo root on `consume-traderton`:

```
# 1. Bring up traderton boundary (remapped host ports)
docker compose -p traderton_xstack -f ../traderton/docker-compose.yml \
  -f docker/traderton-xstack.override.yml up -d --build
# gate:
curl -sf http://localhost:8080/health/ready            # expect {"status":"ready"}

# 2. Bring up herobids wired to the boundary
docker compose -f docker-compose.yaml -f docker/xstack.override.yml up -d --build api worker
curl -sf http://localhost:3000/health                  # expect 200

# 3. Prove reachability from INSIDE the herobids api container
docker compose -f docker-compose.yaml exec -T api \
  node -e "fetch('http://host.docker.internal:8080/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# expect exit 0

# 4. Run the boundary-path tests that are green WITHOUT external creds:
API_BASE_URL=http://localhost:3000 bash scripts/shell/tests/bot-trade-test.sh
API_BASE_URL=http://localhost:3000 bash scripts/shell/tests/agent-scanner-gated-lifecycle-test.sh
API_BASE_URL=http://localhost:3000 bash scripts/shell/tests/agent-bot-e2e-test.sh
API_BASE_URL=http://localhost:3000 bash scripts/shell/tests/agent-watch-invariants.sh --smoke
```

Ripgrep verification (no false-greens):
```
rg -n "TRADERTON_BOUNDARY" .env.example docker/xstack.override.yml
rg -n "host.docker.internal" docker/xstack.override.yml
rg -n "traderton_xstack|host.docker.internal:8080" scripts/shell/run/with-boundary.sh
```

**Expected green without creds** (boundary path on free/mock providers): `bot-trade-test`,
`agent-scanner-gated-lifecycle`, `agent-bot-e2e`, `agent-watch-invariants --smoke`, and the boundary
reachability probe. **Needs creds / warm LLM** (do NOT expect green autonomously): `agent-trade-test`,
`preset-review-gap-closure`, `scanner-provider-smoke` (unstable under burst-start — bug 2026-09-05/001;
gated behind `RUN_UNSTABLE_LLM_LATENCY_TESTS=1`), `platform-preset-assessment` (LLM/Ollama),
`agent-evaluation` (LLM/Ollama). See §6 credentials.

### Rules recap (Slice 1)
- Copy-never-author: the ADAPT-FOR-REST test scripts are run **unchanged** — do not edit their logic.
- `.env.example` twin updated same-change for the new `TRADERTON_BOUNDARY_*` keys.
- herobids-only commit on `consume-traderton`, explicit `git add docker/xstack.override.yml
  docker/traderton-xstack.override.yml scripts/shell/run/with-boundary.sh .env.example`, single-line `-m`.
- Verify with `rg`.

---

## Slice 2 — migrate venue-parity validators to traderton

**Repos/branches:** COPY into traderton on `l3-integration`; DELETE from herobids on `consume-traderton`.
Two separate commits, one per repo.

**Intent:** `validate-1inch-launch.ts` and `validate-jupiter-launch.ts` are pure venue-adapter parity
tests — they construct the adapter and call `adapter.quote()` / `adapter.executeSwap()` in-process.
They belong with the adapters, which now live in `@traderton/venues`. Copy them across (parity harness
travels with behaviour), repoint imports, wire into traderton's harness, then delete the herobids
originals.

### File-level changes (Slice 2)

traderton (copy in, on `l3-integration`):
- COPY `herobids/scripts/ts/validate-jupiter-launch.ts` → `traderton/scripts/ts/validate-jupiter-launch.ts`.
- COPY `herobids/scripts/ts/validate-1inch-launch.ts` → `traderton/scripts/ts/validate-1inch-launch.ts`.
- COPY the shell wrappers `validate-jupiter.sh` / `validate-1inch.sh` →
  `traderton/scripts/shell/tests/`, adjusting the `REPO_ROOT`/`cd` and `tsx` path to traderton's
  layout, and the env-file source (traderton has its own `.env`/`.env.example`, not `.env.ops.dev` —
  decide the env-source at implementation and document the `.example`).
- REPOINT imports in the copied TS (straight port, no logic change):
  - `@herobids/venues` → `@traderton/venues` (`JupiterSwapAdapter`, `JupiterConfirmationPoller`,
    `SolanaSigner` for jupiter; `OneInchSwapAdapter`, `EvmSigner`, `EvmConfirmationPoller` for 1inch —
    confirm the exact 1inch symbol set by reading `validate-1inch-launch.ts` at implementation).
  - `@herobids/domain` (`quantity`) → `@traderton/domain`.
  - Verify each imported symbol is actually exported by `@traderton/venues`
    (`packages/venues/src/index.ts` already exports the Jupiter/OneInch/Evm/Solana set) and
    `@traderton/domain` before finalizing.
- WIRE into the traderton harness consistently with `run-all-tests.sh` / `run-extra-tests.sh`
  (these validators are venue-key-gated → they belong in an opt-in / credential tier, mirroring how
  herobids kept them out of the default run). They are NOT part of the default green run.
- UPDATE traderton `.env.example` if the copied wrappers read any new env keys (venue keys are
  operator-supplied; add placeholder + comment). Same-change twin rule.

herobids (delete, on `consume-traderton`):
- DELETE `scripts/shell/tests/validate-1inch.sh`, `scripts/shell/tests/validate-jupiter.sh`,
  `scripts/ts/validate-1inch-launch.ts`, `scripts/ts/validate-jupiter-launch.ts`.
- Confirm nothing else in herobids references them before deleting (see verification).
- (Entrypoint doc references to these are cleaned in Slice 3.)

### `validate-swap-venue.sh` decision (call it out explicitly)

`validate-swap-venue.sh` is **pure bash**: it probes herobids `/health` and hits the venue quote HTTP
endpoints (`api.jup.ag`, `api.1inch.dev`) DIRECTLY from the host. It imports no adapter code, is NOT
in CI, and is operator-only. **Decision: MIGRATE its venue-reachability INTENT to traderton as
LOW-PRIORITY**, because venue reachability is now a traderton concern (traderton owns the adapters).
Recommended concrete form: fold the direct-quote reachability probe into a small traderton
operator script (e.g. `traderton/scripts/shell/tests/validate-venue-reachability.sh`) OR defer it to
the improvement backlog. It does NOT block Slice 2's core migration (the two adapter parity scripts).
**Recommendation: DEFER** to the traderton improvement backlog (`docs/features/initial/10-improvement-backlog.md`) as
a low-value/low-effort item and DELETE the herobids original in Slice 2 only if nothing references it;
otherwise leave it in herobids until the backlog item lands. Flag this for the human to confirm the
disposition (delete-now vs defer-then-delete).

### Verification (Slice 2) — commands + expectations

traderton (on `l3-integration`):
```
rg -n "@herobids/" scripts/ts/validate-jupiter-launch.ts scripts/ts/validate-1inch-launch.ts
# expect: NO matches (all repointed to @traderton/*)
pnpm --filter @traderton/venues build          # adapters compile
pnpm lint                                       # type-check clean
# dry-run (no creds → should stop at the wallet/quote prereq gracefully, not crash on imports):
npx tsx scripts/ts/validate-jupiter-launch.ts   # dry-run path
```
herobids (on `consume-traderton`):
```
rg -n "validate-1inch|validate-jupiter" scripts docs
# expect: only entrypoint/doc references remaining (cleaned in Slice 3); no code imports
```

**Green without creds:** import repoint compiles; `pnpm lint` clean; dry-run reaches the
prereq/quote gate (upstream reachability may succeed on free Jupiter quote, 1inch needs a key).
**Needs creds:** live `--execute` swap submission (funded wallet / venue keys) — human-supplied,
never run autonomously.

### Rules recap (Slice 2)
- Copy-never-author: the validators are COPIED then import-repointed only; no logic rewrite. Author
  only the deletions (herobids) and the thin import/harness seams (traderton).
- After delete in herobids: `pnpm lint` / `pnpm build` clean.
- After copy in traderton: `pnpm lint` / venues build clean.
- Two SEPARATE commits (traderton copy on `l3-integration`; herobids delete on `consume-traderton`),
  explicit `git add <paths>`, single-line `-m`.
- `.env.example` twins updated same-change in whichever repo gains/loses env keys.

---

## Slice 3 — prune / repoint herobids entrypoints & docs

**Repo/branch:** herobids on `consume-traderton`. Depends on Slices 1 & 2 landed.

**Intent:** make `run-all-tests.sh` and `run-extra-tests.sh` reflect (a) the always-on boundary and
(b) the moved venue validators; remove references to migrated scripts; update tier tables/docs.

### File-level changes (Slice 3)

- UPDATE `scripts/shell/tests/run-all-tests.sh`:
  - Ensure the stack-bring-up path used for shell/API-smoke tiers ALWAYS stands up the traderton
    boundary first (call the Slice 1 harness / inline the boundary bring-up + `/health/ready` gate +
    `host.docker.internal` wiring). No `--cross-stack` flag — boundary is unconditional.
  - Update the header tier documentation to state the boundary is always brought up for any tier
    that starts api/worker.
- UPDATE `scripts/shell/tests/run-extra-tests.sh`:
  - Same unconditional boundary bring-up for Tiers 3–5 (the tiers that start api/worker).
  - Update the header comment block: the venue-validation scripts (`validate-1inch.sh`,
    `validate-jupiter.sh`) are no longer excluded-by-design — they are **gone** (migrated to
    traderton). Update the "3 venue-validation scripts excluded" wording accordingly, and the
    `validate-swap-venue.sh` line per the Slice 2 decision.
  - Preserve the existing `RUN_UNSTABLE_LLM_LATENCY_TESTS=1` gate and the bug-2026-09-05/001
    documentation verbatim — do NOT change that behaviour in this slice (it is orthogonal).
  - Preserve the existing stack-lifecycle discipline (start-only-what-was-down, teardown-on-exit).
- UPDATE any docs that enumerate the shell tests / venue validators (e.g. the tier tables in the
  entrypoint headers; ripgrep for stragglers).

### Verification (Slice 3) — commands + expectations
```
# entrypoints no longer reference migrated scripts:
rg -n "validate-1inch|validate-jupiter-launch|validate-jupiter\.sh" scripts docs
# expect: no references (except an intentional "migrated to traderton" note if added)

# boundary bring-up is present and unconditional in both entrypoints:
rg -n "health/ready|host.docker.internal|traderton_xstack" \
  scripts/shell/tests/run-all-tests.sh scripts/shell/tests/run-extra-tests.sh

# unstable gate preserved:
rg -n "RUN_UNSTABLE_LLM_LATENCY_TESTS" scripts/shell/tests/run-extra-tests.sh

# dry-run the extra harness to confirm the plan prints correctly:
bash scripts/shell/tests/run-extra-tests.sh --dry-run

# full no-creds run through the boundary:
bash scripts/shell/tests/run-extra-tests.sh --tier 1,2,4
```

**Green without creds:** Tiers 1, 2, 4 (no-stack, redis-only, full-stack-no-keys) through the
always-on boundary. **Needs creds:** Tier 5 (venue keys), Tier 6 (external infra), and the unstable
Tier-5 LLM-latency tests.

### Rules recap (Slice 3)
- herobids-only commit on `consume-traderton`; explicit `git add scripts/shell/tests/run-all-tests.sh
  scripts/shell/tests/run-extra-tests.sh <docs>`; single-line `-m`.
- No `.env` changes expected here (they landed in Slice 1); if any appear, twin same-change.
- Verify with `rg`.

---

## 6. Credentials needed (so the human can supply them on request)

The agent runs everything green **without external creds** first (Slices 1–3 no-creds tiers), then
ASKS the human before running any tier below. Real staging boundary creds also come from the human.

| Tier / test | Env vars required | Notes |
|---|---|---|
| Cross-stack boundary (LOCAL) | `TRADERTON_BOUNDARY_URL`, `TRADERTON_BOUNDARY_CONSUMER_ID`, `TRADERTON_BOUNDARY_KEY_ID`, `TRADERTON_BOUNDARY_HMAC_SECRET` | LOCAL dev values are non-secret (`dev-consumer`/`dev-key`/`dev-signing-secret`), documented in `.env.example`. STAGING values are human-supplied. |
| Tier 5 — Hyperliquid trade | `HL_API_KEY`, `HL_SECRET`, `HL_WALLET_ADDRESS` | `bot-trade-test`, `platform-preset-assessment`. |
| Venue validator — Jupiter (`--execute`) | `SOLANA_WALLET_PRIVATE_KEY` (or `JUPITER_WALLET_ADDRESS` + `JUPITER_PRIVATE_KEY`), `SOLANA_RPC_URL` | Dry-run needs no key; live swap needs a funded wallet. Now lives in traderton. |
| Venue validator — 1inch (`--execute`) | `ONEINCH_API_KEY`, `ONEINCH_PRIVATE_KEY` (confirm exact names in the copied TS) | Now lives in traderton. |
| Unstable LLM-latency (Tier 5) | `RUN_UNSTABLE_LLM_LATENCY_TESTS=1` + warm Ollama (`LLM_PROVIDER`/`LLM_LIGHT_MODEL`/`LLM_HEAVY_MODEL`, `/api/tags` reachable, models present) | `agent-trade-test`, `preset-review-gap-closure`, `scanner-provider-smoke`. Gated by bug 2026-09-05/001. Warm stack first (`reset-and-run.sh`). |
| LLM-dependent smokes | Ollama reachable + models present | `agent-evaluation`, `platform-preset-assessment` reasoning paths. |
| Tier 6 — external infra | `TELEGRAM_BOT_TOKEN`, `TEST_CHAT_IDS`; `CADDY_BASE_URL`; autoscale `BACKEND_ENV_FILE`/SSH | KEEP-HEROBIDS tests; not part of cross-stack scope but listed for completeness. |
| Billing | `BILLING_PRIMARY_PROVIDER=creem`, `CREEM_API_KEY`, `CREEM_WEBHOOK_SECRET` | Self-skips on mock provider in dev. |

---

## 7. Human-gated (NOT agent steps)

The agent stops before all of these — they are the human's:
- **Merge to `main`** (either repo) — the ONE hard stop. "Reviewed + green" is not license to merge.
- **Manual / visual testing** and **staging soak** ("run both locally and on staging for a while").
- Supplying **real staging boundary creds** and **venue/LLM credentials** for the not-green-without-creds
  tiers.
- Confirming the `validate-swap-venue.sh` disposition (delete-now vs defer-to-backlog) if the agent
  cannot decide it cleanly.

---

## 8. Verification matrix (script → bucket → green-without-creds? → needs-creds)

| Script | Bucket | Green w/o creds? | Needs (if not green) |
|---|---|---|---|
| `bot-trade-test.sh` | ADAPT-FOR-REST | Yes (boundary path) | — |
| `agent-scanner-gated-lifecycle-test.sh` | ADAPT-FOR-REST | Yes | — |
| `agent-bot-e2e-test.sh` (+ `scripts/ts/agent-bot-cascade-test.ts`) | ADAPT-FOR-REST | Yes | — |
| `agent-watch-invariants.sh` (`--smoke`) | ADAPT-FOR-REST | Yes (redis) | — |
| `scanner-provider-smoke-test.sh` | ADAPT-FOR-REST | No (unstable) | `RUN_UNSTABLE_LLM_LATENCY_TESTS=1` + warm Ollama (bug 2026-09-05/001) |
| `agent-trade-test.sh` | ADAPT-FOR-REST | No (unstable) | `RUN_UNSTABLE_LLM_LATENCY_TESTS=1` + warm Ollama (bug 2026-09-05/001) |
| `preset-review-gap-closure-test.sh` | ADAPT-FOR-REST | No (unstable) | `RUN_UNSTABLE_LLM_LATENCY_TESTS=1` + warm Ollama (bug 2026-09-05/001) |
| `platform-preset-assessment-test.sh` | ADAPT-FOR-REST | No | `HL_*` + Ollama |
| `agent-evaluation-test.sh` | ADAPT-FOR-REST | No | Ollama (light+heavy models) |
| `validate-jupiter.sh` / `validate-jupiter-launch.ts` | MIGRATE→traderton | Dry-run: partial | live `--execute`: `SOLANA_WALLET_PRIVATE_KEY` + `SOLANA_RPC_URL` |
| `validate-1inch.sh` / `validate-1inch-launch.ts` | MIGRATE→traderton | Dry-run: partial | quote+live: `ONEINCH_API_KEY` (+ `ONEINCH_PRIVATE_KEY` for `--execute`) |
| `validate-swap-venue.sh` | MIGRATE (low-pri) / DEFER | Jupiter probe: yes; 1inch: no | `ONEINCH_API_KEY` |
| `agent-config-matrix / -persistence / -document-handling` | KEEP-HEROBIDS | Yes | — |
| `runtime-policy-e2e.sh`, `test-presets.sh`, `external-skills-smoke-test.sh` | KEEP-HEROBIDS | Yes | — |
| `billing-*` (×3) | KEEP-HEROBIDS | Self-skip on mock | `creem` provider + keys |
| `browser-pool-agent-browser-smoke-test.sh` | KEEP-HEROBIDS | Yes (browserless) | — |
| `sandbox-allowlist-smoke-test.sh` | KEEP-HEROBIDS | Yes | — |
| `caddy-routing-smoke-test.sh` | KEEP-HEROBIDS | No | network to `CADDY_BASE_URL` |
| `autoscale-*` (×3) | KEEP-HEROBIDS | No | SSH + `BACKEND_ENV_FILE` |
| `test-telegram-messaging.sh`, `setup-local-telegram-webhook.sh` | KEEP-HEROBIDS | No | `TELEGRAM_BOT_TOKEN`, `TEST_CHAT_IDS` |

---

## 9. Risks & open questions

- **`host.docker.internal` on Linux.** The `:host-gateway` mapping is Docker Desktop/macOS-friendly;
  on plain Linux Docker Engine, `host-gateway` works with recent Docker but must be verified. If the
  harness runs on Linux CI, confirm `extra_hosts: ["host.docker.internal:host-gateway"]` resolves;
  fallback is a shared Docker network between the two composes (larger change — avoid unless forced).
- **Boundary image build time.** `docker compose -f ../traderton/docker-compose.yml up --build` builds
  the traderton `migrate` + `boundary` images; first run is slow. Consider a pre-build step and a
  generous `/health/ready` wait budget (traderton's own harness waits ~45×2s).
- **Ollama dependency.** `agent-trade`, `preset-review-gap-closure`, `scanner-provider` are UNSTABLE
  under burst-start (bug 2026-09-05/001) and gated behind `RUN_UNSTABLE_LLM_LATENCY_TESTS=1`; they
  also self-skip on cold Ollama. Do NOT treat them as part of the autonomous green run.
- **Port remap correctness.** Remapping only the HOST publish (5433/6380) must not break traderton's
  internal service-to-service addressing (boundary→its own pg/redis over the compose network, which
  uses service names, not host ports) — verify the boundary still reaches its DB after the remap.
- **Exact env-var names.** Confirm the herobids `ENV_OVERRIDES` boundary keys by ripgrep before
  writing the overlay/`.example` (see Slice 1 OPEN QUESTION). Do not guess the names into `.example`.
- **1inch validator import set.** Confirm the exact `@herobids/venues` symbols
  `validate-1inch-launch.ts` imports before repointing (read the file at implementation).
- **Trading packages still in herobids (OUT OF SCOPE — follow-up only).** `packages/{venues,engine,
  strategy,market-data}` still physically exist in herobids with thin residual live-app imports
  (venues:1 `deriveSolanaAddress` in setup.ts; engine:2 type-only; strategy:3; market-data:11 legit).
  The execution path is not invoked by the herobids runtime. Whether to delete them for full
  legal-isolation is a SEPARATE future slice — note only, do NOT include as work here.

---

## 10. Handoff

Slices 1–3 have no unresolved blockers that require a user decision to BEGIN (the open questions are
implementation-time verifications, not gates). The one item needing an explicit human decision is the
`validate-swap-venue.sh` disposition (§2 decision) — recommended DEFER; the Implementer should surface
it but it does not block Slices 1–3. Proceed to implementation slice by slice on the named branches;
stop at every human-gated step in §7.
