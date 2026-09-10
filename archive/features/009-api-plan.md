# Phase 9 Plan (SEED) — `apps/api` (trading control-plane + 25 tools + deferred authoring)

**Phase:** 9 of the roadmap ([009](../009-extraction-roadmap.md)).
**Shape:** subtraction (LARGE) + the deferred authoring surface. Formal written keep/delete
classification REQUIRED before code moves (a full context-gatherer pass, like Phase 8).
**Depends on:** all extracted packages + Phase 8's `@traderton/worker` mechanical loop (which must be
green first — Phase 8 is currently blocked on source-fix #2).
**Status:** SEED — drafted from a light read of herobids `apps/api` + the Phase 8 deferrals
(2026-09-06). SPLIT into 9a/9b (2026-09-07). The interior is NOT knowable from this seed; a full
read-and-classify is 9a step 1.

## Phase 9 is SPLIT: 9a (copy, now) / 9b (authoring, post-holistic-review)

Per human decision (2026-09-07), Phase 9 separates the **copy** work from the **authoring** work so the
copyable value lands before the holistic review and only deliberate authoring waits behind the gate.

### 9a — COPY surface (execute NOW, before the holistic review)
Pure copy-and-delete, same bar as Phases 3–8 (verbatim copy + `@herobids/*`→`@traderton/*` rename + seam
deletion; build + copied tests green; reviewed; committed). Scope:
- **The 25 trading tool modules** (in `apps/worker/src/tools/`): trading = `account`, `analytics`, `bots`,
  `find-instrument`, `market-data`, `price`, `risk-limits`, `trading`, `watch` + support (`resolvers`,
  `schema`, `tool-errors`?). Platform tools (browser/code/email/shell/skills/…) = DELETE.
- **The clean API trading routes** (import only extracted packages): `bots`, `accounts`, `analytics`,
  `backtests`, `credentials`, `reconciliation`, `actor-health`, `exports`, `datasets`,
  `capabilities/trading`.
- **Full 25-tool inventory reconciliation** against [006](../../docs/006-source-capability-manifest.md): map each
  tool → module, mark Met vs Deferred, ensure every one of the 25 has a ledger disposition.
- **QUARANTINE rule (the Phase-8 pattern):** any tool/route that cannot compile + go green WITHOUT an
  authored dependency (the config shape, the intake/approval resolver, the composition root) is **quarantined
  verbatim** into `_deferred-config/` (worker) or a sibling `_deferred-authoring/` — NOT authored in 9a. 9a's
  deliverable is precisely "every tool/route that copies green without authoring"; the residue is cleanly
  handed to 9b.
- Where a tool package needs a home: decide at 9a step 1 whether the tools live in `@traderton/worker`
  (alongside the loop) or a dedicated package — pick the layout that keeps them copyable without authoring.

### 9b — AUTHORING (execute AFTER the holistic review)
The sanctioned authoring pass (M1 composition first; M2 REST boundary sequenced): the Traderton-owned
**config shape**, the **trading composition root**, the **decision-intake/approval** surface
(venue-account-direct resolver + `submit_decision` intake + human approvals), per-`ownerId` **maxBots**, and
the **M2 REST/005 boundary**. Un-quarantines the `_deferred-config/` files as their authored dependencies land.

The rest of this plan (below) is the combined Phase-9 detail; 9a executes its copy/inventory portions and
defers every authoring portion to 9b.

## Why Phase 9's scope is bigger than "copy the API routes"

Phase 9 is where the **M1→M2 boundary + the deferred authoring** land. It spans THREE source
surfaces, not one:

1. **`apps/api` trading routes** (herobids `apps/api/src`, 173 files, Fastify) — the HTTP
   control-plane. The trading routes are a minority; most of the app is platform (auth, oauth, billing,
   chat, skills, blueprints, telegram, agent-*, providers, sessions).
2. **The 25 trading TOOL modules** — these live in **`apps/worker/src/tools/`**, deliberately deferred
   from Phase 8 (decision 4: "Phase 9 owns the 25 tool modules + boundary"). NOT in `apps/api`.
