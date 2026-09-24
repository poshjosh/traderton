# D1-c1 — Re-point AGENT-EVALUATION trading-table reads over the Traderton boundary

**Status:** PLAN (not yet implemented). Author: planning agent, investigate-grounded.
**Slice:** D1-c1 of the herobids→Traderton trading-extraction migration.
**Branches:** Traderton tools/repo land on the Traderton L3 branch (`l3-integration` per
CANONICAL-STATE §2.1); herobids re-points land on the herobids `consume-traderton` branch. Nothing
merges to either `main` (merge gate — CANONICAL-STATE §4/§5).
**Reads:** CANONICAL-STATE §2.0 (greenfield), §3.2 #4 (Traderton owns bots), §4 (invariants),
005 (boundary contract), 006 (capability manifest), 008 (decision process).

---

## 0. Goal (restated) + the one scope correction this investigation forces

**Goal:** re-point the herobids AGENT-EVALUATION subsystem's reads of the local trading tables over
the Traderton REST boundary, so those tables can be dropped from herobids at D1-c4. Evaluation stays
PLATFORM (kept in herobids, Intentional-Divergence) but legitimately needs the RAW trading rows for
per-fill analysis, redaction, and security-scan — so these boundary reads return **FULL ROW arrays**
(accepted; no derivation suffices).

### 0.1 Scope correction — `agent_runtime_sessions` is PLATFORM, not a trading table (VERIFIED)

The task lists five loaders. Four read trading tables Traderton owns; **one does not.**

- `agent_runtime_sessions` (herobids `packages/db/src/schema/agent-runtime-sessions.ts`) **hard-FKs
  `agents.id`** (`references(() => agents.id, { onDelete: 'cascade' })`), is **agentId-scoped** (not
  `actorType`/`actorId` trading-scoped), and is written by the **agent-container lifecycle** (the
  quarantined `capabilities/trading.ts` route `insert(agentRuntimeSessions)`), NOT by the trading
  runtime.
- It is **NOT** one of the four D1-c4 trading tables (`fills`, `journal_events`, `positions`,
  `bots`). Confirmed: `@traderton/db` live schema barrel does **not** export `agentRuntimeSessions`
  or `loadAgentRuntimeSessions` (only the quarantined `_deferred-authoring` code references them, and
  that code is not built).

**Consequence (binding on this slice):** `loadAgentRuntimeSessions` reads a table that **stays in
herobids**. Do NOT author a `get_agent_runtime_sessions` boundary tool and do NOT re-point the
`sessions.json` collector or `/agents/:id/export/sessions`. They continue reading the local
`agent_runtime_sessions` table (unchanged). This slice re-points **fills, journal, positions, and
botIds** only.

