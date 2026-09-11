# L3 direction overview (for the herobids agent — info only)

**Status:** Informational. No action from this doc. It gives the herobids `consume-traderton`
agent the shape of where we are and where we're heading, so per-slice briefs land in context.
Authored on the Traderton side; grounded in a scan of the current herobids `consume-traderton`
tree (importer analysis, 2026-09-08).

## The one objective

**Legal-isolation: no trading logic runs in the herobids platform process.** All trading —
execution, provisioning, market-data fetching, regime/scoring, the scan pipeline — runs behind the
Traderton REST boundary and is invoked as tools. herobids becomes a pure consumer. Everything below
serves this. "copy-never-author" is a subordinate tactic; when it conflicts with the objective, the
objective wins (see the Q2 candle-fetch decision).

## What's DONE (on branches, nothing merged; all gated on the human merge gate)

- **Q3 BrowserlessAdapter re-home** (herobids `consume-traderton`) — reviewed APPROVED. It was
  misfiled in `@herobids/venues`; it's the agentic browser, now moved out. Cleared one non-trading
  `venues` importer.
- **Q1 backtesting-drop** (herobids `consume-traderton`) — reviewed APPROVED. Operator backtesting
  capability deleted; `@herobids/engine` untouched; journal `backtest_run_id` kept as a vestige;
  `maxConcurrentBacktests` kept inert. Two follow-ups surfaced (dead `decision_contexts` schema;
  orphaned `marketDataRecording` config) — being recorded in a herobids register.
- **Q2 `score_candidate` tool** (Traderton `q2-read-tools`) — reviewed APPROVED. New boundary READ
  tool wrapping `scoreCandidate`, fetching candles behind the boundary (orderbook + swap). The
  regime tool (`check_regime`, wrapping `evaluateRegime`) already existed. Also added the **read-tool
  resolver seam** (read-only tools skip the venue-account requirement).
- **L3-P1 `provision_venue_account` tool** (Traderton `l3-p1-provision`) — APPROVED, built. The
  boundary write tool herobids will call to provision a venue account + credentials.

## The honest picture of what still blocks cutover (corrected by importer analysis)

Earlier framing over-simplified this. The real state of the surviving trading-package importers in
herobids `consume-traderton`:

- **`@herobids/engine`** — 5 surviving live importers: `agent-risk-limits`, `shared/decision-validation`,
  `reconciliation-orphaned-cleanup`, `public-stream-routing`, `technical-phase`. Engine deletion is a
  separate later slice; NOTHING done so far unblocks it.
- **`@herobids/venues`** — importers across API (`setup`, `chat`, `accounts`, `index` — wallet-gen +
  venue adapters) and worker (`scanner-candle-fetcher`, `index`, `public-stream-routing`).
- **`@herobids/market-data`** and **`@herobids/strategy`** — imported by market-intelligence (the Q2
  targets) BUT ALSO by a **surviving in-process trading scan pipeline** in the worker:
  `technical-phase.ts`, `complete-technical-scan.ts` (explicitly "extracted from
  AgentTradingActor.runTechnicalScan"), `scanner-candidate-discovery`, `scanner-pre-filter`,
  `tick-gates`, `hybrid-decision-sizing`, `swap-token-resolver`, `runtime-composition`, `agent.ts`.

**Key correction:** Q2 (re-pointing market-intelligence's 3 call sites) does **NOT** by itself unblock
`market-data`/`strategy` deletion — the in-process scan pipeline still holds them alive. That scan
pipeline is its own significant surviving in-process trading surface and will need its own
investigate→propose→extract track. Do not expect any single Q-slice to delete a package.

Similarly, **`venue_accounts` / `user_credentials`** have many surviving readers beyond provisioning
(API: `trading-provisioner`, `credentials`, `accounts`, `connections`, `agent-config-helpers`,
`provider-links`, `credential-dependents`; worker: `startup-context`,
`assessment-identity-resolver`, `gmail-credential-resolver`; db repos). So **L3-P1b (herobids calling
`provision_venue_account`) is necessary but not sufficient** to drop those tables — the whole
credential/account consumer surface must migrate behind the boundary first. Table deletion is
downstream of that, not of L3-P1b alone.

## The recommended direction (sequence)

Slices are ordered so each is independently reviewable and each Traderton dependency exists first.
Deletion of packages/tables comes LAST, only once every importer is re-pointed.

1. **L3-P1b — herobids calls `provision_venue_account`** (herobids side; Traderton tool ready).
   Re-point the holistic provisioning path (the endpoint that fills agent_connection / connection /
   venue_account / user_credentials) to call the boundary tool for the trading half. Highest-value
   next step: exercises the built tool, and is the first move toward retiring the trading tables.
   Does NOT delete the tables yet (many readers remain).
2. **Q2 re-point — market-intelligence → boundary** (herobids side; both tools ready).
   `coordinator.ts` + `evidence-adapters.ts` regime calls → `check_regime`; `preset-scorecard-runner`
   → `score_candidate`. Clears market-intelligence as a `market-data`/`strategy` importer (but not the
   scan pipeline — see above).
3. **Q3 groups 1+2 — venue adapters + wallet-gen behind the boundary** (herobids side).
   Pairs with L3-P1b (wallet-gen is part of provisioning). Public-stream piece already resolved: the
   stream follows the executor behind the boundary; the platform reads latest price via a poll tool
   (no streaming channel). Candle-fetcher joined to Q2's behind-boundary fetch.
4. **The in-process scan pipeline** (`technical-phase` / `complete-technical-scan` / scanner-*) —
   its own investigate→propose→extract track. This is the large surviving in-process trading surface;
   it, not the Q-slices, is what ultimately unblocks `market-data`/`strategy`/`engine` deletion.
5. **Deletions, last** — once every importer of a package is re-pointed, delete the package; once
   every reader of `venue_accounts`/`user_credentials` is migrated, drop the tables (with migration).
   `engine` deletion after its 5 importers are cleared.

Order rationale (verified against the importer graph): the Traderton tool for a re-point must exist
before the re-point (L3-P1, Q2 tools, all done → their re-points are unblocked). Re-points before
deletions (a package can't be deleted while any importer survives). L3-P1b first because its tool is
ready and it opens the credential/account-migration track that everything table-related depends on.

## Working rules (unchanged)

- Traderton is the source of tools; herobids is the consumer. Traderton-side builds happen on
  Traderton branches (done by the Traderton coordinator); herobids re-points happen here.
- **Nothing merges to either `main` without explicit human approval.** Every slice pauses for review
  (Traderton coordinator reviews herobids slices cross-repo) then the human merge gate.
- Surface blockers; don't paper over. Decompose large slices. Each slice independently reviewable.
- Cross-branch note: herobids calling a Traderton tool that lives only on an unmerged Traderton branch
  needs a decision on how herobids consumes unmerged-to-`main` Traderton work — to be settled in the
  L3-P1b brief.
