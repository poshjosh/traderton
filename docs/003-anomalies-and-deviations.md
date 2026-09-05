# Anomalies & Deviations

**Status:** living
**Purpose:** log things discovered **during** copy-and-delete that force an
unplanned deviation from pure copy — genuinely broken source behaviour, or a
seam that cannot be preserved without authoring non-trivial logic.

## When to add an entry

Add an entry when, mid-extraction, you hit any of:

1. source behaviour that appears genuinely broken;
2. a seam that cannot be stubbed narrowly and would require authoring
   non-trivial logic to keep the build/tests green;
3. a copied test that cannot pass without a real (non-stub) change.

**Do not improvise a fix.** Stop, log it here, and surface it. A silent
authored fix is the exact failure mode this project exists to avoid.

## Not for this doc

- **Deliberate up-front design decisions** → [000-vision.md](./000-vision.md)
  decisions list + [001-parity-ledger.md](./001-parity-ledger.md) (Intentional
  divergence). Example: bots being mechanical-only is a planned decision, not an
  anomaly.

## Log

| Date | Where (file / seam) | What | Decision / status |
|------|---------------------|------|-------------------|
| 2026-09-05 | `packages/domain/src/config/schema.ts` (+ `config/index.ts`, `agent-protocol.ts`) | **The config schema is a fused monolith.** `config/schema.ts` is 2598 lines / 212 exported symbols — roughly 90 clearly-platform (billing, auth, plans, LLM runtime, alerts, telegram, gmail, browser-pool, services, platform-assessment) and ~54 trading-core (Risk*, Bot*, TokenSafety*, Strategy*, Execution*, Technical*, indicator params, venue/permission consts), interleaved line-by-line. Some single symbols fuse both concerns (e.g. `AGENT_STYLE_RUNTIME_DEFAULTS` mixes LLM token budgets with trading tick/risk defaults; `WakePreferencesSchema` pulls `AgentWakeSourceSchema` from the platform `agent-protocol.ts`, which in turn imports the deleted platform `tool-schemas.ts`). Under Option A (copy-whole-then-delete), reducing this file to trading-only requires **authoring extensive surgery inside a fused file** — not a leaf deletion. That is the exact silent-rewrite failure mode the method forbids, so per AGENTS.md / 000 / this doc I stopped rather than improvise. | **OPEN — awaiting direction.** Clean leaf deletions already done (all wholly-platform files/dirs/ports removed, build was green up to this point). Remaining coupling is 3 typecheck errors, all rooted in the fused config: (1) `agent-protocol.ts` → deleted `tool-schemas.js`; (2) `config/index.ts` re-exports deleted `models/llm-models.js` + platform schemas; (3) `config/load-providers.ts` → deleted `llm-models.js`. Options: **(A1)** author the trading-only reduction of `config/schema.ts` in place (authored surgery on a fused file — deviates from copy-and-delete); **(A2)** reconsider the verbatim within-file extraction previously proposed (Option B), now with concrete evidence it is the narrower/safer cut and possibly amend the law; **(A3)** keep the full `config/schema.ts` + `agent-protocol.ts` + `tool-schemas.ts` (copy the platform config verbatim into Traderton and defer its deletion to a later phase) — keeps build green now but imports platform/LLM-shaped config into a repo that decision 9 says must carry no LLM coupling. Recommend surfacing to the repo owner before proceeding. |
