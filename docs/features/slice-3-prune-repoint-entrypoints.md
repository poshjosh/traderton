# Slice 3 — Prune & repoint the herobids test entrypoints for the cross-stack world

**Status:** PLAN — not yet implemented. Hand to an implementing agent.
**Doc home:** mirrors `traderton/docs/features/shell-test-cross-stack-plan.md` (parent).
**Depends on:** Slice 1 (cross-stack harness — DONE) and Slice 2 (venue validators
migrated out of herobids). Do Slice 2 first; this slice assumes the `validate-*`
scripts are already gone from herobids.

---

## 0. Read this first — you have NO prior context

You are implementing one slice of a larger migration. Do not trust your memory of
these repos — **verify every factual claim here with the ripgrep commands provided.**

### High-level objective (the epic)
Trading was extracted from `herobids` into sibling repo `traderton`, which owns the
trading engine + venues behind an **HMAC REST boundary**. herobids consumes it. Goal:
legal isolation (no trading in herobids). **Merge to `main` is human-gated — never
done by an agent.**

### Repos / branches
- herobids: `/Users/chinomso.ikwuagwu/dev_ai/hero-trade/herobids`, work branch `consume-traderton` (this slice edits ONLY herobids).
- traderton: `/Users/chinomso.ikwuagwu/dev_ai/hero-trade/traderton`, branch `l3-integration` (referenced by the harness; not edited here).
- Confirm branch: `git -C herobids branch --show-current` → must be `consume-traderton`.
- **Nothing merges to `main`.**

### How this slice fits
The two herobids shell-test entrypoints predate the migration and assume trading is
**in-process** in the herobids worker. Post-migration, trading is behind the traderton
boundary. This slice updates the entrypoints so that (a) they bring up the boundary
whenever they stand up the herobids api/worker, and (b) their docs/tier tables reflect
reality (venue validators moved to traderton in Slice 2; the boundary is now part of
the stack). Slice 1 already built the reusable harness this slice wires in.

---

## 1. Rules (from herobids/AGENTS.md + the epic)

1. **Copy-never-author** applies to test *content*; here you are editing *orchestration*
   (the entrypoints) — that is legitimate seam work. Do NOT change what the individual
   test scripts assert.
2. **Preserve the unstable-test gate verbatim.** `run-extra-tests.sh` has a
   `RUN_UNSTABLE_LLM_LATENCY_TESTS` gate + references to bug `2026-09-05/001` that skip
   three flaky LLM-latency tests by default. This is ORTHOGONAL to the migration — do
   NOT change, weaken, or remove it. (VERIFY it still reads as before after your edits.)
2. **Preserve the existing stack-lifecycle discipline.** Both entrypoints only tear
   down services THEY started; pre-existing services are left running. Keep that.
3. **Commit herobids only, on `consume-traderton`.** Explicit `git add <paths>`.
   Single-line `-m`, no backticks. Never `--no-verify`. Identity-config warning: ignore.
4. **Verify with ripgrep (`rg`), never the editor's glob/grep tool** — it false-greens
   in this repo.
5. **Do not merge to `main`.**

### Decisions already settled (do not relitigate)
- The boundary is brought up **unconditionally** whenever the entrypoints start
  api/worker — there is **NO `--cross-stack` flag**. Rationale: trading is ALWAYS
  behind the boundary now (the herobids trading tools fail-closed without it), so a
  "herobids stack without the boundary" is not a valid mode. (This was explicitly
  decided; do not add a toggle.)
- Re-use the existing composes (herobids + traderton) via project-name isolation +
  host-port remap — do NOT author a third combined compose. Slice 1 already created
  the mechanism (see §3).

---

## 2. Scope

Edit the two herobids entrypoints:
- `herobids/scripts/shell/tests/run-all-tests.sh`
- `herobids/scripts/shell/tests/run-extra-tests.sh`

Two kinds of change:
- **(A) Behavioural:** for any tier that starts the herobids api/worker, ALSO bring up
  the traderton boundary first (remapped ports + `/health/ready` gate + the
  `host.docker.internal` wiring), reusing the Slice-1 harness/overlays. Without the
  boundary, all trading-path tests fail-closed.
