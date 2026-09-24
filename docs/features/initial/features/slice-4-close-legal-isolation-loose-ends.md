# Slice 4 - Close legal-isolation loose ends: assessment disposition and package edges

**Status:** PLANNING ONLY - no implementation was performed from this document.
**Grounded:** 2026-09-16 with shell `rg`, on herobids `consume-traderton` and
traderton `l3-integration`. Both worktrees were clean at the start of the audit.

---

## 0. Read this first - you have NO prior context

Trading was extracted from `herobids` into sibling repo `traderton`, which owns
the trading engine and venue integrations behind an HMAC-signed REST boundary.
The target is legal isolation: herobids must not run trading logic, hold trading
state, or execute trading. The only hard stop is a human-approved merge to either
repo's `main`; do not merge it.

### Repos and branches

- herobids: `/Users/chinomso.ikwuagwu/dev_ai/hero-trade/herobids`, branch
  `consume-traderton`.
- traderton: `/Users/chinomso.ikwuagwu/dev_ai/hero-trade/traderton`, branch
  `l3-integration`.

Before any edit, run:

```sh
git -C /Users/chinomso.ikwuagwu/dev_ai/hero-trade/herobids branch --show-current
git -C /Users/chinomso.ikwuagwu/dev_ai/hero-trade/traderton branch --show-current
```

Expected output is exactly `consume-traderton` and `l3-integration`. Stop if it
is not. Nothing in this plan authorizes a `main` merge.

### What this planning slice establishes

1. The prior c4.9h ruling correctly excluded `market_assessment_*` from the
  completed c4.9f table-drop wave, but the broader legal-isolation ownership
  question is now open. Current Herobids retention is temporary and requires
  an 008 reassessment before legal-isolation sign-off.
2. No complete local trading package is mechanically deletable today. There are
   three stale consumer metadata edges and one obsolete backfill script that can
   be removed independently.
3. Full deletion of the remaining local packages needs a separate decision
   checkpoint about static consumer type contracts. That is not the already
   settled market-assessment ownership question.

The prior shell-test migration is complete. This document mirrors its
verification-first structure, but it is a plan and grounding report, not an
implementation instruction to change scope unilaterally.

## 1. Rules you must follow

1. **Copy, never author.** Trading behavior is copied from the source. Author
   only deletions and thin seams. Do not recreate market-data providers,
   execution code, or assessment behavior in herobids.
2. **Use shell `rg` for every search.** The editor search/glob has false-greened
   this migration. A no-match claim is valid only when checked with shell `rg`.
3. **Work only on the stated branches.** herobids changes are allowed only on
   `consume-traderton`; traderton changes are allowed only on `l3-integration`.
4. **Keep repos and commits separate.** Use explicit `git add <paths>` and never
   `git add -A`, `git add .`, or `--no-verify`.
5. **Honor `.env`/`.example` twins** if, and only if, an environment variable
   changes. This plan should not need one.
6. **Apply `008` before a four-risk choice.** Deleting a package with live
   imports, choosing where consumer-visible types live, or changing a boundary
   contract is a four-risk choice. Use the parity-first gate before routing;
   never rank its options as an implementing agent.

## 2. Grounding report

### 2a. Loose end A - active platform retention; final ownership is open

Reproduce the runtime audit:

```sh
rg -n --glob '*.ts' --glob '!**/*.test.ts' \
  '\.(from|insert|update|delete)\(marketAssessment(Requests|Runs|Artifacts)\)' \
  /Users/chinomso.ikwuagwu/dev_ai/hero-trade/herobids/apps
```

On 2026-09-16 this returned exactly 20 active worker query operations in six
files: 11 reads and 9 writes. They are runtime Drizzle operations, not
`$inferSelect` references or type-only imports.

| Herobids runtime file | Exact reads | Exact writes |
|---|---|---|
| `apps/worker/src/market-intelligence/assessment-request-service.ts` | requests: 298, 329, 366, 441; artifacts: 523, 1129 | requests: insert 447, 1047; update 1082. runs: insert 755, update 1101. artifacts: update 815, 826; insert 842 |
| `apps/worker/src/market-intelligence/platform-assessor.ts` | - | runs: update 534 |
| `apps/worker/src/market-intelligence/assessment-review-runner.ts` | artifacts: 538 | - |
| `apps/worker/src/market-intelligence/preset-transition-service.ts` | artifacts: 97, 229 | - |
| `apps/worker/src/tools/change-strategy-preset.ts` | artifacts: 118 | - |
| `apps/worker/src/agent-evaluation/collectors/preset-assessment-evidence.ts` | requests: 118 | - |

