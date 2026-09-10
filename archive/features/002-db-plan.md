# Phase 2 Plan — `@traderton/db` (trading cluster)

**Phase:** 2 of the extraction roadmap ([009](../009-extraction-roadmap.md)).
**Shape:** subtraction (mixed trading+platform within the package).
**Depends on:** `@traderton/domain` (Phase 1, done).
**Drafted:** 2026-09-06, from investigation of herobids `packages/db` (read-only).

## Goal

Extract the trading-owned slice of `packages/db` into `@traderton/db`: the trading
schema tables + their repositories, with every platform FK converted to a soft
`ownerId`/soft reference per the **soft-reference rule** ([004](../../docs/004-decision-log.md)).
Compiles under strict TS; copied trading tests green; no platform imports; no
`@herobids/*`.

## Method

Copy-and-delete (AGENTS.md law). Copy the whole `packages/db` verbatim, get it
compiling as a copy, bring trading tests across, then delete platform files/repos and
convert the FK seams. Build + copied tests green after each step. Small diffable commits.

The FK→soft-ownerId conversions and the deletion of platform-coupled methods are
**sanctioned authored seams** (decisions 10–13 + the soft-reference rule in 004) — NOT
stop-gates. Proceed without escalation.

## Toolchain

Mirror herobids `packages/db`: deps `drizzle-orm ^0.44.0`, `postgres ^3.4.0`; devDeps
`@types/node`, `drizzle-kit ^0.31.0`. `@herobids/domain` dep → `@traderton/domain`.
tsconfig extends root base, references `../domain`. Add `packages/db` to the root
`tsconfig.json` references and vitest aliases (`@traderton/db`, `@traderton/db/schema`).

## Classification (authority: context-gatherer + real FK graph, 2026-09-06)

### Schema — KEEP (trading; copy)
Trading-core (all soft-linked, NO `.references()` — copy verbatim): `decisions`,
`decision-contexts`, `decision-approvals`, `decision-failures`, `positions`, `orders`,
`fills`, `execution-plans`, `journal-events`, `reconciliation-events`,
`balance-snapshots`, `instruments`, `token-safety-overrides`, `replay-market-events`,
`llm-decision-artifacts`.
Seam tables (copy + convert FK): `bots`, `venue-accounts`, `user-credentials`,
`backtest-runs`, `replay-corpora`, `datasets`.
Market-assessment (copy — clean): `market-assessment-runs`, `market-assessment-artifacts`.

### Schema — DELETE (platform)
`users`, `user-plans`, `oauth-identities`, `local-identities`, `sessions`, `agents`,
all `agent-*` (connections, connection-audit, runtime-sessions, messages,
outbound-messages, artifacts, documents, evaluations, skills, scan-metrics,
scan-candidates, preset-bindings, preset-transitions, assessment-review-checks,
assessment-review-runs), `connections`, all `skill*`, all `blueprint*`, `chat-*`,
`alert-deliveries`, `review-advice`, all `billing-*`, `llm-pricing-snapshots`,
**`market-assessment-requests`** (billing+agent+user FKs → platform, not trading).

### FK seam set (convert to soft ref — the ONLY hard FKs in copied tables)
- `bots.userId` → soft `ownerId` (drop `.references(users)`)
- `bots.connectionId` → **removed**; bots bind via `venueAccountId` (decision 13). Drop
  the `connections` import, the column, its index, and the FK.
