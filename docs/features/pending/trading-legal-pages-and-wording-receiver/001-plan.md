# Plan: Author traderton's Privacy Policy & User Agreement (receiver for herobids trading-wording removal)

Status: done — all 6 tasks implemented, reviewed, and verified (unit + integration + boundary E2E + extra tests + site-isolation.sh + manual visual check all passing). See `002-clause-mapping.md` for the row-by-row coverage record.
Owner: (unassigned)
Repo of record: `traderton`
Companion plan: `herobids/docs/features/pending/trading-wording-cleanup/001-plan.md` (depends on this plan landing first)
Source audit: `herobids/docs/product/trading-wording-audit.md` (§ legal migration note, rows #47–#60)

## Why this plan runs first

The herobids audit calls for moving trading-specific legal clauses (data
categories, venue disclosures, trading-risk/liability, test-vs-live order
wording) out of herobids' Privacy Policy and User Agreement and into
traderton, which owns the trading product. herobids cannot safely strip those
clauses until an equivalent, published clause exists on the traderton side —
otherwise a legally required disclosure would be lost mid-migration.

This plan creates that traderton-side reference first. The herobids plan then
treats this plan's output as the thing it is migrating *to*, and verifies the
clause-for-clause mapping before deleting anything.

## Current state (verified)

- traderton has no legal pages today. `site/` contains only `index.html`,
  `docs/index.html`, and `status.html` (plain static HTML, no build
  toolchain — see `site/README.md`). There is no `/legal` route and no
  Privacy Policy / User Agreement content anywhere in the repo.
- The site is baked into a `caddy:2-alpine` image via `Dockerfile.site`
  (`COPY site/ /srv/`) and served at `staging.traderton.com` through the edge
  Caddy (`infra/hetzner/Caddyfile.staging`), which 404s `/internal*` and
  `/health*` but otherwise passes everything in `site/` through.
- `infra/hetzner/tests/site-isolation.sh` asserts specific routes return 200
  (`/`, `/docs/`, `/status.html`) and specific routes return 404
  (`/health`, `/health/ready`, `/internal`, `/internal/v1/tools:invoke`). New
  routes must be added to the 200-list; the guard does not need touching
  otherwise since it allow-lists by exact path, not by directory.
- herobids' current clauses to mirror (read in full from
  `herobids/apps/web/src/features/public-pages/content/en/legal/privacy-policy.md`
  and `.../user-agreement.md`):
  - Privacy Policy: "Trading data" heading + "Trading activity (orders,
    fills, positions, P&L)" bullet; "trading records" item inside the
    Database storage bullet; "Trading venues" third-party-services bullet
    (Hyperliquid, Jupiter); "Trading records required for regulatory
    compliance may be retained" in the deletion-rights bullet.
  - User Agreement: "Trading Agents" section with "Trading decisions"
    (no-advice/liability) and "Trading risk" (financial-loss disclaimer)
    subsections; "Trading" section with "No investment advice", "No
    guarantees", "Agent behavior", and the Test/Live execution-mode
    definitions; the "trading losses" limb of the limitation-of-liability
    clause.

## Objective

Add a `/legal/privacy-policy` and `/legal/user-agreement` static page to
`site/` (or `site/legal/` subpath) carrying the trading-specific legal
language that will no longer live in herobids, written to stand on its own
as traderton's own policy (not a copy-paste of herobids' wrapper — herobids
is the agent-platform operator; traderton is the trading-infrastructure
provider it uses, so the voice/entity references must be accurate to
traderton, not "OpenAIdom").

## Tasks

1. [DONE] **Draft `site/legal/privacy-policy.html`** containing, at minimum:
   - What trading data traderton processes on behalf of the operator
     platform (orders, fills, positions, P&L) and why.
   - Trading venue disclosures (Hyperliquid, Jupiter, and any other venues
     `packages/venues` integrates).
   - Regulatory retention statement for trading records.
   - Keep this page scoped to what traderton itself does (receives signed
     tool invocations, executes/reconciles against venues, stores
     positions/fills) — do not restate herobids' account/auth/LLM data
     handling, that is out of scope for traderton's own policy.

   > Note: the venue disclosure above was drafted assuming Hyperliquid +
   > Jupiter only. The implementation checked `packages/venues/src/index.ts`
   > and found four live venues — Hyperliquid, Bybit, Jupiter, and 1inch —
   > so both legal pages correctly disclose all four. The herobids
   > companion plan's clause-mapping (task 6) should start from this
   > corrected four-venue list, not the originally-assumed two.
2. [DONE] **Draft `site/legal/user-agreement.html`** containing, at minimum:
   - A "Trading decisions" clause: the end user/operator is solely
     responsible for trading decisions; traderton does not advise,
     recommend, or validate trading decisions or strategies.
   - A "Trading risk" clause: trading carries risk of financial loss; do not
     trade with funds you cannot afford to lose; past performance does not
     guarantee future results.
   - "No investment advice" / "No guarantees" clauses.
   - Execution-mode definitions: **Test** (simulated, no real orders) vs
     **Live** (real orders on supported venues using real funds).
   - A limitation-of-liability clause covering trading losses.