Totals by table are: `market_assessment_requests` (5 reads, 3 writes),
`market_assessment_runs` (0 reads, 3 writes), and
`market_assessment_artifacts` (6 reads, 3 writes).

Traderton has schema definitions and barrel exports for only `runs` and
`artifacts`:

```sh
cd /Users/chinomso.ikwuagwu/dev_ai/hero-trade/traderton
rg -n 'marketAssessment|market_assessment' packages/db/src/schema
rg -n --glob '*.ts' \
  '\.(from|insert|update|delete)\(marketAssessment(Requests|Runs|Artifacts)\)' \
  packages
```

The first command finds
`packages/db/src/schema/market-assessment-runs.ts`,
`packages/db/src/schema/market-assessment-artifacts.ts`, and their exports from
`packages/db/src/schema/index.ts`. There is no
`market-assessment-requests.ts`. The second command has no matches. The
assessment domain types exist in Traderton, but no repository, tool, or runtime
consumer reads or writes those tables.

#### The apparent table-drop contradiction is historical; capability ownership is now open

The primary documents now agree:

- The former c4.9h ruling excluded the three tables from the c4.9f drop because
  dropping them would have broken live Herobids worker behavior. That remains
  correct as a historical table-drop decision. The current `001` row supersedes
  its final-sounding platform classification with **temporary platform
  retention—reassessment required before legal-isolation sign-off**.
- `docs/features/initial/11-premerge-backlog.md:78` labels the earlier FULL-set inclusion as
  "[historical, RETRACTED]" and records the c4.9h platform-KEEP ruling.
  `docs/features/initial/11-premerge-backlog.md:185` calls the former omission CRITICAL but
  RESOLVED, and `docs/features/initial/11-premerge-backlog.md:205` records that the later
  16-table drop left `market_assessment_*` untouched.
- `docs/features/initial/05-consumer-boundary-contract.md` has no `market_assessment` reference;
  it creates no contrary boundary obligation.
- `docs/features/initial/04-decision-log.md:314-315` refers only to the copied
  `market_assessment_artifacts -> market_assessment_runs` foreign key. It does
  not make a contrary ownership ruling.

**Decision-brief disposition:** do not re-run the old table-drop decision. It
was resolved correctly for its scope. Do route a new **whole-capability** brief
under `008` before legal-isolation sign-off. The re-decision covers the request,
billing/idempotency, Traderton evidence/scoring, LLM ranking, artifacts,
review/wake workflow, and preset bindings/transitions—not a table family in
isolation. Current retention preserves behavior pending that ruling. The stale
semantic review is non-authoritative and may be deleted without losing the
runtime finding; `001`, `004`, `011`, and `CANONICAL-STATE` are the durable
records.

#### Temporary-retention guardrails and future options

Until the reassessment, current behavior remains unchanged and the tables stay
outside the completed c4.9f drop. This does not authorize new local market-data
providers, local trading execution/state, or new in-process trading-package
dependencies in Herobids.

The future `008` brief must retain these unranked options:

1. Permanent Herobids retention as an explicit legal-isolation exception.
2. Complete Traderton ownership of the capability.
3. A deliberate boundary split with one clear owner for each cache,
   idempotency key, and state transition.
4. Removal/deprecation of market-guided preset transitions.

### 2b. Loose end B - exact residual package import audit

Run this before making a package decision:

```sh
rg -n --glob '*.ts' --glob '!**/*.test.ts' \
  "from '@herobids/(venues|engine|strategy|market-data)'" \
  /Users/chinomso.ikwuagwu/dev_ai/hero-trade/herobids/apps/*/src

rg -n --glob '**/*.test.ts' \
  "from '@herobids/(venues|engine|strategy|market-data)'" \
  /Users/chinomso.ikwuagwu/dev_ai/hero-trade/herobids/apps
```

The 2026-09-16 production result is 16 import declarations: 1 venues, 2
engine, 3 strategy, and 10 market-data. There are no matching imports under
`apps/web/src`. The second command finds seven test import declarations across
six test files: one engine type import, one strategy value mock, and five
market-data type imports.