- **(B) Documentation/tier tables:** remove references to the migrated venue validators
  (`validate-1inch.sh`, `validate-jupiter.sh` — gone after Slice 2), and update tier
  headers to state the boundary is always brought up. Update the `validate-swap-venue.sh`
  mention per its Slice-2 disposition (deferred, still present).

Out of scope: the individual test scripts' logic; the traderton side; anything on `main`.

---

## 3. Ground truth (VERIFY each)

### 3a. The Slice-1 harness + overlays this slice reuses (in herobids)
**`herobids/scripts/shell/run/with-boundary.sh` is the CANONICAL, single-source-of-truth
way to stand up the cross-stack herobids→boundary→traderton stack.** READ ITS HEADER
FIRST — it documents the exact bring-up commands, the `--keep-up` flag, the
`TRADERTON_DIR` env, the required matching `.env` credentials, and the leaked-state
cleanup commands. This slice should REUSE it (reference/factor it), NOT re-derive the
bring-up. It brings up the traderton boundary stack (project `traderton_xstack`,
remapped ports pg 5433 / redis 6380, boundary 8080), waits
`curl -sf http://localhost:8080/health/ready`, applies the herobids overlay, and can
run test scripts with `API_BASE_URL=http://localhost:3000`.
- `herobids/docker/traderton-xstack.override.yml` — remaps traderton's host ports
  (uses the `!override` YAML tag so compose REPLACES the `ports:` list instead of
  merging — see §7).
- `herobids/docker/xstack.override.yml` — adds `extra_hosts: host.docker.internal:host-gateway`
  + the `TRADERTON_BOUNDARY_URL` to herobids api/worker so they reach the boundary.
VERIFY: `ls herobids/scripts/shell/run/with-boundary.sh herobids/docker/traderton-xstack.override.yml herobids/docker/xstack.override.yml`
and `sed -n '1,140p' herobids/scripts/shell/run/with-boundary.sh`.

### 3b. Neither entrypoint currently starts the boundary
VERIFY (expect NO hits):
`rg -n "boundary|traderton|health/ready|host.docker.internal|with-boundary|xstack" herobids/scripts/shell/tests/run-all-tests.sh herobids/scripts/shell/tests/run-extra-tests.sh`

### 3c. Where the venue validators are referenced (what to prune)
As of writing, the only entrypoint reference is a header comment in
`run-extra-tests.sh` (~lines 5-6): "The 3 venue-validation scripts (validate-1inch.sh,
validate-jupiter.sh, validate-swap-venue.sh) are excluded ...". After Slice 2,
`validate-1inch.sh`/`validate-jupiter.sh` no longer exist; only `validate-swap-venue.sh`
remains (deferred). VERIFY current references:
`rg -n "validate-1inch|validate-jupiter|validate-swap-venue" herobids/scripts/shell/tests/run-all-tests.sh herobids/scripts/shell/tests/run-extra-tests.sh`
Also re-verify the files are actually gone (Slice 2 done):
`ls herobids/scripts/shell/tests/validate-*.sh` (expect only `validate-swap-venue.sh`).

### 3d. The unstable gate to PRESERVE
VERIFY it exists and note its shape so you can confirm it's unchanged after:
`rg -n "RUN_UNSTABLE_LLM_LATENCY_TESTS|2026-09-05/001" herobids/scripts/shell/tests/run-extra-tests.sh`

### 3e. How the entrypoints start the herobids stack today
Both use `docker compose -f "${ROOT}/docker-compose.yaml" ...` to bring up
postgres/redis/migrate then api/worker (run-all-tests §Step 2/5/6; run-extra §Tiers
3-5 infra block). READ those blocks so your boundary-bring-up slots in at the right
place (BEFORE api/worker start, since api/worker now need the boundary reachable).

---

## 4. Implementation steps

