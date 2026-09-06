You are the coordinator for the Traderton extraction. Work in the `traderton` repo (`.`); `/Users/chinomso.ikwuagwu/dev_ai/herobids` is READ-ONLY source — read and copy from it, never modify it.

**Before doing anything**, read these in order, fully — they are the project's memory and you have no prior context:
1. `AGENTS.md` (the law: copy-never-author; source-fix rule; where-to-start pointer)
2. `docs/000-vision.md` (goal, settled decisions, and "The end state — herobids becomes a consumer of Traderton")
3. `docs/001-parity-ledger.md` (live status — the source of truth for what's done vs pending)
4. `docs/002` through `docs/008` (Phase 0/1 records, boundary contract, capability manifest, operational readiness)
5. `docs/009-extraction-roadmap.md` (your runbook: phase sequence, the per-phase pattern, stop-gates, and the living lessons)

**Current state:** Phase 1 (`@traderton/domain`) and Phase 2 (`@traderton/db`) are DONE and green. **Your task is Phase 3 (`@traderton/engine`) and beyond**, That is first Phase 3, then continue down the roadmap.

**How to execute each phase:** follow the per-phase pattern in 009 exactly — investigate → draft/finalize the phase plan in `docs/features/<NN>-<phase>-plan.md` → implement (copy-and-delete, build + copied tests green after every step, small commits) → review (per 009's review checklist) → test → update `docs/001` (and `003`/`004` if applicable) → mark the phase Done in 009 → seed the next phase's plan. A seed plan already exists at `docs/features/003-engine-plan.md`; finalize it against the real herobids code before implementing — do not trust the seed as final.

**Engine specifics:** it's a clean-package phase, domain-only (imports only `@traderton/domain`, all via ports). The **risk gate** (`packages/engine/src/risk-gate.ts`) is the highest-stakes parity surface — its exact rules and error codes must be copied verbatim and its parity tests must pass unmodified. Any risk-gate behavioural divergence is a stop-gate.

**Autonomy and stop-gates — this is the most important instruction:** run autonomously through the mechanical work (copy, delete, barrel-trim, test-prune, doc-update, commit). **STOP and ask the human only at the five stop-gates defined in 009:** (1) a seam that can't be cut by deletion without authoring non-trivial trading logic → source-fix request; (2) genuine ownership ambiguity; (3) a consequential behavioural divergence; (4) anything that would change the crux/shape/sequence or the copy-never-author law; (5) an irreducible parity gap. When you hit one, stop, write it up in the relevant doc, and wait — do not guess and do not author your way past it. Prefer an in-Traderton deletion over a source-fix; before escalating a fused-method edge, check its consumers across all of herobids (read-only, any phase) — if only platform code calls it, delete it. Apply the "herobids becomes a consumer" test from 000/004 when classifying: implementation may be Intentional Divergence while the capability is `Deferred (required for cutover)`.

**Definition of done per phase:** the package compiles under strict TS, lint clean, all copied tests green (note any gated/integration tests), forbidden-import sweep clean (no `@herobids/*`, no LLM, no platform imports), `docs/001` updated with evidence, phase marked Done in 009, next phase seeded, all committed.

Begin with Phase 3, then continue down the roadmap.