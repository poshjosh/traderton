# `_deferred-authoring/` — quarantined worker files (Phase 9a → 9b)

These files are **verbatim copies** from the herobids source worker (`@herobids/*`
→ `@traderton/*` namespace rename only — no content edits). They are **not
authored**; they are the copied parity harness for capabilities that cannot yet
compile / go green in Traderton without an authored dependency.

This directory is the Phase-9a sibling of `_deferred-config/` (which held the
Phase-8 config-shape residue). The extraction law is *copy, never author*, so a
module that would need an authored dependency to compile/pass is quarantined
verbatim here and handed to **Phase 9b** (the sanctioned authoring pass), rather
than being edited or stubbed in 9a.

## Quarantined test files (source stays in the build)

These are **test files only** — their source-under-test remains in
`packages/worker/src/` (or `src/tools/`) and compiles clean under the build.
They are quarantined verbatim (no in-file editing) because they assert behaviour
tied to platform capabilities Traderton intentionally dropped. The whole file is
moved rather than pruned to preserve *copy, never author*.

- `schema.test.ts` — the copied `get_schema` tool test. Its final case asserts
  the `publish_artifact.location` sub-schema, but Traderton's domain
  `tool-schemas.ts` deliberately OMITS `publish_artifact.*` and
  `execute_code.dependencies` (those tools are platform, not trading — see the
  comment in `packages/domain/src/tool-schemas.ts`). The remaining cases
  (`create_bot.config.*`, `submit_decision`, unknown-schema) are trading-clean,
  but the file is moved whole rather than pruned in-place. Its source-under-test
  `src/tools/schema.ts` stays in the build. When the platform schema surface is
  reconciled in 9b, prune the platform case and un-quarantine the trading cases.

## Quarantined API route handlers (`api-routes/`)

Verbatim copies (namespace rename only) of the herobids `apps/api/src/routes/*`
trading route handlers. Phase 9a read each in full; **none copies green in 9a
without an authored dependency**, so all are quarantined here for 9b. The three
authored dependencies that block them (any one is sufficient):

1. **The auth/session seam (`request.userId`).** Every route reads
   `request.userId` — a Fastify request augmentation declared by the platform
   auth middleware in the API app shell (not copied in 9a; it is 9b/M2 boundary
   infrastructure). Without that augmentation the handlers do not type-check.
2. **The `userId` → `ownerId` schema divergence.** Traderton's `@traderton/db`
   converted the identity FKs to soft `ownerId` columns (decisions 11–13), so the
   copied handlers' `bots.userId` / `datasets.userId` / `venueAccounts.userId`
   column references no longer exist. Adapting them would be an authored edit to a
   copied file — deferred, not done in 9a.
3. **The 9b config shape + platform tables.** Several routes import the
   not-yet-authored config surface (`PlansConfig`, `AppConfig`,
   `RuntimeBudgetPolicy`, `../plan-guards.js`) and/or platform tables absent from
   `@traderton/db` (`agents`, `connections`, `blueprints`, `blueprintRevisions`,
   `agentRuntimeSessions`) and platform helpers (`../providers/*`,
   `../services/blueprint-projection.js`, `./blueprints.js`,
   `./agent-config-helpers.js`).

Per-route blocking reason (all also hit #1 and #2):

| route | additional authored deps |
|-------|--------------------------|
| `bots.ts` | plan-guards, blueprints/blueprintRevisions/connections/agents tables, blueprint-projection service, `PlansConfig`/`AgentRiskDefaultsConfig` |
| `accounts.ts` | `AppConfig`/`PlansConfig`, plan-guards |
| `analytics.ts` | `agents`/`agentRuntimeSessions` platform tables |
| `backtests.ts` | `PlansConfig`, plan-guards |
| `credentials.ts` | `PlansConfig`, plan-guards, `../providers/*`, `../credential-dependents.js`, `../crypto.js` |
| `reconciliation.ts` | (only #1 + #2 — `bots.userId` + `request.userId`) |
| `actor-health.ts` | `agents` platform table |
| `exports.ts` | platform tables (agents/blueprints/…) |
| `datasets.ts` | (only #1 + #2 — `datasets.userId` + `request.userId`) |
| `capabilities/trading.ts` | `PlansConfig`/`RuntimeBudgetPolicy`, runtime-assignment platform tables |

The copied route **test files** (`*.test.ts`) are quarantined alongside their
handlers for the same reasons. The API server shell (Fastify bootstrap,
`index.ts`, auth/error middleware) was not copied at all — it is 9b.

## Quarantine mechanism

- Excluded from the package build: `packages/worker/tsconfig.json` `exclude`
  (`src/_deferred-authoring/**`).
- Excluded from the test run: root `vitest.config.ts` `test.exclude`
  (`**/_deferred-authoring/**`).

The files remain on disk (retained, not deleted) so they can be un-quarantined
with a move and the exclude entries removed once the authored dependency lands.

**Do not edit these files** — they must stay verbatim copies for the eventual
un-quarantine.