| Local package | Non-test app import sites | Classification | Current package disposition |
|---|---|---|---|
| `@herobids/venues` | `apps/api/src/routes/setup.ts:8` imports `deriveSolanaAddress`; it is called at 188 for a manual Jupiter private key while creating a trading provider link. | Runtime platform helper, not order execution or in-process market-data fetch. | **KEEP (legitimately used).** c4.9 D1-3b explicitly retains this manual-Jupiter behavior. The package is not deletion-ready. |
| `@herobids/engine` | `apps/worker/src/agent-risk-limits.ts:2` imports `RiskLimits`; `apps/worker/src/shared/decision-validation.ts:2` imports `LevelValidationError`. | Both are type-only. A non-app blocker remains: `scripts/ts/backfill-realized-pnl-delta.ts:19-20` value-imports `flatPosition`/`applyFill` and type-imports `PositionState`. | **Decision-dependent.** The script is independently obsolete, but package removal still needs a type-carriage choice. |
| `@herobids/strategy` | `apps/worker/src/market-intelligence/evidence-adapters.ts:10` imports `ScannerCandleTarget`; `preset-scorecard-runner.ts:14-16` imports `IndicatorConfig`/`ScanConfig`; `runtime-composition.ts:5` imports `ScoredSignal`. | Every production use is a type use. The scorecard import uses ordinary import syntax but is used only in type positions. `preset-scorecard-runner.test.ts:8` separately imports and mocks the `scoreCandidate` value. | **Decision-dependent.** No runtime strategy executes in herobids, but two type contracts are not already domain-owned. |
| `@herobids/market-data` | `agent.ts:24` (`RegimeParams`); `hybrid-decision-sizing.ts:15` (`PriceService`); `assessment-ports.ts:11` and `evidence-adapters.ts:9` (`RegimeResult`); `platform-assessor.ts:7` (`PriceCandle`, `RegimeResult`); `preset-scorecard-runner.ts:3` (`PriceCandle`); `runtime-composition.ts:4` (`RegimeResult`); `tick-gates.ts:3` (`PriceCandle`, `RegimeResult`); `traderton/hybrid-price-adapter.ts:20-24` (price-service types); `venue-intelligence.ts:1` (`RegimeResult`). | All ten package imports are type-only. `hybrid-price-adapter.ts` runs at runtime, but it calls the REST `resolve_price_target` boundary and imports no market-data value. | **Decision-dependent.** This is static type coupling, not evidence that Herobids has local market-data authority. |

The reported market-data count of approximately 11 is not current: shell `rg`
finds exactly 10 production application import declarations.

#### Non-app and package-internal blockers

Use this audit rather than assuming app-only clean means package clean:

```sh
cd /Users/chinomso.ikwuagwu/dev_ai/hero-trade/herobids
rg -n --glob '*.{ts,tsx}' "from '@herobids/engine'" . -g '!packages/engine/**'
rg -n --glob '*.{ts,tsx}' "from '@herobids/strategy'" . -g '!packages/strategy/**'
rg -n --glob '*.{ts,tsx}' "from '@herobids/market-data'" . -g '!packages/market-data/**'
rg -n -C 2 'backfill-realized-pnl-delta' . \
  -g '!scripts/ts/backfill-realized-pnl-delta.ts'
```

- The engine backfill script has no non-historical invocation. It reads and
  updates `fills`, one of the tables already dropped from herobids, while the
  project is documented as greenfield. It is an independently removable dead
  script, not an engine package runtime requirement.
- `packages/strategy/src/scan-engine.ts` still value-imports market-data
  indicators, and `packages/venues/src/candle-fetcher.ts` still value-imports
  market-data candle fetchers. Therefore market-data cannot be deleted by
  itself while either local package remains.
- `apps/api/package.json` and `apps/api/tsconfig.json` still name engine despite
  no API source importer. `apps/worker/package.json` and
  `apps/worker/tsconfig.json` still name venues despite no worker source
  importer. `scripts/package.json` still names venues despite no script source
  importer. These are stale metadata edges.
- The root `tsconfig.json` and the worker's remaining project references must
  remain until full package deletion is approved. Do not remove the root
  references in the mechanical metadata cleanup.

#### Existing and missing type seams

`@herobids/domain` already publicly exports `RegimeParams`, `RegimeResult`,
`PriceCandle`, `ScannerCandleTarget`, and `IndicatorConfig`. Before replacing
an import, prove structural compatibility with the current consumer and source
type; `RegimeParams` and `RegimeResult` are documented as mirrored types and
must not be assumed identical.