### 4a. Add unconditional boundary bring-up
In BOTH entrypoints, at the point where they are about to start the herobids **api**
(and worker), FIRST ensure the traderton boundary is up. `with-boundary.sh` (§3a) is
the canonical bring-up — prefer reusing it over re-deriving the compose invocations.
Two acceptable shapes — pick the one that fits each script with the SMALLEST change:

- **Preferred:** factor the boundary bring-up out of `with-boundary.sh` into a small
  reusable step (a sourced function, or a `with-boundary.sh --up-only`-style mode you
  add) and call it from both entrypoints, so there is ONE definition of "start the
  boundary + wait for /health/ready + apply the herobids overlay + tear down what we
  started". Do NOT copy-paste the compose invocation into three places — reference the
  harness so it stays the single source of truth.
- **Minimum:** inline, in each entrypoint's stack-startup block:
  1. `docker compose -p traderton_xstack -f "${TRADERTON_DIR:-$ROOT/../traderton}/docker-compose.yml" -f "$ROOT/docker/traderton-xstack.override.yml" up -d --build`
  2. wait for `curl -sf http://localhost:8080/health/ready` (budget ~45×2s, matching the harness)
  3. start herobids api/worker WITH the overlay: add `-f "$ROOT/docker/xstack.override.yml"` to the existing `docker compose ... up -d ... api worker` invocation (so they get `host.docker.internal` + `TRADERTON_BOUNDARY_URL`).
  4. On teardown, tear down what THIS script started, including the `traderton_xstack`
     project — mirror the existing created-vs-started nuance already in these scripts
     (and in `with-boundary.sh`). Do NOT tear down a boundary that was already running.

Apply to:
- `run-all-tests.sh`: the tier(s) that start api/worker — "Step 5 (API smoke)" and
  "Step 6 (full stack for E2E)". Any tier that curls `http://localhost:3000` needs the
  boundary up first.
- `run-extra-tests.sh`: the "Infrastructure / postgres + redis + api + worker" block
  feeding Tiers 3-5.

Requirement: the boundary bring-up is **unconditional** for those tiers (no flag).

### 4b. Prune migrated-validator references + update tier docs
- `run-extra-tests.sh` header (~lines 5-6): the venue-validation scripts are no longer
  "3 ... excluded"; `validate-1inch.sh`/`validate-jupiter.sh` were **migrated to
  traderton** (Slice 2). Update the wording to reflect that only `validate-swap-venue.sh`
  remains (operator-only, deferred). Do not reference the deleted scripts as if present.
- If EITHER entrypoint invokes `validate-1inch.sh`/`validate-jupiter.sh` anywhere in a
  tier body or dry-run plan (verify with §3c grep), remove those invocations. (Per
  current grep they are NOT invoked, only mentioned — but re-verify; do not assume.)
- Update tier-table/header comments that describe the stack to note the traderton
  boundary is brought up alongside api/worker.

### 4c. Preserve the unstable gate
Leave the `RUN_UNSTABLE_LLM_LATENCY_TESTS` gate, its Tier-5 skip logic, the dry-run
plan lines, and the bug-`2026-09-05/001` references EXACTLY as they are. After editing,
re-run §3d's grep and confirm identical.

---

## 5. Verification (must pass before commit)

Static:
```
# boundary bring-up now present + unconditional in both entrypoints:
rg -n "health/ready|traderton_xstack|xstack.override" herobids/scripts/shell/tests/run-all-tests.sh herobids/scripts/shell/tests/run-extra-tests.sh   # expect hits in both
# migrated validators no longer referenced (validate-swap-venue may remain):
rg -n "validate-1inch|validate-jupiter" herobids/scripts/shell/tests/run-all-tests.sh herobids/scripts/shell/tests/run-extra-tests.sh   # expect: no matches
# unstable gate preserved:
rg -n "RUN_UNSTABLE_LLM_LATENCY_TESTS|2026-09-05/001" herobids/scripts/shell/tests/run-extra-tests.sh   # expect: same as before
# bash syntax OK:
bash -n herobids/scripts/shell/tests/run-all-tests.sh && bash -n herobids/scripts/shell/tests/run-extra-tests.sh
# dry-run plan still renders (run-extra supports --dry-run):
bash herobids/scripts/shell/tests/run-extra-tests.sh --dry-run
```