3. [DONE] **Wire navigation**: add Privacy Policy / User Agreement links to
   `site/index.html` footer and `site/docs/index.html` nav, matching the
   existing nav/footer markup pattern already used by `status.html`.

   > Note: landed as footer-only links on every page (including the two new
   > legal pages and a new `site/legal/index.html`), not nav entries — this
   > keeps the primary nav identical (Docs/Status) across all pages per
   > review feedback, rather than diverging `docs/index.html`'s nav from
   > `index.html`/`status.html`.
4. [DONE] **Extend `site/Caddyfile.local` / `site/Caddyfile.image`** only if the new
   pages need routing beyond plain static file serving — verify first,
   since `file_server browse` already serves any file under `/srv` by path;
   likely no Caddyfile change is needed, just confirm.

   > Note: no Caddyfile change needed, confirmed. Added `site/legal/index.html`
   > instead so `file_server browse` doesn't expose a raw directory listing at
   > `/legal/`.
5. [DONE] **Update `infra/hetzner/tests/site-isolation.sh`**: add
   `assert "/legal/privacy-policy" 200` and
   `assert "/legal/user-agreement" 200` (mirroring the existing `assert`
   calls for `/`, `/docs/`, `/status.html`) to both the offline route-shape
   check and the live-stack check.

   > Note: landed as `assert "/legal/privacy-policy.html" 200` and
   > `assert "/legal/user-agreement.html" 200` in the LIVE section only.
   > Correction to this task's own wording: there is no "offline
   > route-shape check" in this script to extend — the OFFLINE section
   > only greps Caddyfile directives (guard presence, no-boundary-proxy),
   > it contains no path-based route assertions at all. The `assert()`
   > helper and all 200/404 route checks live exclusively in the LIVE
   > section, which is where both new asserts were added, confirmed
   > passing against the local compose stack
   > (`docker compose -f infra/hetzner/compose.site-local.yaml up -d`).
6. [DONE] **Record the clause mapping** in this plan's companion note (or a short
   `002-clause-mapping.md` in this same directory) listing herobids audit
   row numbers (#47–#60) against the corresponding traderton clause, so the
   herobids plan can verify 1:1 coverage before deleting anything.

   > Note: landed as `002-clause-mapping.md`. All 14 rows (#47–#60) confirmed
   > with 1:1 or better coverage; rows #52/#57 (grouping headings, not
   > disclosure text) are flagged as a structural-not-substantive difference
   > and explained, not treated as gaps. herobids Phase 3 may proceed.

## Non-goals

- No change to `infra/hetzner/compose.yaml`, `Dockerfile.site`, DNS, or TLS —
  this is content only, served through the already-published `site` image
  path (T4.2 is already live per
  `docs/features/2026/10/01/001-minimal-public-site/002-publish-prep.md`).
- No change to any backend package (`domain`, `engine`, `venues`, `db`) —
  this is static site content.
- No translation — traderton's site is English-only today; no `ar`/`hi`
  requirement here (unlike herobids' content pages).

## Verification

- `scripts/shell/tests/run-all-tests.sh --e2e` (unit + integration + boundary
  E2E — unaffected by this change, but run to confirm no regression).
- `scripts/shell/tests/run-extra-tests.sh --all`.
- `bash infra/hetzner/tests/site-isolation.sh` locally against
  `docker compose -f infra/hetzner/compose.site-local.yaml up -d`, confirming
  the two new routes return 200 and the existing guard routes still 404.
- Manual visual check of both new pages (desktop + mobile viewport) — no
  dedicated browser automation exists for the static site, so this is a
  manual pass, same as the rest of `site/`.
- Confirm `pnpm lint` / `pnpm build` stay green (the site is intentionally
  outside the pnpm workspace per `site/README.md`, so this should be a
  no-op, but verify nothing broke).

## Exit criteria

- Both pages exist, render locally, pass the extended `site-isolation.sh`.
- The clause-mapping record exists and covers every herobids audit row
  #47–#60.
- herobids' trading-wording-cleanup plan can point to a published clause for
  each legal item it intends to remove.

## Outstanding Issues

From final code review (no CRITICAL/HIGH items remain open — the two HIGH
findings, the task-5 note accuracy and the missing CHANGELOG entry, were
fixed directly: see the task-5 note above and the `[Unreleased]` entry in
`CHANGELOG.md`):

- **[Item 6 — clause mapping]** The row #52/#57 "not a gap" judgment (grouping
  headings carry no normative text, so flattening them into standalone
  sections loses nothing) is a single-author call in `002-clause-mapping.md`.
  Reasoning is sound and documented inline, but since herobids' Phase 3 plan
  acts on this document to decide what legal text to delete, a second pass
  (ideally from whoever implements the herobids side) re-checking rows #52
  and #57 specifically is worth doing before Phase 3 content is deleted.
- **[site/README.md]** Discoverability of the legal pages is footer-only (no
  primary-nav entry) across every site page, per the reviewed task-3
  decision to keep nav identical everywhere. Intentional, not a defect, but
  noted here in case product wants a nav entry later.
