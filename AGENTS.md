# AGENTS.md

Rules for AI agents working on **Traderton** — trading infrastructure for
AI/LLM agents (crypto now; forex, commodities, equities, and more later),
exposed over API now and MCP/skills later.

## Read first — tiered (the docs ARE the project's memory)

A fresh session knows nothing of the reasoning behind this project unless it reads
the docs. But the project is now far along (extraction M1 complete), so you do **not**
need to read everything up front. Read the **always-read** tier at session start;
consult the rest **when the topic is relevant** (pointers below). Authority is
unchanged — every doc still binds; this only changes reading *order/cost*.

**Always-read at session start (small — the minimum to not do damage):**

1. **This file (AGENTS.md)** — the hard rules (below): copy-never-author, source-fix
   discipline, work-only-in-traderton / herobids-read-only.
2. **[docs/000-vision.md](./docs/000-vision.md)** — goal, method, settled decisions,
   "herobids becomes a consumer." The law. Source of truth.
3. **[docs/001-parity-ledger.md](./docs/001-parity-ledger.md)** — the live parity
   status + cutover gates. **The single source of truth for what is done vs. pending.**
   Update it as you work.
4. **[docs/024-verification-and-consumption-roadmap.md](./docs/024-verification-and-consumption-roadmap.md)**
   — **where we are now / what's next.** M1 (extraction) is code-complete; 024 governs
   proving the library is consumable (L1 harness → L2 differential → F REST → L3
   herobids consumes it). Start here for "what do I do next."

**Consult when relevant (authoritative; not required up front):**

- **[docs/004-decision-log.md](./docs/004-decision-log.md)** — the *why*. Read when a
  rule seems arbitrary or a case isn't covered; the reasoning tells you which way to lean.
- **[docs/003-anomalies-and-deviations.md](./docs/003-anomalies-and-deviations.md)** —
  forced deviations + source-fix request log. Read/append when you hit a deviation.
- **[docs/009-extraction-roadmap.md](./docs/009-extraction-roadmap.md)** — the extraction
  roadmap (phases 1–10, **mostly Done**). Read for extraction history / the per-phase
  pattern. The per-phase execution loop it defines is still the loop we run.
- **[docs/features/013-9b-authoring-plan.md](./docs/features/013-9b-authoring-plan.md)** —
  the Phase-9b authoring detail (items A–F; A–E Done, **F = M2 REST is the remaining item**).
  Read when working on F or reviewing what 9b authored vs copied vs dropped.
- **[docs/005-consumer-boundary-contract.md](./docs/005-consumer-boundary-contract.md)** —
  the consumer boundary (HMAC/envelope/idempotency). Read at F and cutover.
- **[docs/006-source-capability-manifest.md](./docs/006-source-capability-manifest.md)** —
  the static parity inventory the ledger scores against. Read when auditing coverage.
- **[docs/007-operational-readiness.md](./docs/007-operational-readiness.md)** — the
  cutover proof (latency/equivalence/restart/rollback). Read at L3/cutover.
