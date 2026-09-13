# 008 — Decision Process (outsourced, near-automatable)

**Status:** living. **Purpose:** a repeatable, largely-automatable process for making
design decisions during the extraction/consumption work, with judgment OUTSOURCED to a
fresh decision agent (and the human ratifying the high-stakes ones). Adopted 2026-09-11
after a pattern of the implementing agent mis-weighting parity / the top objective on
judgment calls (repeatedly reaching for "drop it / defer it"). The countermeasure: the
implementer must NOT rank options; it produces a neutral, fact-grounded brief and hands
the decision off.

> **The behavioural rule for the implementing/coordinating agent:** on any choice that
> could **degrade parity, weaken the legal isolation, drop a feature, or change externally-
> visible behaviour**, do NOT decide and do NOT express a "lean." Produce the brief (§2)
> and route it (§3). Decide normally only the low-stakes mechanical choices (§4 trigger).

## 1. When this triggers (the checkpoint)

Run this process — do NOT decide unilaterally — when a choice hits ANY of:

- **Parity risk:** an option could drop, weaken, or change a feature herobids has today
  ("we may improve; we must not degrade").
- **Legal-isolation risk:** an option could leave/return trading behaviour in the herobids
  process, or move a platform concern behind the boundary.
- **Feature/behaviour change:** externally-visible behaviour, telemetry, or a contract
  changes (even subtly — e.g. a derived field now sourced differently).
- **Copy-vs-author tension:** the choice is between copying source behaviour and authoring
  a seam, and it is not obvious which the rules demand.
- **Cross-repo contract:** the choice adds/changes boundary surface (005) or a tool contract.

Low-stakes choices (a variable name, an internal helper split, test structure) do NOT
trigger this — decide them normally. The test is the four risks above, nothing smaller.

**Where the checkpoint lives operationally:** the per-slice loop is
investigate → **[decision checkpoint]** → propose → build → review → verify → docs → merge
gate. At the checkpoint, for every open choice, apply the trigger test; route the ones
that hit it; then continue. CANONICAL-STATE §9 points here.

## 2. The decision brief template (fill every section; keep facts, not conclusions)

Copy this per question. The implementer fills it; it must be neutral (no ranking, no lean).

```
### Decision brief: <short title>

1. Strategic objective (top)
   <verbatim: no trading logic runs in the herobids process; herobids is a pure REST consumer>

2. Current tactical objective
   <the slice this decision serves, one or two lines>

3. Rules (governing law)
   - Top rule (legal isolation) — <verbatim/pointer>
   - Copy, never author — <+ the precedence note: top rule wins when copying preserves a coupling>
   - Parity, not liveness — "we may improve; we must NOT degrade"; nothing silently dropped
   - main-branch / merge-gate — nothing merges to main without explicit human approval
   (pointer: traderton/docs/000-vision.md, CANONICAL-STATE §4, this doc)

4. Relevant prior decisions (SELECTIVE — only those that constrain/precede this one)
   - <decision + one-line summary + pointer>  (full log: traderton/docs/004-decision-log.md)

5. The question (NEUTRAL — no options implied, no lean)

6. Grounded code facts (verifiable, not paraphrased)
   - file:line — current behaviour
   - the tool/contract involved — its shape
   - what changes if re-pointed/altered

7. Candidate options — each with its consequence traced against the rules (§3). NOT ranked.
   - A. <option> → <consequence vs top rule / parity / copy-author>
   - B. ...
   - (invite the agent to derive a better option)

8. What I could NOT determine (state it; give the paths to check, don't assume)
```

## 3. How a brief is routed (the automatable flow)

1. **Implementer/coordinator** fills the §2 template from the code (facts, not conclusions).
2. **Decision agent** (a fresh reasoning agent — e.g. `Contemplator`) receives the brief with
   the explicit instruction: *decide, do not defer to the requester; rank the options against
   the rules; flag any rule that makes an option unacceptable; if a fact is missing, name the
   path to check rather than assume.* The agent may resolve codebase-answerable unknowns itself.
3. **Human ratifies** decisions that touched **parity or the legal isolation** (the highest-
   stakes classes). The decision agent may settle purely-mechanical or clearly-rule-forced
   choices without ratification, but must say which it settled and why.