Live (Docker required; the cross-stack stacks may already be up from earlier work):
```
# From herobids, a no-creds tier through the always-on boundary. Prereqs: traderton
# checkout at ../traderton; docker running. Clean any leaked state first (see §7).
bash herobids/scripts/shell/tests/run-extra-tests.sh --tier 1,2,4
```
Expected GREEN without external creds: Tiers 1 (no-stack), 2 (redis-only), 4
(full-stack-no-keys) — the boundary comes up, api/worker reach it, and the
ADAPT-FOR-REST tests in those tiers pass (Slice 1 proved the individual scripts pass
cross-stack). Tier 5 (venue keys) and Tier 6 (external infra) + the unstable LLM tests
are NOT expected to pass without creds — do not treat their skips/failures as regressions.

If a tier that previously passed now fails ONLY because the boundary didn't come up
(e.g. `../traderton` missing, or port 8080 taken), that's an environment issue, not a
code defect — report it, don't paper over it.

---

## 6. Commit (herobids only, `consume-traderton`)
`git add herobids/scripts/shell/tests/run-all-tests.sh herobids/scripts/shell/tests/run-extra-tests.sh` (+ any harness file you refactored). Message e.g.
`test(consume): entrypoints always bring up the traderton boundary; drop migrated venue validators`.

---

## 7. Gotchas / landmines (learned the hard way this epic)
- **glob/grep search tool false-greens — use `rg`.**
- **Compose merges `ports:` across `-f` files (does NOT replace).** The traderton
  port remap overlay uses the `!override` YAML tag for exactly this reason — without
  it, both 5432 AND 5433 (and 6379/6380) get published and collide with herobids.
  If you touch the overlay, keep `!override`. (Requires Docker Compose ≥ 2.24.)
- **Separate Docker networks:** from INSIDE the herobids api/worker containers the
  boundary is NOT at `localhost:8080` — it's `host.docker.internal:8080` (via the
  `xstack.override.yml` `extra_hosts`). On Linux CI, confirm `host-gateway` resolves.
- **HMAC + encryption creds come from `.env`** on both sides (herobids
  `TRADERTON_BOUNDARY_*`, traderton `BOUNDARY_*` + `CREDENTIAL_ENCRYPTION_KEY`), and
  they MUST match. `.env` files are gitignored (not your concern to edit here, but if
  a run fails with `authentication.invalid_caller` it's a cred mismatch, not a code
  bug).
- **Boundary image build is slow on first run** (`--build` builds traderton migrate +
  boundary). Use a generous `/health/ready` wait (the harness uses ~45×2s).
- **State accumulation:** these tests create connections (herobids DB) + venue accounts
  (traderton DB). A completed `bot-trade-test` now deprovisions itself (Slice 1), but
  FAILED runs can leak. If a run fails "ambiguous" / "connection limit reached", clear
  leaked rows before re-running (herobids `connections` for the test user; traderton
  `bots` then `venue_accounts`). Do this to un-block a run, NOT to mask a real failure.
- **Do NOT add a `--cross-stack` flag.** The boundary is unconditional (settled §1).

---

## 8. Definition of done
- Both entrypoints bring up the traderton boundary (remapped ports + `/health/ready`
  gate + herobids overlay) unconditionally for any tier that starts api/worker.
- No references to the migrated `validate-1inch.sh`/`validate-jupiter.sh` remain;
  `validate-swap-venue.sh` mention updated to its deferred status.
- The `RUN_UNSTABLE_LLM_LATENCY_TESTS` gate + bug-`2026-09-05/001` docs are byte-for-byte
  preserved.
- `bash -n` clean; `--dry-run` renders; a `--tier 1,2,4` run is green without creds.
- One herobids commit on `consume-traderton`. Nothing on `main`.
- Existing stack-lifecycle (start-only-what-was-down, teardown-on-exit) preserved.