> **4-RISK FLAG (route to a decision agent — 008 trigger "changing scope of what crosses the
> boundary"):** this scope correction narrows the slice from five loaders to four. It is
> fact-grounded (FK + writer + barrel evidence above), but it changes what D1-c4 can drop and what
> the evaluation artifacts source from. **Recommendation to carry into the brief:** sessions is
> platform-owned and out of D1-c1/D1-c4 trading-table scope. Confirm before implementing so D1-c4's
> drop-list stays correct. If the decision agent disagrees (e.g. wants sessions behind the boundary
> too), add a sixth sub-step mirroring the journal tool. Everything below assumes sessions stays
> local.

---

## 1. Grounded facts (verified in code this session)

**herobids loaders** (`packages/db/src/agent-evidence-loaders.ts`): `loadAgentBotIds`,
`loadAgentFills`, `loadAgentJournalEvents`, `loadAgentPositions` each union agent-native rows
(`actorType='agent'`, `actorId=agentId`) + agent-owned-bot rows (`actorType='bot'`, `actorId IN
botIds` where `bots.creatorType='agent' AND bots.creatorId=agentId`). Time filters:
`fills.filledAt`, `journalEvents.createdAt`; positions supports an `at` snapshot
(`openedAt <= at AND (closedAt IS NULL OR closedAt > at)`). All return `$inferSelect` full rows.
`opts.botIds` lets callers pre-resolve bot IDs to avoid re-querying.

**Consumer 1 — evidence-assembler** (`apps/worker/src/agent-evaluation/collectors/evidence-assembler.ts`):
resolves `botIds` once via `loadAgentBotIds`, then calls `loadAgentFills` / `loadAgentJournalEvents`
/ `loadAgentRuntimeSessions` / `loadAgentPositions` with `{ ...timeFilter, botIds }`; writes each as a
raw JSON artifact (`fills.json` / `journal.json` / `sessions.json` / `positions.json`). Fills, journal,
positions are **core (must succeed → throw on failure)**. Injected via `assembleEvidence(ctx)` where
`ctx` carries `{ db, agentId, scope, store, runId, sessionTimestamps, redis }`; called from
`run-evaluation.ts` step 1. Downstream: analyzers read the raw artifacts; `run-evaluation.ts` step 3
redacts them in place (`redactJson`). **Parity bar: the four re-pointed artifacts must contain
equivalent rows to today; redaction/analysis must be unaffected.**

**Consumer 2 — exports.ts** (`apps/api/src/routes/exports.ts`): the AGENT endpoints use the loaders —
`/agents/:id/export/trades` (`loadAgentFills`), `/agents/:id/export/journal`
(`loadAgentJournalEvents`), `/agents/:id/export/costs` (`loadAgentFills`), `/agents/:id/export/sessions`
(`loadAgentRuntimeSessions` — **stays local**, §0.1), `/agents/:id/export/bundle` (`loadAgentFills` +
`loadAgentPositions` + `loadAgentJournalEvents` + `loadAgentRuntimeSessions`). Each is preceded by an
owner check (`agents where id=:id AND userId=request.userId`). The BOT endpoints
(`/bots/:id/export/*`) and the ACCOUNT endpoints (`/export/trades`, `/export/bundle`) query the trading
tables **directly** (not via the loaders) — they are user/bot-scoped, not agent-scoped, and are
**out of D1-c1 scope** (they belong to a bot/account re-point slice; note them but do not touch).

**Traderton boundary infra (all verified present):**
- Owner-scoped bot read-wave already exists (`packages/worker/src/tools/bots.ts`:
  `get_owner_bot_costs/sessions/journal/journal_summary`, `list_owner_bots`, `get_owner_bot_status`;
  `delete_bot`). These are the copy-adapt template for new agent-scoped tools.
- Repo (`packages/db/src/repositories.ts`): `getBotsByCreator(creatorType, creatorId, since?)`
  already resolves agent-owned bot IDs (`eq(bots.creatorType), eq(bots.creatorId)`) — **exactly**
  herobids `loadAgentBotIds`'s query. `getBotByIdForOwner`, `getBotsByOwner` also present.
- Tools registered in `packages/boundary/src/registry.ts` via `@traderton/worker` barrels
  (`botManagementTools` etc.).
- Read consumption in herobids: `TradertonReadResult = success{data:unknown} | failure | in_progress
  | transport_error` (`packages/domain/src/trading/tool-contract.ts`); worker read adapter
  `createTradertonReadBoundary(client, subject, deadlineMs)`
  (`apps/worker/src/traderton/read-adapter.ts`) binds subject VALUES + deadline, tool supplies
  `{toolName, payload}`.
- Subject patterns: SYSTEM subject `{ ownerId: consumerId, actor: {type:'system', id:'market-intel'} }`
  (`apps/worker/src/index.ts` `systemReadBoundary`); **per-agent** subject
  `{ ownerId: <agents.userId lookup>, actor: {type:'agent', id: agentId} }` (B3-monitor
  `evaluateAgentWatches`, same file). The user-facing API path uses `{ ownerId: request.userId, actor:
  {type:'agent', id} }` (approval-service pattern).

**Row-shape fidelity (verified):** Traderton `fills`/`journalEvents`/`positions` schemas carry the
columns the herobids analyzers/loaders read (`actorType`, `actorId`, `filledAt`, `createdAt`,
`openedAt`, `closedAt`, `side`, `symbol`, `quantity`, `price`, `fee`, `feeCurrency`, `venueRefId`,
`realizedPnl`, `payload`, `type`, `id`). **One additive divergence:** Traderton `fills` has
`realizedPnlDelta` (herobids may not). Additive columns are harmless for the assembler (writes raw
JSON) and the export CSV/JSON mappers (field-pick by name). **Row-shape verification is a concrete
check item in Sub-step 5, not an assumption.**

---

## 2. Design decisions (the six required questions — recommendation + rationale each)

### D1 — Tool granularity: GRANULAR (three tools), not a bundle. **[low-stakes mechanical]**
Author **three** agent-scoped read tools:
- `get_agent_fills` → `{ fills: FillRow[] }`
- `get_agent_journal_events` → `{ events: JournalRow[] }`
- `get_agent_positions` → `{ positions: PositionRow[] }`

botIds resolution is **folded into each tool** (each tool resolves agent-owned bots server-side — see
D2), matching how the herobids loaders default `opts.botIds`. No separate `get_agent_bot_ids` tool
(nothing consumes bot IDs alone across the boundary — the assembler only pre-resolved them locally as
a query optimization, which server-side resolution makes moot).

**Rationale / weighing:**
- **exports.ts wants them individually** — `/export/trades` (fills), `/export/journal` (journal),
  `/export/costs` (fills), `/export/bundle` (fills+positions+journal). Granular tools serve every
  endpoint directly.
- **The assembler wants all three** — a bundle would be one fewer round-trip. But: (a) the assembler
  runs once per evaluation (not hot-path — round-trips are cheap here); (b) a bundle tool is *new
  surface with no source precedent* (the herobids side never had a "bundle loader" — it called four
  loaders), so a bundle leans toward authoring a new aggregation shape; (c) granular tools keep the
  005 surface uniform with the existing `get_owner_bot_*` family and keep each tool's test small.
- **Server-side botIds resolution removes the bundle's main advantage** (one botIds resolution): each
  tool resolves once server-side anyway; there is no repeated cross-boundary botIds fetch to save.

Net: granular wins on surface uniformity, test burden, and avoiding an authored aggregate. The extra
two round-trips per evaluation are negligible.

### D2 — botIds resolution: Traderton-side, per tool, via existing `getBotsByCreator`. **[low-stakes]**
Traderton owns `bots` (CANONICAL-STATE §3.2 #4). Each tool receives the agent subject and resolves
agent-owned bots server-side: `botRepo.getBotsByCreator('agent', agentId)` → `botIds`. This is
**byte-identical** to herobids `loadAgentBotIds` (`eq(bots.creatorType,'agent'), eq(bots.creatorId,
agentId)`) — no new repo method needed; `getBotsByCreator` already exists and is the same query.
The tools then run the agent-native + agent-owned-bot union (copied from the loaders).

`agentId` = `subject.actor.id` when `actor.type === 'agent'` (the tool guards this). Owner scoping
(`ownerId`) is still carried for tenancy consistency with the `get_owner_bot_*` family, but the union
query keys on `creatorType='agent'`/`creatorId=agentId` per the copied loader logic.

### D3 — Row-shape fidelity: copy the loader queries verbatim; herobids narrows `data` with a thin runtime guard. **[low-stakes]**
- Traderton tools return the raw `$inferSelect` rows (JSON-serialized) inside the success payload
  (`{ fills: [...] }` etc.). The queries are **copied** from the herobids loaders (§D5), so the row
  shapes are Traderton's `fills`/`journalEvents`/`positions` `$inferSelect` — which match the columns
  herobids reads (§1 row-shape fidelity).
- herobids consumes `TradertonReadResult.success.data: unknown`. On the herobids side, add a **thin
  narrowing step** at the seam that: (a) checks `result.kind==='success'`, (b) reads the named array
  (`data.fills` / `data.events` / `data.positions`), (c) coerces JSON date strings back to `Date` for
  the fields the analyzers/mappers use (`filledAt`, `createdAt`, `openedAt`, `closedAt`) — because
  JSON transport stringifies `Date`. This is the ONE real fidelity risk: the loaders returned live
  `Date` objects; over the wire they become ISO strings.
  - **Assembler:** writes raw JSON — a stringified date in `fills.json` is acceptable **only if it
    equals what `JSON.stringify(new Date())` produced before** (it does: both are ISO-8601). So for
    the assembler, no coercion is strictly required for the artifact bytes to match. **Verify** the
    downstream analyzers (`analyzers/trading.ts`) don't call `Date` methods on the parsed artifact
    (they re-parse JSON, so they get strings either way — parity holds). Confirm in Sub-step 5.
  - **exports.ts:** the CSV/JSON mappers call `row.filledAt.toISOString()`, `row.createdAt.toISOString()`,
    `row.closedAt` comparisons, `parseFloat(row.realizedPnl)`. These need real `Date`/number types →
    the narrowing step **must** rehydrate dates (and keep numerics as strings, which they already
    are). This is the field-name/type divergence to handle explicitly.

**Recommendation:** author a small shared herobids-side mapper per row type (`toFillRow` /
`toJournalRow` / `toPositionRow`) that rehydrates dates and returns the `$inferSelect`-compatible
shape the existing code expects. Keep it in the herobids worker/api boundary layer (not in
`@herobids/db`, which is being emptied). This is a **thin seam**, not trading logic.

### D4 — Time-filter + positions `at` snapshot: carry as tool params. **[low-stakes]**
- `get_agent_fills` / `get_agent_journal_events`: `{ from?: string(ISO), to?: string(ISO) }`.
- `get_agent_positions`: `{ from?, to?, at?: string(ISO) }` (the `at` snapshot filter).
- Tools parse ISO strings → `Date` inside `execute` and apply the copied `gte`/`lte`/`at` filters.
  herobids callers serialize their `Date` bounds to ISO in the payload.

### D5 — Copy-vs-author: COPY the union queries into Traderton repo methods; AUTHOR only the thin tool seams. **[binding — invariant 1]**
- **COPY (verbatim, re-keyed only for imports):** the agent-native + agent-owned-bot union logic from
  `loadAgentFills` / `loadAgentJournalEvents` / `loadAgentPositions` (incl. the positions `at`
  post-filter) into **new Traderton repo methods** on the bot/evidence repository
  (`packages/db/src/repositories.ts`): `loadAgentFills(agentId, opts)`,
  `loadAgentJournalEvents(agentId, opts)`, `loadAgentPositions(agentId, opts)`. botIds resolution
  reuses the existing `getBotsByCreator('agent', agentId)`. These are copies of extant herobids
  behaviour → copy-never-author satisfied.
- **AUTHOR (thin seams only):** the three tool wrappers (Zod param schema, `convertZodToJsonSchema`,
  guards mirroring the `get_owner_bot_*` family — `botRepo`/`db` absent → `direct db access not
  available` fault:false; subject actor not an agent → fault:false error), the herobids-side narrowing
  mappers (D3), and the composition wiring (D6).

> **4-RISK ASSESSMENT — full trading-STATE rows over the boundary (008 trigger "weakening legal
> isolation"):** The derived-only rule (L3-Q2) is specifically about **MARKET DATA** (candles/prices
> must not be fetched by the platform → the platform stops touching the market-data pipeline).
> D1-c1 carries **trading STATE rows** (an agent's own fills/journal/positions) to the PLATFORM's
> evaluation subsystem, which is a *different* concern: evaluation is an accepted platform function
> that inspects an agent's own audit trail, and the rows are already agent-owned data the platform is
> entitled to for redaction/security-scan. This does **not** re-fetch market data and does **not**
> put trading execution back on the platform. **Assessment: this is within the accepted
> "full-row-for-evaluation" carve-out stated in the goal — no new legal-isolation weakening.**
> **However, it is new 005 surface that carries raw trading rows across the wire**, so per 008 it
> should still be **briefed-and-routed to a fresh decision agent** for a sign-off that "full trading
> STATE rows to the platform evaluation subsystem" is ratified (distinct from the market-data rule).
> Recommendation to carry: APPROVE (matches the goal's stated accepted posture); the brief is a
> confirmation, not an open question. Route this **before** landing Sub-step 1, in parallel with the
> §0.1 scope-correction flag (one combined brief covers both).

### D6 — herobids consumption seam: two subjects. **[binding pattern, already established]**
- **Evaluation (worker, platform system task):** use a **per-agent subject** exactly like B3-monitor's
  `evaluateAgentWatches` — resolve `ownerId` via `agents.userId` lookup, `actor = {type:'agent', id:
  agentId}`, build the read boundary with `createTradertonReadBoundary(client, subject, deadlineMs)`.
  Because the subject is per-agent (differs each run), the boundary must be built **per agent inside
  the assembler** (not a single composition-root singleton). Inject a factory/port into
  `EvidenceAssemblyContext`: `evidenceBoundaryFor(agentId, ownerId) => TradertonReadBoundary`, or pass
  the `TradertonClient` + a resolved `ownerId` and build the subject in the assembler. **Recommend:**
  inject an optional `agentEvidencePort` (a small interface with `getFills/getJournal/getPositions`
  bound to agentId) constructed in `run-evaluation.ts`/composition where the client + ownerId lookup
  live — keeping the assembler transport-agnostic. The assembler resolves `ownerId` the same way
  run-evaluation already does (`db.select({userId}).from(agents)...`).
- **exports.ts (API, user-facing):** use the **requesting user's subject** — `{ ownerId:
  request.userId, actor: {type:'agent', id} }` (the endpoint already verified `agents.userId ===
  request.userId`, so the owner is the caller). Build the read boundary from the API's
  `TradertonClient` (mirror how the API constructs its boundary today; if the API has no read boundary
  yet, add one in composition mirroring the worker's `systemReadBoundary` construction but with the
  per-request user subject).

Both paths must handle `TradertonReadResult` non-success kinds: for **evaluation core artifacts**
(must-succeed) a failure/transport_error must **throw** (preserving today's "core evidence must
succeed → abort" semantics); for **exports** map failure to an appropriate HTTP status (5xx/502-style
for transport, matching existing error conventions).

---

## 3. Sequencing (bounded sub-steps — no mega-change; prior Implementer runs timed out on large herobids multi-file tasks)

Order: **Traderton repo+tools first → register+document → herobids evaluation re-point → herobids
exports re-point → row-shape/parity verification.** Read-path-only slice throughout (all tools are
`read-database` category). Each sub-step is independently compilable + testable and small.

### Sub-step 0 — Decision checkpoint (BEFORE any code)
- Route one combined 008 brief covering: (a) the §0.1 sessions-is-platform scope correction, and
  (b) the D5 "full trading STATE rows to the platform evaluation subsystem" sign-off. Neutral,
  fact-grounded; recommendation carried but not self-ranked on the two flagged risks.
- **Gate:** do not start Sub-step 1 until ratified. Record the outcome in Traderton 004 + any parity
  note in 001.

### Sub-step 1 — Traderton repo methods (COPY the loader queries)
- **Files:** `traderton/packages/db/src/repositories.ts` (add `loadAgentFills`,
  `loadAgentJournalEvents`, `loadAgentPositions` — copied union logic; reuse `getBotsByCreator`).
  Import `fills`, `journalEvents`, `positions` from `@traderton/db` schema (already present).
- **Copied vs authored:** COPY the three union queries + positions `at` post-filter verbatim from
  herobids `agent-evidence-loaders.ts`, re-keyed to Traderton imports; AUTHOR nothing but the method
  signatures.
- **Verify:** `pnpm --filter @traderton/db exec tsc --noEmit` (per-package tsc, not root lint).
- **Tests:** copy/adapt the query-shape tests from the herobids loaders if any exist; else add unit
  tests asserting the union (agent-native + agent-owned-bot rows), time filters, and the positions
  `at` snapshot boundary (`openedAt<=at`, `closedAt IS NULL OR >at`). JSON vitest reporter; assert
  counts.

### Sub-step 2 — Traderton tools (AUTHOR the thin seams)
- **Files:** `traderton/packages/worker/src/tools/bots.ts` (or a sibling `agent-evidence.ts` in
  `tools/` if cleaner — follow the file the `get_owner_bot_*` family lives in for locality). Add
  `get_agent_fills`, `get_agent_journal_events`, `get_agent_positions` with Zod schemas (D4 params),
  guards mirroring `get_owner_bot_costs`, and payloads `{ fills }` / `{ events }` / `{ positions }`.
  Export via the tool barrel consumed by `registry.ts` (`botManagementTools` or a new
  `agentEvidenceTools` array added to the registry list).
- **Copied vs authored:** AUTHOR the wrappers (guards + schema are the established pattern, not
  trading behaviour); the query bodies delegate to the Sub-step 1 repo methods (copied logic).
- **Verify:** `pnpm --filter @traderton/worker exec tsc --noEmit`.
- **Tests:** copy/adapt the `get_owner_bot_*` tool tests → assert success payload shape, agent-scope
  guard (non-agent subject → fault:false), and time/`at` param pass-through. JSON vitest counts.

### Sub-step 3 — Register + document (Traderton-FIRST, per 005/006)
- **Files:** `traderton/packages/boundary/src/registry.ts` (ensure the new tools are in the registry
  list — automatic if added to an existing barrel; else add the new `agentEvidenceTools` import).
  `docs/features/initial/06-source-capability-manifest.md` (add the three tools to the inventory);
  `docs/features/initial/05-consumer-boundary-contract.md` (document the new read tools — names, params, payload
  shapes, `read-database` category). Update `docs/features/initial/01-parity-ledger.md` (D1-c1 status).
- **Position vs 005/006:** these are **new boundary tools → must be documented Traderton-first**
  (005 = the contract herobids consumes; 006 = the parity inventory). This sub-step is the
  Traderton-first documentation gate before herobids consumes them.
- **Verify:** `pnpm --filter @traderton/boundary exec tsc --noEmit`; boundary registry test (the tool
  is registered + read-only-gated) — copy/adapt the existing registry test.

### Sub-step 4 — herobids EVALUATION re-point (worker) — SMALL, isolated
- **Files:** `herobids/apps/worker/src/agent-evaluation/collectors/evidence-assembler.ts` (re-point
  fills/journal/positions to the injected `agentEvidencePort`; **leave `loadAgentRuntimeSessions`
  and the `sessions.json` collector untouched** — §0.1; drop the local `loadAgentBotIds`
  pre-resolution since the port resolves botIds server-side). Add the port to
  `EvidenceAssemblyContext`. `herobids/apps/worker/src/agent-evaluation/run-evaluation.ts` (construct
  the per-agent port: resolve `ownerId` via the existing `agents.userId` lookup, build the read
  boundary via `createTradertonReadBoundary`, pass into `assembleEvidence`). Add the herobids-side
  narrowing mappers (D3) — new small file e.g.
  `apps/worker/src/agent-evaluation/collectors/evidence-row-mappers.ts`.
- **Copied vs authored:** AUTHOR the thin port wiring + mappers only. Core-artifact failure must
  THROW (preserve must-succeed semantics).
- **Verify:** **direct worker tsc** — `pnpm --filter @herobids/worker exec tsc --noEmit` (root lint
  false-greens the worker). Run the assembler + run-evaluation tests with the JSON vitest reporter;
  assert artifact counts unchanged.
- **Tests:** update `evidence-assembler.test.ts` (mock the `agentEvidencePort` instead of the DB
  loaders for fills/journal/positions; keep the sessions/DB path mocked as today) and
  `run-evaluation.test.ts` (the `assembleEvidence` mock is unaffected, but add a wiring test that the
  port is built with the per-agent subject). Behaviour-named tests. Assert core-artifact failure →
  evaluation aborts.

### Sub-step 5 — herobids EXPORTS re-point (API) + row-shape/parity verification — SMALL, isolated
- **Files:** `herobids/apps/api/src/routes/exports.ts` — re-point the AGENT endpoints
  (`/agents/:id/export/trades` → `get_agent_fills`; `/export/journal` → `get_agent_journal_events`;
  `/export/costs` → `get_agent_fills`; `/export/bundle` → fills+positions+journal tools). **Leave
  `/agents/:id/export/sessions` and the bundle's sessions read on the local `loadAgentRuntimeSessions`**
  (§0.1). **Do NOT touch** the `/bots/:id/export/*` or account `/export/*` endpoints (out of scope).
  Reuse the D3 narrowing mappers (rehydrate dates before the CSV/JSON mappers). Wire a per-request
  user-subject read boundary in the API composition if not already present.
- **Row-shape verification (the concrete check):** diff a Traderton tool payload against a herobids
  loader row for each type — confirm every field the mappers/analyzers read is present and that date
  fields rehydrate correctly (`filledAt`/`createdAt`/`openedAt`/`closedAt`). Confirm the additive
  `realizedPnlDelta` on Traderton `fills` is ignored harmlessly. Confirm `analyzers/trading.ts` reads
  the re-parsed JSON artifact as strings (no `Date`-method calls) so assembler parity holds.
- **Verify:** **direct api tsc** — `pnpm --filter @herobids/api exec tsc --noEmit`. Run
  `exports` route tests with JSON vitest reporter; assert the agent endpoints' output bytes match the
  pre-re-point golden (parity), sessions endpoint unchanged, bot/account endpoints unchanged.
- **Tests:** update the agent-export tests to stub the read boundary (returning tool payloads) instead
  of the DB loaders; add a mapper unit test (date rehydration + additive-field tolerance). Keep the
  bot/account/sessions export tests as regression guards (must stay green untouched).

### Sub-step 6 — Cross-cutting verification + docs
- **Verify (full):** Traderton per-package tsc for `db`/`worker`/`boundary`; herobids **direct**
  `@herobids/worker` + `@herobids/api` tsc; targeted vitest (assembler, run-evaluation, exports,
  new repo/tool tests) via JSON reporter — record pass counts. (Root `pnpm lint` false-greens the
  worker; rely on the direct per-package tsc for the worker/api.)
- **Docs:** finalize 005/006/001 entries; append any forced deviation to Traderton 003; record the
  Sub-step 0 decision outcomes in 004.

---

## 4. Test strategy (unit vs integration vs visual)

- **Unit (bulk of coverage):** Traderton repo union queries (Sub-step 1), Traderton tool wrappers +
  guards + param pass-through (Sub-step 2), herobids narrowing mappers (date rehydration, additive
  tolerance), the assembler with a mocked port (Sub-step 4), the exports routes with a stubbed read
  boundary (Sub-step 5). All via the JSON vitest reporter; assert counts.
- **Integration:** the boundary registry test (tool registered + read-only-gated). A cross-boundary
  end-to-end (herobids evaluation → real Traderton boundary → real Postgres) is **not required for
  D1-c1** — it belongs to L3e differential/soak; a stubbed-boundary parity test is the D1-c1 bar. If
  an integration harness already exists on the L3 branch, a smoke run is a nice-to-have, not a gate.
- **Parity (the bar):** golden-output comparison for the four re-pointed evaluation artifacts and the
  agent export endpoints — bytes/rows equivalent to pre-re-point. Sessions + bot/account exports are
  regression guards (unchanged).
- **Visual:** none required (no UI surface in this slice).

---

## 5. Risks & open questions

1. **[4-RISK — routed in Sub-step 0]** Sessions-is-platform scope correction (§0.1) — confirm before
   implementing so D1-c4's drop-list is correct.
2. **[4-RISK — routed in Sub-step 0]** Full trading-STATE rows to the platform evaluation subsystem
   (D5) — confirm this is within the accepted evaluation carve-out (distinct from the market-data
   derived-only rule). Recommendation: APPROVE.
3. **Date rehydration (D3)** — the only real fidelity trap: loaders returned live `Date`; JSON
   transport yields ISO strings. Exports mappers need real `Date`; the assembler artifact bytes match
   either way but **verify** analyzers don't call `Date` methods on the parsed artifact. Mitigated by
   the narrowing mappers + Sub-step 5 verification.
4. **Per-agent subject in the assembler (D6)** — the boundary is per-agent, so it cannot be a single
   composition-root singleton; build per run. Mitigation: inject a per-agent port built in
   run-evaluation where the ownerId lookup + client live.
5. **API read boundary may not exist yet** — the worker has `systemReadBoundary`; the API may need a
   per-request user-subject read boundary constructed in composition (mirror the worker pattern). Small
   authored seam; flag if the API composition is larger than expected (split into its own sub-step to
   avoid a mega-change).
6. **Out-of-scope endpoints** — `/bots/:id/export/*` and account `/export/*` still read trading tables
   directly; they are NOT re-pointed here and will block D1-c4's table drop until their own slice.
   Note in 001 so D1-c4 sequencing accounts for them.

---

## 6. Handoff

Plan is complete and bounded. **One hard gate before implementation:** the Sub-step 0 decision
checkpoint (the two 4-risk items — §0.1 scope + D5 full-row sign-off) must be ratified by a fresh
decision agent / human per 008. Those are not in-plan settleable (they touch scope of what crosses
the boundary + legal-isolation confirmation). **Recommendation: route the combined 008 brief first;
on ratification, proceed Sub-step 1 → 6 via the coordinator loop, autonomously to the branches, with
the merge to `main` as the one hard stop.**