4. **Record** the outcome: the DECISION + its reasoning into 004-decision-log.md (the why) and
   any parity impact into 001-parity-ledger.md (Gap/Deferred/Intentional-divergence). The brief
   is transient; the log/ledger are durable.

This flow is near-automatable: §2 is a fixed template; step 2 is a fixed agent invocation with a
fixed instruction; steps 3–4 are gates + doc appends. The only human input is ratifying the
parity/legal-touching decisions.

## 4. Worked example (the first run — score_candidate re-point, 2026-09-11)

- Brief filled per §2 (strategic + tactical + rules + Q2-P prior decision + scorecard-runner
  file:line facts + tool contract + options A/B/C, unranked).
- Decision agent (`Contemplator`) **corrected a false premise in the brief** (it found candles
  were an evidence-collection byproduct, not a scoring fetch) — demonstrating the value of a
  fresh, fact-grounded decider over the implementer's framing.
- Decision: **Option A** (full re-point; reconstruct `scanHealth` from the boundary result's
  `candlesEvaluated`; no traderton-side change; reject a herobids availability pre-check as
  re-introducing the coupling).
- Parity-touching → **human ratified** (scanHealth source changes to boundary candle count —
  accepted as an improvement / Intentional-divergence).
- Recorded: this doc + (pending) the ledger entries.

## 5. Why this exists (the honest reason)

The implementing agent demonstrated a repeated judgment weakness: under load it defaulted to
dropping/deferring features rather than honouring parity, and expressed "leans" that biased the
call. Removing its ranking authority on high-stakes choices — and grounding the decision in the
code + the rules via a fresh agent — is the structural fix. Keep it structural: the rule is not
"try harder," it is "on the four risks, brief-and-route, never self-rank."

## 6. Autonomy contract (adopted 2026-09-11)

The implementing/coordinating agent operates autonomously up to the merge gate. The decision
process (§1–§4) is what makes this safe: high-stakes judgment is routed to a fresh decision
agent, not carried by the implementer. This section defines the boundary precisely.

### 6.1 The ONE hard stop
**Merging to either repo's `main`.** Nothing merges to `main` without explicit human approval —
this is the legal cutover gate and is non-negotiable. It is the only mandatory stop.

### 6.2 Proceed without asking (the default)
Everything up to the gate runs continuously, across as many slices as the task spans, without
pausing between them:
- investigate → decision checkpoint (route the four-risk choices per §1–§4) → implement both
  sides → verify end-to-end (incl. the local docker boundary) → self-review + re-run
  build/lint/test → commit to a branch → update the durable docs.
- Work on branches. Branch commits are reversible; that is the safety net.
- Make the minor/medium calls directly. Re-check from a couple of angles before committing to
  a direction, but do not stop to ask.

### 6.3 Route to the decision agent (do not self-rank)
Any choice hitting the four risks (§1: parity / legal-isolation / feature-drop / behaviour-or-
contract change). The decision agent's ruling is **authoritative and the agent proceeds on it
immediately** — it is NOT a stop. Parity/legal-touching rulings are marked *pending human
ratification* in the journal (§6.5) and the agent keeps going; the human reviews the batch
after the fact and vetoes if needed (a veto is cheap — the work is on a branch).