The domain package does not provide `RiskLimits`, `LevelValidationError`,
`ScanConfig`, `ScoredSignal`, `PriceService`, `PriceResult`, `PriceSource`, or
`ResolvePriceTargetResult`. Their current sources are respectively:

- `packages/engine/src/risk-gate.ts` and `per-trade-level-validator.ts`;
- `packages/strategy/src/scan-engine.ts`;
- `packages/market-data/src/price-service.ts`.

The copied Traderton packages export corresponding shapes, but Herobids is a
REST consumer, not a declared workspace consumer of the sibling repo. Do not
silently replace local imports with `@traderton/*` imports.

## 3. Plan A - mechanical cleanup available now

**Status:** DONE (implemented 2026-09-17 on herobids `consume-traderton`, commit
`1f6978d7`). CodeReviewer PASS (no CRITICAL/HIGH/MEDIUM; 4 LOW — see Outstanding
below). Verification green: both direct worker/api `tsc` clean, `pnpm lint`
clean, `git diff --check` clean, api setup tests 30/30. One pre-existing,
unrelated full-suite failure (`tests/staging-config-validation.test.ts >
staging config has liveRollout disabled`) reproduced identically on clean HEAD
with the changes stashed — not introduced by this change.

This plan removes dead or stale edges only. It does **not** delete a local
trading package, alter a boundary payload, or move assessment behavior.

### Scope

In scope:

1. Delete `herobids/scripts/ts/backfill-realized-pnl-delta.ts`.
2. Remove the stale engine dependency and project reference from the API.
3. Remove the stale venues dependency and project reference from the worker.
4. Remove the stale venues dependency from `scripts/package.json`.
5. Refresh the lockfile only as required by those manifest changes.

Out of scope: all `market_assessment_*` runtime/table changes pending the
mandatory ownership decision; `setup.ts`'s manual Jupiter helper; all non-stale
worker references; the rate-limit lab; root package references; package
directories; Traderton runtime code; `main`.

### Implementation steps

1. Re-run every command in sections 0 and 2. Stop if an importer or an
   invocation not listed here appears.
2. Delete the obsolete realized-PnL backfill script. Do not move its
   `flatPosition`/`applyFill` logic: its target table has already been removed
   and D2 is greenfield no-op.
3. In herobids only, remove these proven-stale edges:
   - `@herobids/engine` from `apps/api/package.json` and the engine reference
     from `apps/api/tsconfig.json`.
   - `@herobids/venues` from `apps/worker/package.json` and the venues reference
     from `apps/worker/tsconfig.json`.
   - `@herobids/venues` from `scripts/package.json`.
4. Regenerate `pnpm-lock.yaml` with the repository's normal package-manager
   workflow. Do not edit unrelated importer entries manually.
5. Do not remove `@herobids/venues` from the API, or engine/strategy/market-data
   from the worker. They have the verified imports in section 2b.

### Verification

```sh
cd /Users/chinomso.ikwuagwu/dev_ai/hero-trade/herobids
rg -n 'backfill-realized-pnl-delta' . \
  -g '!docs/features/initial/features/2026/09/10/001-consume-traderton/004-l3d-plan.md'
rg -n '"@herobids/engine"' apps/api/package.json
rg -n '"@herobids/venues"' apps/worker/package.json scripts/package.json
pnpm exec tsc --noEmit -p apps/api/tsconfig.json
pnpm exec tsc --noEmit -p apps/worker/tsconfig.json
pnpm lint
git diff --check
```

The first three `rg` commands must return no live-code or manifest match. The
historical plan reference may remain. The direct worker `tsc` is mandatory:
root `pnpm lint` does not reliably type-check the worker in `--noEmit` mode.

### Commit

Commit only in herobids, explicitly listing the deleted script, the three
manifests, the two application tsconfigs, and `pnpm-lock.yaml`. Example:

```sh
git -C /Users/chinomso.ikwuagwu/dev_ai/hero-trade/herobids add \
  -u scripts/ts/backfill-realized-pnl-delta.ts apps/api/package.json \
  apps/api/tsconfig.json apps/worker/package.json apps/worker/tsconfig.json \
  scripts/package.json pnpm-lock.yaml
git -C /Users/chinomso.ikwuagwu/dev_ai/hero-trade/herobids commit \
  -m "chore(isolation): remove stale local trading package edges"
```

No Traderton code commit is part of Plan A. Never merge either branch.