3. **The Phase-8 deferred authoring** (all `Deferred (required for cutover)`):
   - the **decision-intake/approval/session cluster** (agent grant→venue-account resolution, `submit_decision`
     intake wiring, human approve/reject) — reclassified DELETE in Phase 8, owned here;
   - the **Traderton-owned config shape** (replacing herobids `config.ts`/`AppConfig` — decision 2);
   - the **trading composition root** (replacing the un-subsettable `index.ts` — the actor/loop wiring).

Per the M1/M2 model (000): most of #3 is **authored** (the config shape, the composition root, the
venue-account-direct resolver, and — when M2 arrives — the REST boundary + per-`ownerId` maxBots). This
is the phase where "defer authoring to the end" is cashed in, AFTER a holistic review.

## Light investigation findings (2026-09-06 — verify at step 1)

- **API trading routes are clean** (import only extracted `@traderton/*` packages): `routes/bots.ts`
  (db+domain), `routes/accounts.ts` (db+domain+venues), `routes/analytics.ts` (db), `routes/backtests.ts`
  (backtesting+db+domain), `routes/credentials.ts` (db+domain+engine), `routes/reconciliation.ts` (db),
  `routes/actor-health.ts` (db+domain), `routes/exports.ts` (db), `routes/datasets.ts` (db),
  `routes/capabilities/trading.ts` (db+domain). Candidate KEEP (verify each in full).
- **API platform routes = DELETE:** auth, auth-oauth, connections(-oauth), billing, chat, skills,
  blueprints, telegram-*, agents(-*), ai, providers, sessions, setup, dashboard, views, admin,
  agent-evaluations, agent-platform-assessment-reviews, agent-tools, agent-documents, agent-activity-*.
  Plus platform top-level (`auth-mailer`, `llm-model-catalog`, `ollama-model-discovery`, `plan-guards`,
  `sync-system-skills`, `trading-provisioner`?) and `services/*` (all blueprint/agent-*), `billing/`,
  `providers/`, `plugins/` — classify at step 1.
- **The 25 tools in `apps/worker/src/tools/`** split: **trading (KEEP for Phase 9)** — `account.ts`,
  `analytics.ts`, `bots.ts`, `find-instrument.ts`, `market-data.ts`, `price.ts`, `risk-limits.ts`,
  `trading.ts`, `watch.ts` (+ support `resolvers.ts`, `schema.ts`, `registry.ts`?, `tool-errors.ts`?);
  **platform (DELETE)** — `browser`, `code`, `email`, `filesystem`, `http-client`, `memory`, `messaging`,
  `shell`, `skills`, `ssrf-guard`, `tasks`, `web-access`, `workspace`, `platform-docs*`,
  `assess-strategy-preset`, `change-strategy-preset`. (Cross-check against the 006 tool inventory — the
  25 tools must ALL be accounted for: submit_decision, create_bot, start_bot, stop_bot, list_bots,
  resolve_bot, get_bot_status, adjust_bot_config, adjust_risk_limits, get_risk_limits,
  get_account_summary, list_positions, get_price, get_funding_rates, get_market_overview, get_analytics,
  check_regime, discover_tokens, search_tokens, find_instrument, watch_token, check_watches, list_watches,
  remove_watch, resolve_watch.)
- API imports platform packages (`@herobids/llm`, `@herobids/documents`, AWS SES, jose, fastify + auth
  plugins) — all DELETE-side; the trading slice must not pull them.

## Method (subtraction + authoring — heavier than any prior phase)

