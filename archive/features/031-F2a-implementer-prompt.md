# 031 — F2a Implementer Prompt (M2 REST boundary — the `boundary_invocations` idempotency store)

**Status:** ready to hand to an implementer. On branch `f-m2-rest`.
**Task:** implement **F2a** — the Postgres idempotency store ONLY: a new `@traderton/db`
`boundary_invocations` table + migration + `BoundaryInvocationRepository` + a `DATABASE_URL`-gated
integration test. **No boundary/dispatcher wiring in F2a** — that is F2b.
**Authoritative brief:** [013 §8.1.1](./013-9b-authoring-plan.md) (F2 LOCKED decisions) + [030 §2, §5,
§6](./030-F2-m2-rest-proposal.md) + [005 §Deadlines, Retries, And Idempotency](../../docs/005-consumer-boundary-contract.md).

---

## 0. Orient first

You are in **Traderton** (`/Users/chinomso.ikwuagwu/dev_ai/traderton`), on branch `f-m2-rest`. F1 (the
read-only REST boundary shell) already landed in `packages/boundary`. F2 completes the boundary in three
slices — **you are doing F2a (the store) only.** F2b (dispatcher integration) and F2c (stack + verification)
are later prompts. Do NOT wire the store into the boundary yet; do NOT touch `packages/boundary` in F2a.

**The law (AGENTS.md):** copy-never-author. `../herobids` is READ-ONLY source. F2a's idempotency logic is
**COPY-ADAPT** (decision D1) — see §2. You author only the deltas 005 adds on top of the copied shape.

## 1. What F2a delivers (scope)

1. `packages/db/src/schema/boundary-invocations.ts` — the `boundary_invocations` pgTable (§3).
2. Export it from `packages/db/src/schema/index.ts`; run `pnpm --filter @traderton/db db:generate` to produce
   the `drizzle/000N_*.sql` migration (do NOT hand-write the SQL — let drizzle-kit generate it).
