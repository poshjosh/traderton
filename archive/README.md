# archive/ — historical documents (do NOT re-execute)

Everything under `archive/` is the **reasoning trail — how we got here** — not current truth.
These documents were the live plans/proposals/prompts during extraction (Phases 0–10) and the
Phase-9b authoring (M1 items A–E + F1–F2c). They are preserved for their reasoning and their
landing logs, and are **still authoritative as a record of what was decided and why at the time.**

**They are NOT the source of truth for what is true now.** For current state, target state, the
invariants, and the settled decisions, read **[docs/CANONICAL-STATE.md](../docs/CANONICAL-STATE.md)**.
For live capability status, [docs/001-parity-ledger.md](../docs/001-parity-ledger.md); for the *why*,
[docs/004-decision-log.md](../docs/004-decision-log.md).

**Do not re-execute the plans/prompts here** — the work they describe is done (or deliberately
skipped/superseded). If you need history (e.g. the F1–F2c landing logs), see
`archive/features/013-9b-authoring-plan.md` §7.5 + §8.5–§8.8.

## Contents

- **`002-phase-0-subtraction-plan.md`, `008-phase-1-scaffold-and-domain-slice.md`,
  `009-extraction-roadmap.md`** — the top-level extraction plan + roadmap (Phases 0–10, done).
- **`features/001-009*`** — the per-phase extraction plans (db, engine, market-data, venues,
  strategy, backtesting, worker, api) + the strategy-registry source-fix plan.
- **`features/010-012`** — the M1 holistic review (instruction, report, shared-infra decision).
- **`features/013-9b-authoring-plan.md`** — the Phase-9b authoring plan; **its §7.5 + §8.5–§8.8 are
  the F1–F2c landing logs.** `features/014-023` — the 9b per-item designs/prompts + the
  decision/event model + the continuity handoff.
- **`features/025, 028-033`** — the L1 harness proposal + the F (M2 REST) proposals & implementer
  prompts (F1/F2a/F2b/F2c).
- **On other branches (NOT here):** `027-L2-differential-proposal.md` (branch `l2-differential`);
  the L1 harness scaffolding (branch `l1-integration-harness`). Preserved on their branches per the
  merge gate / YAGNI, not on `main`/`f-m2-rest`.
