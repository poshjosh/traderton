# Backtesting — preserved knowledge (future Traderton capability)

Backtesting was a working capability in the source system (herobids, ported from
`aitradingbot`). It was **dropped** during the Traderton extraction as a deliberate scope
call — the product pivoted toward **agentic depth** (agent tools like `agent-browser`,
`browse_interactive`, and more planned) over trading breadth. Backtesting runs the live
trading engine, so it could not remain in the herobids platform process (legal-isolation),
and it was not worth a feature-sized extraction at this time.

This folder preserves the **reasoning, history, and technical surface** so a future
Traderton implementation can start from knowledge, not from zero. The code itself lives in
git history (see the provenance doc); what is expensive to lose is the *why* and the *shape*.

**Status:** Backtesting is DROPPED from the cutover consumer. Not scheduled. Rebuildable in
Traderton later using these docs.

## The three documents

- **[000-resurrection-brief.md](./000-resurrection-brief.md)** — Start here if you are
  rebuilding backtesting in Traderton. The strategic doc: what it is, why it was dropped, the
  constraints that shaped it, and what to do *differently* next time (the known holes to avoid
  inheriting).
- **[001-history-and-provenance.md](./001-history-and-provenance.md)** — Where it came from
  (aitradingbot → herobids), where it got to, and the provenance trail: key commits, source
  file paths, and herobids doc references. The "prove it and go read the real thing" doc.
- **[002-capability-reference.md](./002-capability-reference.md)** — The concrete surface so a
  rebuild is a port, not a reinvention: the 8→10 tool mapping, the 3 DB tables, the queue/
  runtime architecture, the package public API, the config block, the report shape.

## Related

- The decision that dropped it: `docs/features/L3-Q1-backtesting-disposition.md` (Option 2).
- The extraction law that forced the fork: `docs/CANONICAL-STATE.md` (legal-isolation, merge gate).
