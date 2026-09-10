# 027 — L2 Differential Guarantee vs Pinned herobids Ref — Proposal

**Status:** PROPOSAL — for human review. No code written. On branch `l2-differential`.
**Level:** L2 of [024-verification-and-consumption-roadmap.md](../024-verification-and-consumption-roadmap.md)
(the differential "does-not-deviate" guarantee). Runs **before F** (or is skipped) — see 024 §Sequencing.
**Feeds:** 024 (L2 row); the "Side-effecting parity validated" cutover gate in [001](../001-parity-ledger.md).
**Grounding:** read-only investigation of the copied backtesting/validation machinery + the parity-test
substrate (2026-09-07). Governed by [AGENTS.md](../../AGENTS.md), [000](../000-vision.md),
[024](../024-verification-and-consumption-roadmap.md).

> **L2's claim:** same trading inputs → **identical trading outputs** from `@traderton/*` and from
> herobids-today. It is the differential guarantee that the copy-and-delete did not silently change trading
> behaviour — the deepest expression of "parity, not liveness" (000). L1 proved the library *runs*
> end-to-end; L2 proves it *produces the same answers as the source*.

---

## 1. What L2 is (and the honest scope boundary)

A harness that drives **recorded trading inputs** through `@traderton/*` and asserts the outputs match what
**herobids produced for the same inputs**, against a **pinned herobids commit SHA** (the frozen reference,
024 §"reference oracle"). Divergences either fail, or are explained + logged as sanctioned Intentional
Divergences (nothing silent).

**The investigation found the machinery for this is largely ALREADY COPIED** (good news), but it draws a
**scope line** you must see clearly (the honest part):

- **Copied + directly usable for a decision-layer differential:** `@traderton/backtesting`'s
  `replayContexts` + `normalizeForReplay` (`context-replay.ts`) replay **stored `decision_contexts` +
  `decisions` rows** (real recorded inputs + the intent/size herobids actually produced) through a
  Traderton `Strategy` and assert `replayedIntent/Size === originalIntent/Size`. That is a genuine
  traderton-vs-herobids differential **without running herobids live** — herobids' output is the *recorded*
  decision. And `runValidation` (`validation-runner.ts`) is the same shape for feed-driven strategy runs
  (per-frame decision diffing + P&L regression). Both have copied tests (`validation.test.ts`) = the shape
  oracle.
- **What that covers:** the **strategy / decision-making layer** (`strategy.evaluate` → intent/targetSize).
  This is a large, high-value surface — it's where mechanical strategy logic lives.
- **What it does NOT cover (the boundary):** the **execution engine** downstream of the decision — the risk
  gate, planner, executors, fill/position/equity accounting. `replayContexts` stops at the decision; it does
  not drive `submitDecisionForExecution`. So a pure context-replay differential guarantees *decisions*
  match, not that *execution outcomes* (plans/fills/positions) match. (Note: the risk gate already has 83
  byte-identical copied parity tests — `risk-gate.parity.test.ts` — so its parity is separately strong; but
  that is unit-parity, not a differential over recorded runs.)

**So L2 has two candidate depths** (§3) — a decision-layer differential (cheap, mostly-copied, real value)
and a full-execution-path differential (deeper, more setup). The right answer depends on how much guarantee
you want vs cost, and on the reference-capture question (§2), which is the real gating unknown.

## 2. The gating unknown — capturing the reference (your caveat, investigated)

L2 needs a **reference dataset**: recorded inputs + herobids' outputs for them. The investigation found
**no recorded corpora/decision-context fixtures exist in-repo** — so L2 must *produce* the reference. Three
ways, in increasing cost/fidelity:

- **(R1) Synthetic/deterministic corpus, both sides same code.** Because `context-replay.ts` /
  `validation-runner.ts` are **byte-copied** from herobids (diff = namespace only — verify), replaying the
  same corpus through the same (copied) strategy on both sides is *tautologically* equal — it proves the
  copy is faithful *as a copy*, not much more. **Weak** as a differential (it can only catch a copy that
  drifted). Cheapest; low value. Not recommended as the whole of L2.
- **(R2) Replay herobids-RECORDED decision contexts (the real differential).** Capture real
  `decision_contexts` + `decisions` rows **from the pinned herobids ref** (a herobids paper/shadow run, or
  an existing herobids test/seed dataset), then `replayContexts` them through Traderton and assert the
  Traderton decisions match herobids' recorded decisions. **This is the genuine guarantee** — the reference
  is herobids' *actual historical output*, captured once, frozen. **Cost/risk (the caveat):** we need a
  source of recorded herobids decision data. Options: (a) an existing herobids fixture/seed corpus (need to
  confirm one exists in the pinned ref — investigation did not find an obvious in-repo one on the traderton
  side; the herobids ref must be checked); (b) run herobids paper-mode against a recorded market corpus to
  generate it (more setup — a herobids-side run, which is READ-ONLY-safe since we only *read* its output,
  but it is real work and touches the herobids checkout to execute). **This is where L2's cost concentrates
  — and if (a)/(b) prove disproportionately hard, that finding is a legitimate reason to reconsider L2 vs
  skip-to-F** (024 allows skipping).
