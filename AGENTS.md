# AGENTS.md

Rules for AI agents working on **Traderton** — trading infrastructure for
AI/LLM agents (crypto now; forex, commodities, equities, and more later),
exposed over API now and MCP/skills later.

## Read first — tiered (the docs ARE the project's memory)

A fresh session knows nothing of the reasoning behind this project unless it reads
the docs. Read the **always-read** tier at session start; consult the rest **when the
topic is relevant** (pointers below). Every live doc still binds; the tiers only change
reading *order/cost*.

**Always-read at session start (small — the minimum to not do damage):**

1. **This file (AGENTS.md)** — the hard rules (below).
2. **[docs/CANONICAL-STATE.md](./docs/CANONICAL-STATE.md)** — **START HERE. The single source
   of truth for what is TRUE NOW**: current state, target state, the invariants (law), the
   open decisions, the settled-decisions index, and the pointer map to every live doc. When it
   and another doc disagree about state/decisions/invariants, the canonical brief wins. It tells
   you which docs to read for depth and which are historical.
3. **[docs/001-parity-ledger.md](./docs/001-parity-ledger.md)** — the live parity status +
   cutover gates. **The source of truth for capability done vs. pending.** Update it as you work.

Those three orient you. The canonical brief points you to the rest below **when relevant**:

**Consult when relevant (live; authoritative for their own scope):**

- **[docs/004-decision-log.md](./docs/004-decision-log.md)** — the *why* behind every decision.
  Read when a rule seems arbitrary or a case isn't covered.
- **[docs/000-vision.md](./docs/000-vision.md)** — the goal, the copy-never-author law, the 17
  settled decisions. *(Its "REST is the only cutover shape" framing is superseded by
  CANONICAL-STATE §3 — the first-consumption-path choice is OPEN.)*
- **[docs/003-anomalies-and-deviations.md](./docs/003-anomalies-and-deviations.md)** — forced
  deviations + source-fix request log. Read/append when you hit a deviation.
- **[docs/010-improvement-backlog.md](./docs/010-improvement-backlog.md)** — deliberate,
  non-blocking later-options (graded Value/Effort + Risk-if-deferred). NOT cutover obligations
  (those → 001/003) or bugs.
- **[docs/005-consumer-boundary-contract.md](./docs/005-consumer-boundary-contract.md)** — the
  M2 REST/HMAC contract. Read at consumption/cutover.
- **[docs/006-source-capability-manifest.md](./docs/006-source-capability-manifest.md)** — the
  static parity inventory the ledger scores against.
- **[docs/007-operational-readiness.md](./docs/007-operational-readiness.md)** — the cutover
  proof (latency/equivalence/restart/rollback). Read at L3/cutover.
- **[docs/024-verification-and-consumption-roadmap.md](./docs/024-verification-and-consumption-roadmap.md)**
  — the post-M1 level roadmap (L1 done, L2 skipped, F done, L3 next). *(Its "REST is the only
  cutover shape" is superseded by CANONICAL-STATE §3/§5.)*
- **[archive/](./archive/)** — **historical (do NOT re-execute):** the extraction roadmap + phase
  plans, the M1 review, the Phase-9b authoring plan + per-item proposals/prompts, and the F
  proposals/prompts. This is the *how-we-got-here* reasoning trail (incl. the F1–F2c landing logs
  in `archive/features/013-9b-authoring-plan.md` §8.5–§8.8). Consult for history; the canonical
  brief + the live docs are authoritative for what's true now.

Do not rely on prior chat context — assume you have none. If a decision isn't in these
docs, it does not exist yet: decide it deliberately and record it (in the canonical brief +
the relevant live doc).

## Where you are / where to start

**Read [docs/CANONICAL-STATE.md](./docs/CANONICAL-STATE.md) §2–§3 for the authoritative version.**
In brief (2026-09-08):

- **Extraction (M1 library) is complete**, and **Phase 9b authoring items A–E are complete on
  `main`.**
- **F — the M2 REST boundary — is COMPLETE on branch `f-m2-rest`** (F1+F2a+F2b+F2c), proven
  end-to-end (compose up + all 7 of 005's required-verification tests). **NOT merged to `main`**
  (merge gate unmet). L1 done (its fix cherry-picked to `main` as `f7a0dd1`); L2 skipped.
- **The next work is L3 — herobids consumes `@traderton/*` → cutover** (the merge-gate work),
  governed by [024](./docs/024-verification-and-consumption-roadmap.md).
- **Two OPEN decisions gate L3 (CANONICAL-STATE §6):** O1 — which consumption path herobids uses
  FIRST (REST vs in-process — NOT decided); O2 — who edits herobids and confirming the read-only
  exception below. Do not start herobids edits until these are settled with the human.
- Run the usual loop: investigate → propose → **pause for human** → self-contained implementer
  prompt → coordinator loop → update docs. Each level/item on its own branch. Nothing merges to
  `main` without the human (the merge gate).

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

**⚠️ A consumption-phase EXCEPTION is coming (NOT yet in force).** The next milestone (L3)
is herobids consuming `@traderton/*`, which inherently requires *editing* herobids (deleting
its trading code, wiring the library). The proposed exception (see
[docs/CANONICAL-STATE.md](./docs/CANONICAL-STATE.md) §5): the READ-ONLY rule is lifted **for a
designated herobids consumption branch only** — herobids `main` and all other branches stay
untouchable, and extraction-era copying still obeys copy-never-author. **This exception is
PENDING explicit human confirmation** (who edits herobids; which consumption path first —
CANONICAL-STATE §6 O1/O2). **Until the human confirms it, herobids remains fully READ-ONLY.**

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