1. **Full context-gatherer classification** (step 1, mandatory): keep/delete for every `apps/api/src` file
   AND the `apps/worker/src/tools/` trading modules, with fused-edge + per-symbol barrel checks (the Phase
   8 lesson: read files in FULL, validate symbols against barrels, don't trust top-level imports).
2. **Copy the trading tool modules + trading routes verbatim** where they are clean copies.
3. **Author the deferred pieces DELIBERATELY** (this is the sanctioned authoring pass, post-holistic-review):
   - Traderton-owned config shape (decision 2) — replaces `config.ts`/`AppConfig`.
   - the trading composition root — wires the Phase-8 loop modules + tools (M1 in-process; M2 adds the REST
     boundary + per-`ownerId` maxBots).
   - the venue-account-direct decision-intake resolver + approval surface (the Phase-8 cluster's capability).
   These are authored to the ports (000 "ports carry values, never trading behaviour"): the risk gate,
   planner, executors, reconciliation stay Traderton's; the authored layer only wires + injects.
4. **M1 vs M2 within Phase 9:** land the in-process library composition + tools first (M1). The REST/HTTP
   boundary (005) is the M2 adapter — sequence it explicitly; it may be its own sub-phase.

## Likely stop-gates (per 009 — state the guard, not "expected clean")
- Ownership of shared API middleware / error-handling / request-log redaction (trading vs platform).
- The boundary contract (auth/idempotency/deadline, 005) is **authored infrastructure** — clarify what is
  copied vs. legitimately-new seam code (the M2 adapter). This is expected authoring, logged as such.
- Any trading route/tool that hard-depends on a platform service (auth/session/billing) not cuttable by
  deletion → classify; escalate if it needs authored non-trivial trading logic.
- The 25-tool inventory: any tool that can't be preserved → Deferred/Gap ledger entry (never silent).

## Deliverables / acceptance (refine at finalize)
- The 25 trading tools execute through the Traderton library surface (M1) / boundary (M2); copied tool +
  route tests green; the 006 25-tool inventory FULLY accounted for in the ledger.
- Traderton-owned config + composition root authored; the Phase-8 `@traderton/worker` loop is wired and runs.
- `create_bot`/`start_bot` per-`ownerId` limit authored (resolves the Phase-8 Deferred-required).
- Decision-intake/approval surface authored (resolves the Phase-8 cluster Deferred-required).
- Forbidden-import sweep: no `@herobids/*`, no llm/documents/ses/platform-auth in the trading slice.
- Ledger: all 25 tool rows + boundary + config + composition → Met/authored with evidence; every deleted
  platform route/tool/service → Intentional Divergence; cutover-gate `Deferred (required for cutover)`
  entries (intake, approvals, maxBots) resolved.
- Mark Phase 9 Done in 009; seed Phase 10 (infra).

## Review checklist (subtraction + authoring)
- Written classification reviewed before implementation.
- Copied files: verbatim modulo namespace rename; per-symbol barrel check; kept tests unmodified.
- **Authored files: clearly delineated from copied files** (a manifest of what was authored vs copied), so
  the copy-never-author boundary stays auditable. Authored code respects the ports invariant.
- Sweep ROOT config for stale refs; no stray files.
- Every deleted platform capability + every authored piece has a ledger row — nothing silent.

## Dependencies / sequencing note
Phase 9 CANNOT start its trading-loop wiring until **Phase 8 is green** (blocked on source-fix #2). The
classification (step 1) and the 25-tool inventory mapping CAN be done in parallel while the source-fix is
in flight (read-only). The authoring sub-steps wait for Phase 8's loop modules to land.


---

## 9a FINALIZED classification (investigated 2026-09-07, read-only)

### Tool modules (`apps/worker/src/tools/`) — verified dependency map

**Clean copies (import only `@herobids/domain` + `./registry` + `../logger`):**
`account.ts`, `analytics.ts`, `bots.ts`, `find-instrument.ts`, `price.ts`, `risk-limits.ts`, `trading.ts`,
`resolvers.ts`, `schema.ts`, `registry.ts`. → copy verbatim + rename.

**Trading, but reclassified from the Phase-8 DELETE set (copy into the 9a tool surface):**
- `intelligence-tools.ts` — imports ONLY `@herobids/market-data`; a clean copy. It implements
  `executeDiscoverTokensTool` / `executeFundingRatesTool` / `executeMarketOverviewTool` (the tools
  `discover_tokens` / `get_funding_rates` / `get_market_overview`). It was DELETE'd in Phase 8 because its
  only *worker-loop* consumers were agent files — but it IS trading in the *tool* context. **Copy it in 9a.**
  (Ledger note: this is a context-dependent classification, like the "herobids becomes a consumer" cases —
  platform in one context, trading in another; here it's trading and copied.)

**Trading, need a small verbatim seam-relocation (NOT authoring — the scan-types pattern):**
- `market-data.ts` (tool) — imports the 3 functions above from `intelligence-tools` → resolves once
  `intelligence-tools.ts` is copied. Otherwise clean (`@herobids/market-data` + `./registry` + `../logger`).
- `watch.ts` (tool) — imports `summarizeActiveWatches` from the DELETE'd `runtime-composition.ts`. That
  function + its helper closure (`MAX_ACTIVE_WATCHES_IN_CONTEXT`, `compareWatchEntries`, `watchSummaryKey`,
  `mergeWatchEntry`, `formatWatchNote`, `formatWatchStatus`) operate only on `RuntimeActiveWatch` /
  `RuntimeActiveWatchSummary` (both already in Traderton `scan-types.ts`). **Relocate this self-contained
  watch-summary block verbatim** into a trading module the watch tool imports (e.g. extend `scan-types.ts`
  or a `watch-summary.ts`) — a scan-types-style seam, not authoring. `watch.ts` also imports
  `../position-coverage.js` + `../watch-types.js` (both landed in the worker loop) + `./price`.

**DELETE (platform — Intentional Divergence):**
- `tool-errors.ts` — imports `CapabilityDenial` from platform `agents/capability-policy.js`; its ONLY
  consumers are platform tools (`browser`, `code`, `shell`, `skills`, `http-client`, `web-access`,
  `assess-strategy-preset`, `change-strategy-preset`). No trading tool imports it. → DELETE.
- All platform tools: `browser`, `code`, `email`, `filesystem`, `http-client`, `memory`, `messaging`,
  `shell`, `skills`, `ssrf-guard`, `sandbox-utils`, `tasks`, `web-access`, `workspace`, `platform-docs`,
  `platform-docs-data`, `assess-strategy-preset`, `change-strategy-preset`.
- `index.ts` (tool barrel) — trim to trading exports only (drop the platform-tool export lines).

### Package layout decision (9a)
The trading tool modules import `../logger.js`, `../position-coverage.js`, `../watch-types.js`,
`../intelligence-tools.js` — i.e. they live NEXT TO the worker loop. Simplest copyable layout: **place the
trading tools under `@traderton/worker` (e.g. `packages/worker/src/tools/`)**, reusing the loop's `logger`,
`position-coverage`, `watch-types` already landed there. (A dedicated `@traderton/tools` package would force
re-homing those shared deps — more churn, no benefit for 9a.) Confirm at implement time; the guard is
"whichever layout copies green without authoring."

### API trading routes (`apps/api/src/routes/`) — 9a copy candidates
`bots.ts` (db+domain), `accounts.ts` (db+domain+venues), `analytics.ts` (db), `backtests.ts`
(backtesting+db+domain), `credentials.ts` (db+domain+engine), `reconciliation.ts` (db), `actor-health.ts`
(db+domain), `exports.ts` (db), `datasets.ts` (db), `capabilities/trading.ts` (db+domain). Verified at
seed time to import only extracted packages. **9a step-1 must read each in full** (the Phase-8 lesson:
top-level scans lie) + check every symbol against the barrels + check for Fastify/auth-plugin/middleware
coupling. Any route needing an authored dependency (config shape, auth middleware, the composition root) →
**quarantine**, defer to 9b. The API app shell itself (Fastify server bootstrap, `index.ts`, auth/error
middleware) is largely 9b/authoring — 9a copies the route HANDLERS that are clean, not the server wiring.

### QUARANTINE rule (Phase-8 pattern, applies throughout 9a)
Any module that cannot compile + go green WITHOUT an authored dependency → move verbatim into
`_deferred-authoring/` (excluded from build + vitest) with a README; hand to 9b. Do NOT author in 9a.

### 9a stop-gates (state the guard)
- A tool/route needs a domain/db/engine/venues symbol not in the Traderton barrels → source-fix request.
- A "clean" route turns out to need auth/session/config middleware not cuttable by deletion → quarantine (9b).
- The 25-tool inventory: any tool with no clean copy path → record Deferred/Gap (never silent).
- Any authoring temptation → STOP; quarantine instead (9a is copy-only).

### 9a deliverable
Every trading tool + clean API route handler that copies GREEN without authoring, landed + reviewed +
committed; the full 25-tool inventory reconciled against 006 (each tool → module, Met/Deferred); the
authoring residue cleanly quarantined for 9b. Then: pause for the holistic review before 9b.