- **(R3) Full-path differential — record herobids execution outcomes, reproduce in Traderton.** Beyond
  decisions: capture herobids' plans/fills/positions for a recorded run and assert Traderton's engine
  reproduces them. Highest fidelity, highest cost (needs a deterministic execution corpus + paper-executor
  determinism on both sides). Likely more than L2 needs pre-F; a candidate for L3's boundary differential.

**Recommendation on depth+reference: (R2), decision-layer.** It is the real differential (herobids' actual
recorded outputs), it reuses the copied `replayContexts` machinery, and it targets the layer most likely to
harbour a silent copy divergence (strategy logic). The risk gate's parity is already covered by 83 copied
parity tests; the executors are exercised by L1's live paper run. R2 fills the genuine gap: *do Traderton's
strategy decisions match herobids' recorded decisions over real inputs?*

## 3. Proposed shape (under R2, decision-layer)

On the `l2-differential` branch (scaffolding — stays off `main` per the merge gate):
1. **Pin the herobids reference** — record a herobids commit SHA in this doc + 024 (the frozen oracle).
   Check it out via a `git worktree` for capture/side-by-side (read-only; never written).
2. **Capture the reference dataset** — the real work (§2 R2): obtain recorded `decision_contexts` +
   `decisions` from the pinned herobids ref (an existing herobids corpus if one exists, else a herobids
   paper-mode run over a fixed market corpus). Freeze it as a versioned fixture in the branch (JSON), with
   provenance (which SHA, how captured) recorded so it is reproducible.
3. **Author the differential harness** (the only authored surface — verification scaffolding): load the
   frozen reference, `normalizeForReplay` → `replayContexts` through the Traderton mechanical strategy with
   the recorded `strategyParams`, and assert `intentMatchPct === 100` / `sizeMatchPct === 100` (or list +
   explain every divergence as a logged Intentional Divergence — never silent). Reuse `replayContexts`
   verbatim; author only the load + assert + report.
4. **Gate + report** — a `test:differential` script (like `test:integration`) or a gated test; a
   differential report (matches / divergences + explanations). Green = "Traderton's strategy decisions do
   not deviate from herobids' recorded decisions over the reference corpus."

**What this guarantees / does not:** guarantees decision-layer parity over the captured corpus; does NOT
guarantee execution-path parity (risk/planner/executor/fills) beyond the existing copied parity tests +
L1's live paper run. If you want the execution-path differential too, that is R3 (bigger) — flag it (§5.3).

## 4. Copy-vs-author
- **COPY (reused verbatim):** `replayContexts`, `normalizeForReplay`/`normalizeForReplayBatch`,
  `runValidation` (if feed-driven scenarios are added) — the differential machinery, already in
  `@traderton/backtesting` with copied tests.
- **CAPTURED (reference data, read-only from the pinned herobids ref):** the frozen decision-context corpus
  + herobids' recorded decisions. Not authored — captured + frozen with provenance.
- **AUTHORED (verification scaffolding only — no trading behaviour):** the load+assert+report harness, the
  `test:differential` runner, the pin/worktree wiring. Same discipline as L1: authors no trading logic,
  stubs no `@traderton/*` internal; any divergence is a finding, not something to assert around.

## 5. Open decisions for your steer
1. **Depth:** (a) decision-layer differential via `replayContexts` (R2) [recommended — real, mostly-copied,
   targets the likely-silent-divergence layer]; (b) add the full execution-path differential (R3, bigger);
   or (c) skip L2 entirely and go to F (024 permits this).
2. **Reference capture (the cost driver):** does an existing herobids recorded-decision corpus/fixture exist
   in the pinned ref we can freeze [cheapest R2], or must we generate one via a herobids paper-mode run
   [more work; READ-ONLY-safe since we only read its output, but it executes in the herobids checkout]? **I
   need to look in the herobids ref to answer this — I did not fully investigate the herobids side yet;** if
   you approve L2, step 1 of implementation is confirming the corpus source, and if it's disproportionately
   hard, that is a sanctioned reason to fall back to skip-to-F.
3. **Which herobids SHA to pin** as the reference — the current herobids HEAD (`811973e8`, tag `v0.3.0` — the
   post-source-fix release we've been copying from), or a specific earlier one? Recommend `v0.3.0` (it is
   the state our copies correspond to).
4. **Branch/scaffolding disposition:** L2 harness + fixtures are scaffolding → stay on `l2-differential`,
   never merged to `main` (per the merge gate), same as L1. Confirm.

On your steer, this becomes the design record + a `028` implementer prompt — then implement → review → run
the differential → update 024/001. **Honest note:** L2's value hinges on decision 2 (a real herobids
reference to compare against). If no clean corpus source exists and generating one is heavy, the
disciplined call may be to **skip L2 and rely on F + L3's boundary differential** — I would surface that
rather than build a tautological R1 that only proves "the copy is a copy."