### 6.4 Surface to the human (rare, soft)
Only when: the merge gate is reached; OR the decision agent itself says a choice cannot be
grounded in the rules and needs a product/policy call (genuinely the human's, e.g. "should this
limit exist at all"); OR a blocker is hit that cannot be resolved on a branch. Surfacing is a
note in the journal + a heads-up, not a halt to all other work.

### 6.5 The autonomy journal
A running, auditable trail so the human reviews after the fact instead of watching live. Record,
per slice: decisions made directly, decision-agent rulings (+ which are pending ratification),
what was built, what was verified (with counts), commits (SHAs/branches), and any surfaced item.
Home: the parity ledger's slice entries + the decision log — the same durable docs, so the
journal is not a separate artifact to maintain. The "ratify-list" is just the pending-ratification
rulings collected for one review pass.

### 6.6 Tone note
The governing docs describe the loop with an autonomous default (proceed to the branch, record
the trail) rather than "pause and ask at each step." The historical investigate→propose→**pause**
framing is superseded by this contract; the merge gate remains the hard stop.


## 7. Decide-by-default; escalate only on a rule/decision/objective conflict (adopted 2026-09-12)

The default is: **the coordinating/implementing agent decides.** Escalation to the human is
the exception, and it must be *justified* — not a reflex.

**Only escalate when the choice would:**
1. **violate a rule** (e.g. "no new features during migration"; copy-never-author; main-branch/merge-gate; read-only source outside the `consume-traderton` branch), OR
2. **contradict a recorded decision** (004-decision-log / 001-ledger / CANONICAL-STATE), OR
3. **undermine a strategic objective** (e.g. legal isolation — no trading/market-data in the herobids agent process), OR
4. be a **four-risk** choice per §1 (parity / legal-isolation / feature-drop / behaviour-or-contract) that is not already settled — which routes to the DECISION AGENT (§3), not the human, unless the decision agent itself says it needs a genuine product/policy call.

**If none of the above is at stake, DO NOT ask — decide and proceed.** Offering the human an
"option" for a call the agent is equipped to make is a failure mode (it offloads work and slows
autonomy). Verification runs, local env/infra wiring, test-harness fixes, and reversible
branch work are decide-and-proceed by default.

**When the agent genuinely cannot decide, it must say WHY in these exact terms** — name the
rule violated, the decision contradicted, or the objective undermined (or the unsettled
four-risk). "I'm not sure" is not a reason; "this would author trading logic in herobids,
violating copy-never-author" is. Absent such a reason, the agent has no grounds to escalate.

This tightens §6 (autonomy contract): §6 said proceed to the branch; §7 says the *decision to
proceed* is also the agent's by default, gated only by the four conflicts above.


## 8. Continuous slice execution to the merge gate (adopted 2026-09-12)

The human authorized running the loop CONTINUOUSLY across slices — no "shall I proceed?"
between them — stopping ONLY at the enumerated hard stops below. This section makes that
durable (survives context compaction) and keeps the safeguards intact.

### 8.1 The driver loop
Maintain a sequenced **pre-merge backlog** (docs/010-improvement-backlog.md holds later-options;
the CUTOVER-blocking backlog lives in 001's Deferred-required rows + a working checklist). Run:

  pick next UNBLOCKED backlog item → investigate → **decision checkpoint (route four-risk via §3)**
  → implement (both repo sides) → CodeReviewer → verify with REAL build/lint/test (+ boundary e2e
  where behaviour warrants) → commit focused → update durable docs/journal → **immediately pick the
  next unblocked item and begin it.**

The final step of every slice is "select + start the next slice." That IS the continuity
mechanism — the loop does not return to the human between slices. Do not ask "want me to take the
next one?" — take it.

### 8.2 The ONLY hard stops (enumerated — not discretionary)
Halt and hand back to the human ONLY when one of these is hit:
1. **Merge to `main`** (008 §6.1) — the mandated cutover gate. Stop with a merge-ready handback.
2. **A four-risk choice the DECISION AGENT escalates as a genuine product/policy call** (§6.4) —
   like the A/B/C calls. Route every four-risk choice to the decision agent AUTONOMOUSLY; stop for
   the human ONLY if the agent itself says it needs the human's judgment. Four-risk choices the
   agent can settle do NOT stop the loop (proceed, mark pending-ratification).
3. **A blocker unresolvable on a branch** — a missing external dependency / credential / access the
   loop cannot obtain. State it precisely and stop.
4. **Backlog exhausted** — no unblocked cutover-blocking work remains before the merge gate.

Nothing else stops the loop. Routing to the decision agent, recording pending-ratification rulings,
fixing review findings, standing up local infra, and re-running tests are all in-loop.

### 8.3 The safeguards do NOT relax between slices
Continuous cadence speeds the gaps BETWEEN slices; it never lowers the bar WITHIN one. Every slice
still: routes its four-risk choices through §3; gets a CodeReviewer pass; verifies with real
build/lint/test (not trusted-green); and records parity/legal-touching rulings as **pending human
ratification** in the ledger. (Rationale: unsupervised momentum is exactly when the implementer's
judgment has slipped before — the structural safeguards are what make continuous autonomy safe.)

### 8.4 The audit trail (review-after-the-fact, not live)
Keep the running autonomy journal (§6.5) in 001 + 004 so the human reviews the BATCH after the fact:
per slice — decisions made + agent rulings (which are pending ratification), what was built, what was
verified (with counts), commit SHAs/branches, and any surfaced item. The human vetoes cheaply (branch
work). At a hard stop, present the collected pending-ratification list + the state reached.