### Definition of done

- [ ] The branch guards passed before editing.
- [ ] The obsolete fills backfill script is deleted, not migrated.
- [ ] Only the five proven-stale metadata edges are removed.
- [ ] Direct API and worker typechecks, `pnpm lint`, and `git diff --check` pass.
- [ ] A single focused herobids commit exists on `consume-traderton`.
- [ ] No package directory, assessment runtime, boundary contract, or `main`
      branch was changed.

## 4. Plan B - conditional local trading-package removal

**Status:** DONE (implemented 2026-09-17 on herobids `consume-traderton`,
commits `55c53756` + `0d161a74`, after the user lifted the hold). The mandatory
008 decision checkpoint ruled **"settled within the rules"** for amended Option
A (local consumer-side type seams + verbatim moves, then delete all four
packages in one slice); the ruling is recorded in `004` ("D1-coda"). CodeReview
found 1 MEDIUM (`vitest.integration.config.ts` include-fallback regression —
fixed via explicit `include: []` + `passWithNoTests: true` so `pnpm test:venues`
is a clean vacuous pass) and 2 LOW citation nits (fixed). Verification at
commit: api/worker `tsc --noEmit` clean, `pnpm lint` clean, worker 3013/11 skip,
api 1483/0 (incl. new solana-address tests 5/5), lab 3/3, `pnpm test:venues`
vacuous pass, `git diff --check` clean, zero remaining alias/path/dynamic
references. Two in-scope deviations were resolved within the rules and recorded
in `004` (rate-limit-lab actually imported market-data — verbatim-copied the
rate limiter into the lab; obsolete `scripts/ts/test-forexfactory-parser.ts`
deleted — subject moved Traderton-side with B6). The one full-suite failure
(`staging-config-validation.test.ts`) is pre-existing and unrelated.

Do not start this plan immediately after Plan A. Every package still has a live
import, package-internal dependency, or both. The c4.9h table ruling resolves
neither the placement nor the versioning of the static type contracts that keep
the local packages compiling.

### Mandatory decision checkpoint

Run `traderton/docs/features/initial/08-decision-process.md` before selecting a route. The
neutral question is:

> After local trading packages are removed, where do the static DTO and port
> types needed by Herobids platform orchestration live without restoring an
> in-process trading integration or causing consumer and boundary types to
> drift?

Grounded options for the decision agent, without ranking:

1. Use the existing Herobids domain exports when exact, and copy only the
   remaining consumer-side static contracts into narrowly named platform seams.
2. Publish or extract a versioned boundary-contract artifact owned by Traderton,
   then consume only that contract from Herobids.
3. Keep the current type-only local packages until a compatible contract carrier
   exists, while retaining the completed runtime REST isolation.

The decision agent must apply the `008` parity-first gate and record its ruling
in `004` plus any parity effect in `001`. This is a new type-carriage question,
not a reason to reopen the settled market-assessment table classification.

### If the ruling permits local, narrow consumer contracts

1. First switch only exact existing domain types after structural checks:
   `RegimeParams`, `RegimeResult`, `PriceCandle`, `ScannerCandleTarget`, and
   `IndicatorConfig`. Preserve the public payload shapes; no runtime provider,
   indicator, or execution value may move into Herobids.
2. Create only the minimal consumer-facing type/port seams for the remaining
   types. Copy their declarations faithfully from the listed source files;
   do not bring `PriceService` implementations, engine logic, strategy
   evaluation, or provider functions across.
3. Keep `createBoundaryPriceService` a REST adapter. It may conform to a local
   narrow price-resolver type, but must continue to call
   `resolve_price_target` and must not construct a local price service.
4. Preserve manual Jupiter address derivation by moving the self-contained
   `deriveSolanaAddress` plus the necessary private base58 helpers verbatim into
   an API-owned platform utility. This is a relocation of the behavior c4.9
   D1-3b explicitly kept, not a new key-generation path. Generated wallet
   creation remains behind `provision_venue_account`.
5. Update all production and test type imports. Rework the scorecard test's
   `scoreCandidate` mock only after confirming what behavior it still asserts;
   the production scorecard path must remain boundary-backed.
6. Remove local package directories only after a final full-repo `rg` shows no
   source, test, manifest, or tsconfig consumer. Delete strategy, venues, and
   market-data as a coordinated graph if their internal dependencies remain;
   never delete market-data first while either local package imports it.
