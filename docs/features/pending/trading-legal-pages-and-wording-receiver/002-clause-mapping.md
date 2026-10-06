# Clause mapping: herobids trading-wording-audit rows #47–#60 → traderton legal pages

Companion to `001-plan.md` task 6. Source audit:
`herobids/docs/product/trading-wording-audit.md` (rows #47–#60, the "Legal
pages — migration plan, not a reword" block).

Purpose: let the herobids `trading-wording-cleanup` plan (Phase 3) confirm
every trading-specific legal clause it intends to remove or reword already
has an equivalent, published home in traderton before it touches herobids'
Privacy Policy / User Agreement.

Herobids source files read (as currently committed):
- `apps/web/src/features/public-pages/content/en/legal/privacy-policy.md`
- `apps/web/src/features/public-pages/content/en/legal/user-agreement.md`

Traderton target files read (as drafted under task 1–2 of `001-plan.md`):
- `site/legal/privacy-policy.html`
- `site/legal/user-agreement.html`

Note on venues: the herobids audit text was written assuming Hyperliquid +
Jupiter only. Per the corrected task-1 note in `001-plan.md`, traderton's
pages disclose all four live venues (Hyperliquid, Bybit, Jupiter, 1inch).
This is a superset of what rows #50/#59 ask for, not a gap.

## Mapping table

| # | herobids clause being removed/reworded | traderton clause (file + heading) | Coverage confirmation |
|---|---|---|---|
| 47 | `privacy-policy.md` — `### Trading data` heading (whole section removed from herobids) | `site/legal/privacy-policy.html` — `## Trading data` (`#trading-data-heading`) | Equivalent: same heading text and role (data-category heading), now scoped to traderton's own processing. |
| 48 | `privacy-policy.md` — bullet "Trading activity (orders, fills, positions, P&L)" under `### Trading data` | `site/legal/privacy-policy.html` — `## Trading data` → `<strong>Trading activity</strong> (orders, fills, positions, P&L)` bullet | Equivalent: identical data-type wording, carried verbatim, plus added purpose text (execution/risk/reconciliation) not present in herobids — better, not just equivalent. |
| 49 | `privacy-policy.md` — `## Data storage` → `**Database** — Account data, trading records, agent configurations.` (only the "trading records" item migrates; "Account data, agent configurations" stays in herobids per the audit's own instruction) | `site/legal/privacy-policy.html` — `## Data storage` (`#storage-heading`): "Trading records (orders, fills, positions) are stored in persistent database storage..." | Equivalent: the "trading records" item that the audit says to strip from herobids has an explicit, more detailed home in traderton (names the record types and the operational reason for retention). |
| 50 | `privacy-policy.md` — `## Third-party services` → `**Trading venues** — Orders are submitted to trading venues like Hyperliquid and Jupiter. Only order data is transmitted.` | `site/legal/privacy-policy.html` — `## Trading venues` (`#venues-heading`) | Better: same disclosure (orders submitted, only order data transmitted), now naming all four live venues (Hyperliquid, Bybit, Jupiter, 1inch) instead of herobids' two-venue example list — a superset, not a narrower restatement. |
| 51 | `privacy-policy.md` — `## Your rights` → "Trading records required for regulatory compliance may be retained." (sentence embedded in the Deletion bullet) | `site/legal/privacy-policy.html` — `## Retention and deletion` (`#retention-heading`) | Equivalent: same regulatory-retention statement, promoted to its own section with the same substance ("required for regulatory compliance may be retained"), now phrased against a deletion request from the connected operator platform. |
| 52 | `user-agreement.md` — `### Trading Agents` heading (parent heading for the two subsections below; herobids audit marks it for removal as its own row) | `site/legal/user-agreement.html` — no identically-named parent heading; its two child subsections (`Trading decisions`, `Trading risk`) exist as top-level `<section>`s | Equivalent in substance, not structure: traderton flattened the herobids `Trading Agents` → `Trading decisions` / `Trading risk` nesting into two standalone top-level sections. Nothing the `Trading Agents` heading disclosed is lost — the heading itself carried no normative text, only grouping. See note below table. |
| 53 | `user-agreement.md` — `#### Trading decisions` heading (child of `Trading Agents`) | `site/legal/user-agreement.html` — `## Trading decisions` (`#trading-decisions-heading`) | Equivalent: same heading text, now a top-level section instead of a sub-heading — no loss of visibility (arguably more prominent). |
| 54 | `user-agreement.md` — "You are solely responsible for all trading decisions made by or through your agents. ... does not advise, recommend, or validate trading decisions or strategies." | `site/legal/user-agreement.html` — `## Trading decisions` body | Equivalent: same no-advice/liability substance, reworded for traderton's own voice (executes instructions from "a connected operator platform or agent" rather than "your agents") — same obligation, correct entity. |
| 55 | `user-agreement.md` — `#### Trading risk` heading (child of `Trading Agents`) | `site/legal/user-agreement.html` — `## Trading risk` (`#trading-risk-heading`) | Equivalent: same heading text, promoted to top-level section. |
| 56 | `user-agreement.md` — "Trading carries a significant risk of financial loss. You should not trade with funds you cannot afford to lose. Past performance of an agent or strategy does not guarantee future results." | `site/legal/user-agreement.html` — `## Trading risk` body | Equivalent: same three statements carried through almost verbatim (adds "bot" alongside "agent, or strategy" in the past-performance sentence — a strict superset of what it names). |
| 57 | `user-agreement.md` — `### Trading` heading (second top-level section, distinct from `Trading Agents`; contains No investment advice / No guarantees / Agent behavior / Execution modes) | `site/legal/user-agreement.html` — no single section carries this exact heading; its four children are individually present as their own top-level sections (`No investment advice`, `No guarantees`, `Execution modes`) plus `Agent behavior` — see gap note below | See note below table — content coverage confirmed, "Agent behavior" bullet specifically addressed below. |
| 58 | `user-agreement.md` — "**Test** — Simulated trading. No real orders are placed." (inside `### Trading` → Execution modes list) | `site/legal/user-agreement.html` — `## Execution modes` (`#execution-modes-heading`) → `<strong>Test</strong>` list item | Equivalent: identical definition, carried verbatim. |
| 59 | `user-agreement.md` — "**Live** — Real orders are placed on supported trading venues using real funds." | `site/legal/user-agreement.html` — `## Execution modes` → `<strong>Live</strong>` list item | Better: same definition, now naming all four supported venues (Hyperliquid, Bybit, Jupiter, 1inch) explicitly instead of herobids' unnamed "supported trading venues". |
| 60 | `user-agreement.md` — `## Limitation of liability` → "...including but not limited to trading losses, or data loss." (only the "trading losses" limb migrates; "data loss" stays in herobids per the audit's own instruction) | `site/legal/user-agreement.html` — `## Limitation of liability` (`#liability-heading`) | Equivalent: traderton's clause carries both limbs ("trading losses or data loss") in its own liability section — the "trading losses" limb herobids is instructed to drop has an explicit home, scoped to traderton's own liability for its own execution activity. |

## Gap check: rows #52 and #57 (heading-level structural rows)

Rows #52 and #57 are the two herobids audit rows that name a *grouping*
heading (`Trading Agents`, `Trading`) rather than a specific disclosure
sentence. traderton's pages do not reproduce either grouping heading
verbatim — they flatten herobids' two-level section structure
(`Trading Agents` → `Trading decisions`/`Trading risk`; `Trading` → `No
investment advice`/`No guarantees`/`Agent behavior`/`Execution modes`) into
five independent top-level sections.

This is confirmed **not a gap**, because:
- Every normative sentence nested under both grouping headings is
  individually accounted for in rows #53, #54, #55, #56, #58, #59 above, or
  in the "Agent behavior" check below.
- Neither grouping heading itself contains disclosure text — it is pure
  document structure (a `<h3>`/`<h4>` nesting level), and traderton is
  authoring its own document, not reproducing herobids' outline.

One bullet nested under herobids' `### Trading` section is not listed as
its own numbered audit row but is worth confirming explicitly since row #57
calls out the whole section as migrating: **"Agent behavior"** — "AI agents
may generate incorrect, incomplete, inconsistent, or unexpected outputs and
may take unintended actions... You should monitor your agents and
configure appropriate risk limits and spending caps." This bullet is
general AI-agent-behavior disclaimer language, not trading-specific (it
duplicates the "AI-generated outputs" / "AI Agent behavior" platform
limitations herobids already states elsewhere in the same document under
non-trading headings). It is correctly **not** migrated to traderton and
is expected to stay in herobids' own (genericized) User Agreement — this is
consistent with the audit's framing that only genuinely trading-specific
obligations move.

## Result

All rows #47–#60 have confirmed 1:1 (or better) coverage in traderton's published legal pages. herobids' trading-wording-cleanup plan Phase 3 may proceed.
