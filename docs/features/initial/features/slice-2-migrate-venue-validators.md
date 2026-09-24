# Slice 2 — Migrate venue-launch validators to traderton

**Status:** DONE — implemented on traderton `l3-integration` (commit `b0e866e`) +
herobids `consume-traderton` (commit `61d67fda`). Live-venue `--execute` verification
deferred to a human with creds; see §9 Outstanding Issues.
**Doc home:** mirrors `traderton/docs/features/initial/features/shell-test-cross-stack-plan.md` (the parent plan) and `herobids-config-cleanup-plan.md`.

---

## 0. Read this first — you have NO prior context

You are implementing one slice of a larger migration. You did not see the work
that led here. Do not trust your memory of these repos — **verify every factual
claim in this doc with the ripgrep commands provided before you rely on it.**
Assertions in docs go stale; the code is the truth.

### The high-level objective (the whole epic)
Trading was **extracted** from the `herobids` monorepo into a sibling repo
`traderton`, which now owns the trading engine + venues and exposes them over an
**HMAC-signed REST boundary**. `herobids` consumes traderton over that boundary.
The end goal is **legal isolation**: no trading logic/state/execution in herobids.
The ONE hard stop is **merge to `main`** — human-gated, never done by an agent.

### Where the repos are
- herobids: `/Users/chinomso.ikwuagwu/dev_ai/hero-trade/herobids`, work branch `consume-traderton`.
- traderton: `/Users/chinomso.ikwuagwu/dev_ai/hero-trade/traderton`, work branch `l3-integration`.
- **Nothing merges to `main` in either repo.** Confirm you are on the right branch
  before editing: `git -C <repo> branch --show-current`.

### How this slice fits
The parent plan (`shell-test-cross-stack-plan.md`) classified herobids'
`scripts/shell/tests/*` into three buckets:
- KEEP-HEROBIDS (platform tests, untouched),
- ADAPT-FOR-REST (herobids-consuming tests that drive the boundary — Slice 1, DONE),
- **MIGRATE-TO-TRADERTON** (pure venue/engine parity — **this slice**).

Slice 1 is complete (the cross-stack harness + the boundary fixes; `bot-trade-test`
and other ADAPT-FOR-REST tests pass cross-stack). Slice 3 (prune/repoint the
herobids test entrypoints) comes after this.

---

## 1. The rules you must follow (from both repos' AGENTS.md)

1. **Copy, never author.** Migrated tests are **COPIED** across, not rewritten from
   a model of how they "should" work. The only things you author are **deletions**
   and **thin seams** (import repoints, path fixes, harness glue). Do NOT change the
   validators' assertions or logic. If a straight copy won't compile without a
   logic change, STOP and report — do not invent behaviour.
2. **herobids is READ-ONLY except on `consume-traderton`.** You may delete from
   herobids ONLY on that branch (this slice does delete the originals there).
3. **`.example` twin rule.** If you add/change any `.env*` variable, update its
   committed `.example` twin in the SAME change (placeholders only, never real
   secrets).
4. **Commit herobids and traderton SEPARATELY**, each in its own repo, on its work
   branch. Explicit `git add <paths>` (never `git add -A`/`.`). Single-line `-m`,
   no backticks (zsh). Never `--no-verify`. A git identity-config warning on commit
   is expected — ignore it.
5. **Verify with ripgrep (`rg`), not the editor's glob/grep search tool.** That tool
   **false-greens** in these repos (returns "no matches" spuriously) — it caused two
   near-misses this epic. Always `rg` via the shell.
6. **Do not merge to `main`.** Human-gated.

### How to make decisions
- Prefer completing the extraction faithfully (copy source behaviour) over inventing.
- For any FOUR-RISK / contract-level choice (changing a boundary contract, a settled
  decision, or behaviour that ripples), do NOT gut-fix: surface it and route to a
  decision/pressure-test agent (see `traderton/docs/features/initial/08-decision-process.md`). This
  slice is NOT expected to hit one — it's a copy+repoint+delete — but if you do, stop.