3. `packages/db/src/boundary-invocation-repository.ts` (or add to `repositories.ts` alongside
   `BotRepository` — match the repo's existing file convention) — `BoundaryInvocationRepository` (§4).
4. Export the repo from `packages/db/src/index.ts`.
5. `packages/db/src/boundary-invocations.integration.test.ts` — `DATABASE_URL`-gated (§5).

**Out of F2a scope:** any change to `packages/boundary`, the dispatcher, the deadline check, the status
endpoint, the compose stack, the 7 verification tests. Those are F2b/F2c.

## 2. COPY-ADAPT the herobids idempotency oracle (decision D1 — do NOT author fresh)

herobids HAS a proven idempotency store. **Copy-adapt it; do not invent your own.** Read these READ-ONLY
sources and mirror their shape:

- **`herobids/apps/api/src/services/blueprint-idempotency.ts`** — `computeInstantiateRequestHash(...)`: a
  deterministic SHA-256 over a **recursively key-sorted** normalized object (arrays preserve order). This is
  the **request-fingerprint** function. COPY its normalization+hashing approach; adapt the input shape to the
  boundary invocation (fingerprint over the fields that define request identity — see §4).
- **`herobids/apps/api/src/routes/blueprints.ts`** `POST /blueprints/:id/fork` (~L1134 onward, inside
  `db.transaction`): the control flow —
  `SELECT pg_advisory_xact_lock(hashtext(lockKey))` → look up the existing row by
  `(userId, idempotencyKey)` → **same `requestHash` → return the stored response** (idempotent replay);
  **different `requestHash` → conflict**; else proceed + persist. COPY this flow; re-key it (§4).
- **`herobids/packages/db/src/schema/blueprint-instantiation-requests.ts`** (and
  `blueprint-fork-requests.ts`) — the table shape: `idempotencyKey`, `requestHash`,
  `responsePayload jsonb`, `createdAt`, `uniqueIndex(userId, idempotencyKey)`. COPY this shape; re-key + add
  the 005 deltas (§3).

**What you AUTHOR on top (005 adds these; herobids has no oracle for them):** the 4-tuple key, the `state`
(`in_progress` | `terminal`) transitional column + `requestId`/`correlationId`, the terminal-response
storage, `expiresAt`/retention, and the "same key + still running → in_progress" path. herobids is
synchronous replay-or-conflict with no in-flight state — that part is authored.

**Follow the item-E precedent** for the advisory lock: `packages/db/src/repositories.ts`
`BotRepository.tryCreateBotWithLimit`/`tryMarkBotRunningWithLimit` use
`pg_advisory_xact_lock(<CLASS_INT>, hashtext(<text>))` (two-int form) inside `this.db.transaction(tx => …)`,
with a `static readonly <NAME>_LOCK_CLASS` constant. `MAXBOTS_LOCK_CLASS = 17` is taken — use a new class
int (e.g. `BOUNDARY_LOCK_CLASS = 18`).

## 3. The `boundary_invocations` table (005 §Deadlines, Retries, And Idempotency)

Author `packages/db/src/schema/boundary-invocations.ts` mirroring `bots.ts`/`blueprint-instantiation-requests.ts`
column style (`text`, `timestamp({ withTimezone: true })`, `jsonb().$type<…>()`, `uniqueIndex`/`index`).
Columns (005 says the record stores "a request fingerprint, request ID, correlation ID, state, terminal
response, timestamps, and expiry"):

- `id` — text PK (`crypto.randomUUID()`).
- The **4-tuple key** (005): `consumerId`, `ownerId`, `toolName`, `idempotencyKey` — all `text().notNull()`.
- `requestFingerprint` — text notNull (the SHA-256 from §2).
- `requestId` — text notNull.
- `correlationId` — text notNull.
- `state` — text notNull (`'in_progress'` | `'terminal'`); default `'in_progress'`.
- `terminalResponse` — `jsonb().$type<TradertonToolResultV1-shape>()`, nullable (null until terminal). Store
  the mapped terminal result (the same object the boundary returns). Keep the db type a `Record<string,
  unknown>` to avoid a `@traderton/db → @traderton/boundary` dependency (db must not depend on boundary).
- `createdAt`, `updatedAt` — `timestamp({ withTimezone: true }).notNull().defaultNow()`.
- `expiresAt` — `timestamp({ withTimezone: true }).notNull()` (set by the repo from the retention window —
  see §4; retention is a VALUE passed in, never hard-coded, per 005: "may not hard-code this retention").
- **Unique index** on the 4-tuple: `uniqueIndex('uq_boundary_invocations_key').on(consumerId, ownerId,
  toolName, idempotencyKey)`.
- An `index` on `requestId` (the status endpoint reads by `requestId` in F2b).

Then export from `schema/index.ts` and `db:generate` the migration.

## 4. `BoundaryInvocationRepository` (the copy-adapted flow, re-keyed)

Class shape like `BotRepository`: `constructor(private readonly db: Database)`, a
`static readonly BOUNDARY_LOCK_CLASS = 18`, transactional methods using the advisory lock. Author these
methods (names indicative — match the repo conventions):

- **`beginOrResolve(params): Promise<BeginResult>`** — the copy-adapted core, run inside ONE
  `this.db.transaction(tx => …)`:
  1. `SELECT pg_advisory_xact_lock(BOUNDARY_LOCK_CLASS, hashtext(<key>))` where `<key>` is a stable string of
     the 4-tuple (e.g. `${consumerId}:${ownerId}:${toolName}:${idempotencyKey}`) — serializes concurrent
     retries of the same key (the item-E rationale).
  2. Look up the existing row by the 4-tuple.
  3. **No row →** insert `state='in_progress'` with the fingerprint, requestId, correlationId, `expiresAt =
     now + retention`; return `{ kind: 'started' }` (caller proceeds to execute the tool).
  4. **Row exists, different `requestFingerprint` →** return `{ kind: 'conflict' }` (caller maps to
     `validation.invalid_payload` — 005).
  5. **Row exists, same fingerprint, `state='in_progress'` →** return `{ kind: 'in_progress' }` (caller
     returns the `TradertonToolInvocationStatusV1` in-progress shape — 005; no second side effect).
  6. **Row exists, same fingerprint, `state='terminal'` →** return `{ kind: 'replay', terminalResponse }`
     (caller returns the stored terminal result — 005).
  Input `params`: `{ consumerId, ownerId, toolName, idempotencyKey, requestFingerprint, requestId,
  correlationId, retentionMs }` (retention is a VALUE — the caller passes it from
  `boundary.idempotencyRetentionHours`; the repo never reads config).
- **`complete(params): Promise<void>`** — transition a row to terminal: set `state='terminal'`,
  `terminalResponse = <mapped result>`, `updatedAt = now`. Keyed by the 4-tuple (or the row id from
  `beginOrResolve`). This is the authored delta (herobids had no in-flight→terminal transition).
- **`findByRequestId(requestId): Promise<Row | null>`** — for the F2b status endpoint. (Author now; F2b
  consumes it.)
- **A fingerprint helper** — `computeRequestFingerprint(input)` copy-adapted from
  `computeInstantiateRequestHash` (recursively key-sorted SHA-256). Fingerprint over the request-identity
  fields (the `toolName` + the `payload` + the subject — the fields that make two requests "the same
  request"; NOT requestId/correlationId/timestamps, which legitimately differ across retries). Put it where
  it is unit-testable without a DB.

Keep the repo db-only: it must NOT import from `@traderton/boundary` (dependency direction is
boundary → db, never the reverse). Represent the terminal response as `Record<string, unknown>`.

## 5. F2a tests (`boundary-invocations.integration.test.ts`, `DATABASE_URL`-gated)

Mirror `packages/db/src/bot-limit.integration.test.ts`: `const SKIP = !process.env['DATABASE_URL'];
describe.skipIf(SKIP)(...)`, `openTestDb`/`truncate` helpers (`packages/db/src/test-helpers/integration-db.ts`),
`beforeAll` open / `afterAll` `client.end()` / `beforeEach` `truncate(client, 'boundary_invocations')`. Prove:

- **fresh key → `started`** (a new row is inserted `in_progress`).
- **same key + same fingerprint while `in_progress` → `in_progress`** (no duplicate row; the original stands).
- **same key + same fingerprint after `complete` → `replay`** returning the stored `terminalResponse`.
- **same key + different fingerprint → `conflict`**.
- **the 4-tuple is the key** — differing only in `consumerId` / `ownerId` / `toolName` / `idempotencyKey`
  are DISTINCT rows (no false collision).
- **concurrency** (the real proof, like item E): N concurrent `beginOrResolve` for the SAME key → exactly
  ONE `started`, the rest `in_progress` (the advisory lock serializes; without it, N inserts race the unique
  index). Use `Promise.all` of N calls; assert exactly one `started` + one row in the table.
- **`findByRequestId`** returns the row for a known requestId (feeds F2b).

The fingerprint helper also gets a small **unit** test (no DB): same logical request → same hash; reordered
object keys → same hash; changed payload → different hash.

## 6. Guardrails / stop-gates

- **Copy-adapt, do not author fresh** (D1). If you find yourself designing a fingerprint or dedupe scheme
  from scratch, STOP — mirror `blueprint-idempotency.ts` + the blueprints route and re-key.
- **Author no trading behaviour** — this is a persistence store for the boundary; it dispatches nothing.
- **db must not depend on boundary** — terminal response is a `Record<string, unknown>`.
- **Do NOT hard-code retention** (005) — it is a VALUE passed into `beginOrResolve`.
- **Do NOT touch `packages/boundary`** or wire the store anywhere — F2a is the store in isolation.
- **Do NOT run `db:migrate` against any real/shared DB** — `db:generate` (produces the SQL file) is enough
  for F2a; the integration test runs against a local `DATABASE_URL` you control.

## 7. Verification / done criteria

- `pnpm build` green, `pnpm lint` clean (the new schema/repo typecheck).
- `pnpm test` stays green (existing suite unchanged; F2a's integration test SKIPs without `DATABASE_URL`,
  the fingerprint unit test runs always).
- If a local Postgres is available, run the integration test with `DATABASE_URL` set (after applying the new
  migration to that local DB) and confirm it passes — report whether you could.
- Report: files added, the migration filename `db:generate` produced, how the copy-adapt maps to the
  herobids oracle (fingerprint + lock flow) and what you authored on top (state/expiry/in_progress), and any
  seam surfaced. Do NOT commit — the coordinator commits on the branch.
- **Then PAUSE** — F2b (dispatcher integration) is the next prompt, gated on human review of F2a.

## 8. Key file map

- COPY-ADAPT sources (READ-ONLY): `herobids/apps/api/src/services/blueprint-idempotency.ts`,
  `herobids/apps/api/src/routes/blueprints.ts` (the fork route transaction),
  `herobids/packages/db/src/schema/blueprint-instantiation-requests.ts`.
- Traderton patterns to mirror: `packages/db/src/repositories.ts` (`BotRepository` advisory-lock methods),
  `packages/db/src/schema/bots.ts` (schema style), `packages/db/src/bot-limit.integration.test.ts` +
  `packages/db/src/test-helpers/integration-db.ts` (gated integration test).
- Contract: [005 §Deadlines, Retries, And Idempotency](../../docs/005-consumer-boundary-contract.md) — the exact
  semantics. Decisions: [013 §8.1.1](./013-9b-authoring-plan.md), [030](./030-F2-m2-rest-proposal.md).