- **`docs/features/*`** — per-phase/per-item plans + implementer prompts (drafted at each
  item's start; e.g. 011 M1 review, 015–023 the 9b item designs/prompts). Read the one
  for the item you're on.
- **Historical (do not re-execute):** [002](./docs/002-phase-0-subtraction-plan.md)
  (Phase-0 plan), [008](./docs/008-phase-1-scaffold-and-domain-slice.md) (Phase-1 doc).

Do not rely on prior chat context — assume you have none. If a decision isn't in these
docs, it does not exist yet: decide it deliberately and record it.

## Where you are / where to start

- **Extraction (009, phases 1–10): M1 is code-complete.** Items A–E of Phase 9b landed
  green (config shape, composition root, decision intake, drive path + 25 tools, per-owner
  maxBots). See the item-A–E blocks in [001](./docs/001-parity-ledger.md) +
  [013 §7.5](./docs/features/013-9b-authoring-plan.md). Full build/lint/test green.
- **The next work is verification + consumption**, governed by
  [docs/024-verification-and-consumption-roadmap.md](./docs/024-verification-and-consumption-roadmap.md):
  **L1** (in-repo end-to-end integration harness — prove the library is consumable against
  real Postgres+Redis, nothing stubbed), then **L2** (differential guarantee vs a pinned
  herobids ref), **F** (the M2 REST boundary — the last 9b item, [013 §8](./docs/features/013-9b-authoring-plan.md)),
  and **L3** (herobids consumes `@traderton/*` on a branch → cutover). Start at the first
  `Queued`/`Active` level in the 024 table and run the investigate → propose (pause for
  human) → implement → review → test → update-docs loop.
- **L3 ownership:** the herobids `consume-traderton` branch is **herobids-owner territory**
  (it edits herobids — which we never do). We produce the consumable library + the
  comparison harness + the migration spec; the owner executes the branch and the merge.
  See 024 §Ownership boundary.
- The single source of truth for done-vs-pending is the parity ledger
  ([001](./docs/001-parity-ledger.md)); 024 tracks the verification levels; 009 tracks the
  (now mostly Done) extraction phases. Per-item plans live git-tracked in `docs/features/`.

## The rule you must not break

We are extracting Traderton from the existing [herobids](../herobids/) system by
**copy-and-delete**, not rewriting from scratch.

> **Copy, never author.** Every line of trading behaviour must arrive by being
> copied from the source system. The only things you author are **deletions**
> and the **thin seams** where platform couplings are cut.

- Do not reimplement trading logic from your own model of how it "should" work.
- Do not write new tests that assert your assumptions. Bring the source tests
  across; they are the parity harness.
- After every deletion: the build compiles and the copied tests pass. If not,
  you found a real dependency or cut a seam wrong — fix it there before moving on.
- The bar is **feature parity** with the source, not "does it run." We may
  improve; we must not degrade. Anything you can't preserve goes in the ledger
  as **Gap** or **Deferred** — never silently dropped.

### Source-fix requests

When the cleanest seam requires reshaping the source, you may *request* a
behaviour-preserving change in herobids — you must never edit herobids yourself.
The change is made, tested, gated, and released in herobids by the owner; then
you copy from the improved source. Requests must be behaviour-preserving
(validated by herobids' existing tests) — they may not alter trading behaviour.
Log each request and the resulting herobids version in
[docs/003-anomalies-and-deviations.md](./docs/003-anomalies-and-deviations.md).
Prefer a clean in-Traderton deletion when one exists; reserve source requests
for seams a deletion cannot cut without authoring non-trivial logic.

## Source system — READ-ONLY

`../herobids` relative to this repo — the `herobids` monorepo, where
trading currently lives fused with an agent + messaging platform.

**Work only in this repo (`.` / `../traderton` when viewed from the sibling
checkout). Treat
herobids as read-only source — read and copy from it, never modify it.** All
builds, tests, and git operations run in this repo.

## `main` branch discipline — do not break

**`main` holds ONLY production code that is a target state or a major milestone of
that state — something we keep for a while. NEVER indeterminate, temporary, or
scaffolding state.** Verification harnesses, intermediate/exploratory work, and
anything whose keep/discard disposition is still open do NOT belong on `main`;
they live on branches until they are decided.

**Never merge to `main` without the human's explicit approval.** "Reviewed +
green" is NOT license to merge — merge is the human's decision, not a step in any
loop. Keep work on a branch (branch-per-level / per-milestone) and ask.

**The merge gate — merge to `main` only when ALL of these hold:**
1. herobids consumes the traderton library;
2. all tests pass;
3. the setup has been run both locally and on staging for a while — manual,
   visual, and black-box tests;
4. manual approval is given to merge.

Keep durable production fixes SEPARATE from scaffolding so a keep-forever change
is never entangled with an undecided/temporary one in the same merge.