---

## 2. What this slice does (scope)

Migrate the two **venue-launch validators** from herobids to traderton, because
they exercise the **venue adapters directly, in-process** (they import
`@herobids/venues` and call `adapter.executeSwap(...)`) — pure venue-adapter parity
that now lives in traderton. Then delete the originals from herobids.

**In scope — exactly these:**
- `herobids/scripts/shell/tests/validate-jupiter.sh` + `herobids/scripts/ts/validate-jupiter-launch.ts`
- `herobids/scripts/shell/tests/validate-1inch.sh` + `herobids/scripts/ts/validate-1inch-launch.ts`

**Decision on `validate-swap-venue.sh` (already made — do NOT migrate it in this slice):**
`herobids/scripts/shell/tests/validate-swap-venue.sh` is pure bash that probes the
herobids API `/health` + does direct venue-quote HTTP probes; it imports no adapter
code and is operator-only (not CI). Its own header says it does NOT validate adapter
wiring/signer/execution. **Decision: DEFER** it to the traderton improvement backlog
(`traderton/docs/features/initial/10-improvement-backlog.md`) as a low-value venue-reachability item;
do NOT migrate or delete it in this slice. Add a one-line backlog entry noting the
deferral. (Rationale: it's not a parity test; migrating it now is scope creep.)

**Out of scope:** the herobids test entrypoints (`run-all-tests.sh`,
`run-extra-tests.sh`) that reference these validators — Slice 3 handles their
doc/tier updates. This slice only moves the validator files + deletes the originals.

---

## 3. Ground truth (VERIFY each with the command shown)

### 3a. What the validators import (the repoint targets)
`validate-jupiter-launch.ts` imports:
```
import { JupiterSwapAdapter, JupiterConfirmationPoller, SolanaSigner } from '@herobids/venues';
import { quantity } from '@herobids/domain';
```
`validate-1inch-launch.ts` imports:
```
import { OneInchSwapAdapter, EvmConfirmationPoller } from '@herobids/venues';
import { quantity } from '@herobids/domain';
```
VERIFY: `rg -n "^import" herobids/scripts/ts/validate-jupiter-launch.ts herobids/scripts/ts/validate-1inch-launch.ts`
(The 1inch file may reference an EVM signer for `--execute`; READ THE WHOLE FILE
before repointing — do not assume the import list from this doc.)

### 3b. traderton exports the same symbols (so the repoint is a straight rename)
`@traderton/venues` (`traderton/packages/venues/src/index.ts`) exports:
`JupiterSwapAdapter`, `JupiterConfirmationPoller`, `SolanaSigner`, `deriveSolanaAddress`,
`OneInchSwapAdapter`, `EvmConfirmationPoller`, `EvmSigner`.
`@traderton/domain` exports `quantity` (used across worker/venues as
`import { price, quantity, ok } from '@traderton/domain'`).
VERIFY:
```
rg -n "export" traderton/packages/venues/src/index.ts | rg "SwapAdapter|ConfirmationPoller|Signer|deriveSolanaAddress"
rg -rn "quantity" traderton/packages/domain/src | rg "export"   # if empty, confirm via a real importer:
rg -rn "from '@traderton/domain'" traderton/packages/venues/src | rg quantity
```
If any symbol the validator imports is NOT exported by `@traderton/venues` /
`@traderton/domain`, STOP and report — do not invent an export.

### 3c. traderton scripts layout (the landing spot)
- `traderton/scripts/ts/` — exists, currently EMPTY. Put the `.ts` validators here.
- `traderton/scripts/shell/tests/` — has `run-all-tests.sh`, `run-extra-tests.sh`.
  Put the shell wrappers here.
- traderton has `tsx` available (used by the harness). VERIFY: `rg -n "tsx" traderton/package.json traderton/scripts/shell/tests/run-all-tests.sh`
- The shell wrappers in herobids `source .env.ops.dev` then `exec npx tsx ts/validate-*-launch.ts "$@"`.
  traderton has NO `.env.ops.dev`; it uses `.env` (+ `.env.example` twin). The copied
  wrappers must source traderton's `.env` (see §4, step 3).

### 3d. herobids wrappers (what you delete there)
`validate-jupiter.sh` / `validate-1inch.sh` are thin: resolve REPO_ROOT, source
`.env.ops.dev`, `cd scripts`, `exec npx tsx ts/validate-{jupiter,1inch}-launch.ts "$@"`.
VERIFY: `sed -n '1,40p' herobids/scripts/shell/tests/validate-jupiter.sh`

---

## 4. Implementation steps

### traderton side (branch `l3-integration`) — COPY IN
1. **Copy the TS validators verbatim**, then repoint imports ONLY:
   - `herobids/scripts/ts/validate-jupiter-launch.ts` → `traderton/scripts/ts/validate-jupiter-launch.ts`
   - `herobids/scripts/ts/validate-1inch-launch.ts` → `traderton/scripts/ts/validate-1inch-launch.ts`
   - Change `@herobids/venues` → `@traderton/venues` and `@herobids/domain` → `@traderton/domain`.
     Change NOTHING else (no logic, no assertions, no env-var names). If a symbol
     isn't exported by traderton (per §3b), STOP.
2. **Copy the shell wrappers**, adapting only the thin seam:
   - `herobids/scripts/shell/tests/validate-jupiter.sh` → `traderton/scripts/shell/tests/validate-jupiter.sh`
   - `herobids/scripts/shell/tests/validate-1inch.sh` → `traderton/scripts/shell/tests/validate-1inch.sh`
   - Fix `REPO_ROOT`/`cd` to traderton's layout and the `tsx` path to `scripts/ts/validate-*-launch.ts`.
   - Env source: change `source "${REPO_ROOT}/.env.ops.dev"` → source traderton's
     `.env` (`${REPO_ROOT}/.env`), guarded (`[ -f ... ] && set -a; source; set +a`).
     Keep the same required-var checks the original wrapper prints (e.g. the 1inch
     wrapper checks `ONEINCH_API_KEY`/`ONEINCH_PRIVATE_KEY`; jupiter checks the
     Solana key/RPC). Mirror the original's messages.
3. **Document env vars in `.env.example`:** the validators read venue keys/wallet
   secrets (`ONEINCH_API_KEY`, `ONEINCH_PRIVATE_KEY`, `SOLANA_WALLET_PRIVATE_KEY`,
   `SOLANA_RPC_URL`, optional `JUPITER_WALLET_ADDRESS`/`JUPITER_PRIVATE_KEY`,
   `SWAP_AMOUNT`, `SLIPPAGE_BPS`). For any of these NOT already in
   `traderton/.env.example`, add a commented placeholder line with a one-line `#`
   note (NO real secrets). VERIFY current state first:
   `rg -n "ONEINCH_API_KEY|ONEINCH_PRIVATE_KEY|SOLANA_WALLET_PRIVATE_KEY|SOLANA_RPC_URL|JUPITER_WALLET_ADDRESS|JUPITER_PRIVATE_KEY" traderton/.env.example`
   (Note: `ONEINCH_API_KEY` is already present from earlier work; the wallet
   *secrets* likely are not — add them as blank placeholders.)
4. **Wire into the traderton harness (operator/venue-key tier):** these are
   venue-key-gated + hit live venue endpoints, so they are NOT part of the default
   green run — mirror how herobids EXCLUDED them from CI. Read
   `traderton/scripts/shell/tests/run-extra-tests.sh` to see if it has a tier/section
   for operator/credentialed scripts; if so, add them there as opt-in (guarded on the
   presence of the venue keys, self-skip when absent). If there is no natural tier,
   do NOT force one — leave them as standalone operator scripts and note in the
   wrapper header that they are operator-run, not CI. (Prefer the smallest, most
   faithful wiring; do not invent a new harness structure.)

### herobids side (branch `consume-traderton`) — DELETE ORIGINALS
5. Delete the four migrated files:
   - `herobids/scripts/shell/tests/validate-jupiter.sh`
   - `herobids/scripts/shell/tests/validate-1inch.sh`
   - `herobids/scripts/ts/validate-jupiter-launch.ts`
   - `herobids/scripts/ts/validate-1inch-launch.ts`
6. Confirm nothing else in herobids references them BEFORE deleting (other than the
   entrypoints, which Slice 3 cleans):
   `rg -n "validate-jupiter|validate-1inch|validate-jupiter-launch|validate-1inch-launch" herobids/scripts herobids/apps herobids/packages herobids/docs`
   Expect hits only in `run-all-tests.sh`/`run-extra-tests.sh` (left for Slice 3) and
   docs. If anything in `apps/`/`packages/` imports them, STOP and report.
7. Do NOT touch `validate-swap-venue.sh` (deferred — §2).

---

## 5. Verification (must pass before you commit)

traderton (`l3-integration`):
```
# imports fully repointed — NO herobids refs remain in the copied files:
rg -n "@herobids/" traderton/scripts/ts/validate-jupiter-launch.ts traderton/scripts/ts/validate-1inch-launch.ts   # expect: no matches
# the venues package still compiles + the scripts typecheck against it:
cd traderton && pnpm --filter @traderton/venues run build          # clean
# dry-run each validator WITHOUT venue keys — it must reach the prereq/quote gate
# and exit cleanly on missing creds, NOT crash on a bad import:
cd traderton && npx tsx scripts/ts/validate-jupiter-launch.ts ; echo "exit=$?"   # dry-run path; missing-key exit is fine (2), import error is NOT
cd traderton && npx tsx scripts/ts/validate-1inch-launch.ts   ; echo "exit=$?"
# env twin updated (if you added vars):
rg -n "SOLANA_WALLET_PRIVATE_KEY|ONEINCH_PRIVATE_KEY" traderton/.env.example
```
Interpretation: a dry-run that stops at "missing wallet/key" (exit 2) or reaches a
live quote is SUCCESS — it proves the imports resolve and the adapter constructs. A
`Cannot find module '@herobids/...'` or a TS/import crash is FAILURE.

herobids (`consume-traderton`):
```
git -C herobids status --short          # the 4 files show as deleted (D)
rg -n "validate-jupiter|validate-1inch" herobids/scripts herobids/apps herobids/packages
# expect: only run-all-tests.sh / run-extra-tests.sh (Slice 3) + docs — NO code imports
cd herobids && pnpm exec tsc --noEmit -p apps/api/tsconfig.json && pnpm exec tsc --noEmit -p apps/worker/tsconfig.json   # still clean (these files were standalone scripts, so this should be unaffected)
```

**Live venue verification (needs real venue keys — HUMAN-GATED):** actually running
the validators against live venues (`--execute`, funded wallet) requires operator
credentials. Do NOT attempt it autonomously. Note in your report that live-venue
verification is deferred to a human with creds.

---

## 6. Commits (separate, per repo)
- traderton (`l3-integration`): `git add traderton/scripts/ts/validate-jupiter-launch.ts traderton/scripts/ts/validate-1inch-launch.ts traderton/scripts/shell/tests/validate-jupiter.sh traderton/scripts/shell/tests/validate-1inch.sh traderton/.env.example traderton/docs/features/initial/10-improvement-backlog.md` (+ run-extra-tests.sh if you wired a tier). Message e.g. `test(venues): migrate 1inch/jupiter launch validators from herobids`.
- herobids (`consume-traderton`): `git add -u` the four deleted paths (or `git rm` them). Message e.g. `chore(tests): remove venue launch validators (migrated to traderton)`.

---

## 7. Gotchas / landmines (learned the hard way this epic)
- **The glob/grep search tool false-greens.** Use `rg` for every check. A "no matches"
  from the built-in search tool is not trustworthy.
- **Read the 1inch file fully before repointing** — it may import an EVM signer
  (`EvmSigner`) for the `--execute` path that the import line at the top doesn't show;
  repoint ALL `@herobids/*` imports, not just the first line.
- **Do not "improve" the validators.** Copy-never-author. If they look
  awkward, leave them — parity harness travels verbatim.
- **`.env` files are gitignored** in both repos; only `.env.example` is committed.
  Never commit real secrets. The validators' real keys live in the operator's local
  `.env` (traderton) — you only document placeholders in `.env.example`.
- **Two composes, separate DBs** (context only — not exercised by this slice): the
  cross-stack harness runs traderton's boundary + herobids side by side; these
  validators run **in-process against the venue adapters** and do NOT need the
  boundary or the cross-stack stack. (For reference, the canonical way to stand up
  the cross-stack herobids→boundary→traderton stack is
  `herobids/scripts/shell/run/with-boundary.sh` — its header documents preconditions,
  credentials, and cleanup. You do NOT need it for this slice; you run the validators
  directly with `npx tsx` per §5.)

---

## 8. Definition of done
- [x] Two validators (+ wrappers) live in traderton, imports repointed, `@traderton/venues`
  builds, dry-runs reach the prereq gate (no import crash).
- [x] Originals deleted from herobids; no code (apps/packages) references them.
- [x] `.env.example` twin updated for any new venue-secret vars.
- [x] `validate-swap-venue.sh` left in place + a backlog entry added for its deferral (B11).
- [x] Two separate commits (traderton copy-in, herobids delete). Nothing on `main`.
- [ ] Live-venue `--execute` verification explicitly deferred to a human with creds.

---

## 9. Outstanding Issues (from CodeReview — non-blocking)

- **[§4/§6] Commit path list:** §6's `git add` list omitted the load-bearing
  workspace glue (`scripts/package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`)
  and `packages/worker/src/env-example-drift.test.ts` (drift allowlist for the
  7 script-only vars). Without them, fresh clones can't resolve
  `@traderton/venues` from `scripts/` and the drift test fails. Commits include
  all 8 changed paths explicitly.
- **[§4.1, inherited] Latent `--execute` confirmation defect migrated verbatim**
  (`scripts/ts/validate-{jupiter,1inch}-launch.ts`): the confirmation step reads
  `result.data.status === 'confirmed'` / `result.data.outputAmount`, but
  `SwapConfirmationStatus` is `{confirmed, failed?, blockNumber?, timestamp?,
  actualOutputAmount?}` (`packages/venues/src/swap-confirmation-poller.ts`) —
  at runtime it always prints "Unexpected status: undefined" and exits 1 even
  after a successful on-chain confirmation. Verbatim-inherited from herobids
  (identical defect there); copy-never-author forbids fixing it in this slice.
  Fix belongs in the herobids source, then re-copy. Only affects the
  human-gated `--execute` path. → `010-improvement-backlog.md` B12.
- **[LOW backlog candidates]** No typecheck coverage for `scripts/ts/` (no
  `scripts/tsconfig.json`; herobids parity — LOW-1); `scripts/package.json`
  lacks `@types/node` (LOW-2); drift-test comment grouping nit (LOW-3); stale
  `--all` usage comment in `run-extra-tests.sh` (LOW-4); `BASE_RPC_URL`
  undocumented in `.env.example` (LOW-5, off-plan var list); `scripts/package.json`
  single-line JSON (LOW-6); dead `${missing[*]:-${*}}` fallback in
  `run-extra-tests.sh` (LOW-7).