- `bots.creatorId` — already soft text (stays; it's `agentId|userId|system`).
- `venue-accounts.userId` → soft `ownerId` (drop `.references(users)` + the users import).
- `user-credentials.userId` → soft `ownerId`.
- `backtest-runs.userId` → soft `ownerId` (nullable).
- `replay-corpora.userId` → soft `ownerId` (nullable).
- `datasets.userId` → soft `ownerId` (was `onDelete: cascade` — becomes plain text).

### Intra-trading FKs to PRESERVE (both ends copied)
- `bots.venueAccountId` → `venue_accounts.id` (keep).
- `venue-accounts.credentialId` → `user_credentials.id` (foreignKey helper; keep).
- `market-assessment-artifacts.assessmentRunId` → `market-assessment-runs.id` (keep).

### Repositories — KEEP
`journal-pg.ts` (PgJournal), `reconciliation-repository.ts`, `backtesting-repository.ts`,
`instrument-repository.ts`, `token-safety-override-repository.ts`,
`decision-approval-repository.ts`, `decision-failure-repository.ts`,
`llm-artifact-repository.ts`, and `repositories.ts` (Fill/Position/ExecutionPlan/Order/
BalanceSnapshot/Decision/Bot repositories).

### Repositories — DELETE (platform)
`agent-repository.ts`, `billing-repository.ts`, `usage-billing-repository.ts`,
`blueprint-repository.ts`, `alert-delivery-repository.ts`, `manual-review-repository.ts`,
`manual-review-job.ts`, `agent-documents-repository.ts`, `agent-evaluation-repository.ts`,
`agent-evaluation-job.ts`, `agent-evaluation-storage-fs.ts`, `agent-evidence-loaders.ts`,
`agent-runtime-descriptor.ts`, `skill-assignment.ts`.

### repositories.ts — in-place method deletions (BotRepository)
Delete the platform-coupled methods (verified: only platform worker code calls them —
clean deletions, not a source-fix):
- `getResolvedVenueAccount(connectionId)` — reads `connections` (the dropped indirection).
- `listRunningBotsForInactiveAgents()` — joins `agents`.
- `isConnectionOwnedBy(connectionId, userId)` — connection+user ownership.
Then drop the `connections` and `agents` imports from the file's import line. Keep
`isVenueAccountOwnedBy` if it only touches venue_accounts (verify; likely keep, soften
any userId param to ownerId). Reshape `createBot`/limit methods only by DELETING the
connection/agent-validation branches, not by authoring new logic — if a branch cannot be
removed without authoring, STOP and escalate (source-fix). Expected: clean.

## Tests (parity harness)
- **Copy (trading):** `schema/bots.test.ts`, `journal-pg.integration.test.ts`,
  `journal-timestamps.test.ts`, `position-repository.integration.test.ts`,
  `__tests__/bot-lifecycle.test.ts`, `test-helpers/integration-db.ts`.
- **Do NOT copy (platform):** `agent-repository*.test`, `agent-evaluation*.test`,
  `agent-evidence-loaders.test`, `agent-runtime-descriptor.test`, `skill-assignment.test`,
  `manual-review-repository.test`, `alert-delivery-repository.integration.test`,
  `usage-billing-repository*.test`, `schema/skills.test.ts`,
  `__tests__/agent-repository-email-policy.test.ts`.
- **Adjust with care:** `bot-lifecycle.test.ts` tests `listRunningBotsForInactiveAgents`
  (deleted) — drop those describe blocks (Intentional Divergence: agent-lifecycle orphan
  sweep is platform); keep the trading bot-lifecycle assertions. Integration tests
  requiring a live Postgres may be gated — note in ledger which run in CI vs need a DB.

## Migrations
herobids `packages/db/drizzle/` has 60+ historical SQL migrations. Traderton owns its own
DB (decision 1) with a fresh schema — do **NOT** copy the herobids migration history.
Copy `drizzle.config.ts` (retargeted) and generate a fresh initial migration from the
copied trading schema via `drizzle-kit generate` once the schema compiles. (This is
generated infra, not authored trading logic.) If generating migrations requires decisions
beyond a clean initial snapshot, note and defer per the ledger.

## Barrels
- `schema/index.ts` — flat re-export of all 73 tables; trim to the KEEP tables only.
- `index.ts` (package root) — `createDatabase`/`closeDatabase` (keep), `export * from
  './schema/index.js'`, repository re-exports; trim platform repo exports.
- `repositories.ts` — trim as above (delete platform methods + imports).

## Execution order (leaf-first, build+tests green after each)
1. Scaffold `packages/db` shell; copy `package.json`/`tsconfig.json`/`drizzle.config.ts`
   (retargeted); add to root tsconfig refs + vitest aliases; rename `@herobids/domain`→
   `@traderton/domain`.
2. Copy the whole `src/` verbatim; get the copy compiling; establish green baseline
   (copy trading tests; platform tests will be deleted, not fixed).
3. Delete platform schema files + platform repo files + platform test files.
4. Trim `schema/index.ts`, `index.ts`, `repositories.ts` barrels + BotRepository methods.
5. Convert the 7 user-FK seams → soft `ownerId`; drop `bots.connectionId`.
6. Rename remaining `@herobids/*` → `@traderton/*`.
7. Build + lint + copied tests green. Generate fresh initial migration.
8. Forbidden-import sweep (no platform imports, no `@herobids`, no llm).

## Stop-gates for THIS phase (per 009)
- If a BotRepository method (e.g. createBot limit logic) cannot be de-coupled from
  `agents`/`connections` by deletion alone (i.e. a trading path needs the reshaped
  behaviour) → source-fix request. (Expected: not needed — verified consumers are platform.)
- If `market-assessment-runs`/`artifacts` turn out to need `market-assessment-requests`
  (platform) to be meaningful → ownership escalation. (Expected: not needed — they're
  structurally independent.)
- The soft-reference conversions and platform-method deletions are NOT stop-gates.

## Deliverables / acceptance
- `@traderton/db` compiles strict; lint clean; copied trading tests green.
- No `.references()` to a platform table anywhere; no `@herobids/*`; no llm/platform imports.
- Ledger ([001](../../docs/001-parity-ledger.md)) "Trading data model" row updated with evidence;
  soft-reference rule applied and noted; any deferred integration tests recorded.
- Draft Phase 3 (`engine`) plan seeded at `docs/features/003-engine-plan.md`.