7. Remove every corresponding workspace dependency, project reference, test-lab
   reference, and lockfile importer entry. The `packages/*` workspace glob needs
   no edit.

### If the ruling selects a published boundary-contract artifact

Stop this package-delete plan and create a separate, decision-agent-reviewed
contract slice. It changes the cross-repo consumption topology and must define
versioning, publication, browser safety, import policy, and parity coverage
before Herobids gains a new dependency. Do not use a filesystem sibling import
as an undocumented substitute.

### If the ruling defers type carriage

Keep the current packages only as type/utility carriers, remove no package
directory, and record the deferral in `011` with the exact importer inventory.
The runtime state remains acceptable only while the B7/D1-b invariant holds:
Herobids has no value import that constructs or calls an in-process market-data
provider, strategy engine, or trading executor.

### Required verification for any approved deletion route

```sh
cd /Users/chinomso.ikwuagwu/dev_ai/hero-trade/herobids
rg -n "from '@herobids/(venues|engine|strategy|market-data)'" \
  apps packages scripts tests --glob '*.{ts,tsx}'
rg -n '"@herobids/(venues|engine|strategy|market-data)"' \
  . --glob 'package.json'
rg -n '@herobids/(venues|engine|strategy|market-data)|packages/(venues|engine|strategy|market-data)' \
  . --glob 'tsconfig*.json'
pnpm exec tsc --noEmit -p apps/api/tsconfig.json
pnpm exec tsc --noEmit -p apps/worker/tsconfig.json
pnpm test -- apps/api/src/routes/setup.test.ts \
  apps/worker/src/agent-risk-limits.test.ts \
  apps/worker/src/hybrid-decision-sizing.test.ts \
  apps/worker/src/traderton/hybrid-price-adapter.test.ts \
  apps/worker/src/market-intelligence/evidence-adapters.test.ts \
  apps/worker/src/market-intelligence/platform-assessor.test.ts \
  apps/worker/src/market-intelligence/preset-scorecard-runner.test.ts \
  apps/worker/src/tick-gates.test.ts \
  apps/worker/src/venue-intelligence.test.ts
pnpm lint
git diff --check
```

Treat a no-match result from the first three commands as valid only when they
are executed in the shell. Also run the cross-stack boundary suite prescribed by
the current pre-merge backlog before considering the result a legal-isolation
proof. Commit herobids and traderton separately, explicitly, and never merge
either branch to `main`.

## 5. Definition of done for this planning slice

- [x] Branches were verified as `consume-traderton` and `l3-integration`; no
      edit was made on `main`.
- [x] All 20 active assessment operations and all 16 production app package
      imports were audited with shell `rg`.
- [x] The historical c4.9h table-drop ruling was confirmed; it is now recorded
  as temporary retention rather than a final ownership classification.
- [x] The assessment finding is durable in `001` and `011`; this audit is also
      recorded in `011` below.
- [x] Plan A identifies only independent deletion/metadata work.
- [x] Plan B is explicitly conditional on a fresh `008` decision checkpoint.
- [x] No source, schema, runtime, boundary, test, configuration, or branch merge
      implementation was performed as part of planning.

## 6. Outstanding issues

- **[Plan A, in-slice]** LOW — the plan's `pnpm test -- <file>` syntax does not
  filter in this repo (vitest runs the full suite); use `pnpm exec vitest run
  <file>` for focused runs. Pre-existing, unrelated failure:
  `tests/staging-config-validation.test.ts > staging config has liveRollout
  disabled` (reproduced on clean HEAD; not introduced by Plan A).
- **[Plan A, deferred]** LOW — Dockerfiles still `pnpm --filter`-build
  engine/venues (`Dockerfile:23`, `apps/api/Dockerfile:15,18`,
  `apps/worker/Dockerfile:15,18`) and vitest aliases for engine/venues remain
  (`vitest.config.ts:17`, `vitest.integration.config.ts:20`). Correct while the
  packages exist; becomes the deletion surface for Plan B.
- The label "market data / market assessment" hides two different ownership
  boundaries. Do not use temporary assessment retention to justify moving
  market-data provider logic back into Herobids.
- The historic `herobids/docs/features/initial/features/2026/09/10/001-consume-traderton/004-l3d-plan.md`
  still describes old package-removal terrain. It is historical evidence only;
  re-run the `rg` commands here and rely on the canonical state, parity ledger,
  and current pre-merge backlog for live decisions.