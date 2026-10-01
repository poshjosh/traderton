# T4.1 — Minimal public site for `staging.traderton.com` (LOCAL only)

**Status:** plan (ready to implement). **Created:** 2026-10-01.
**Program:** herobids Phase 2 — Step 7 / `T4.1`
(`herobids/docs/features/2026/10/004-phase2-program/{ENTRYPOINT,TASKS}.md`).
**Repo of record for this work:** `traderton` (`~/dev_ai/traderton`), authored to
traderton conventions (ENTRYPOINT §3.6). **No push, no merge to `main`** (invariant §4.4;
CANONICAL-STATE §4).

> This plan is implementation-only. It does NOT publish. DNS, TLS/cert issuance, the VM
> deploy, and any edit to the on-host deploy flow (`scripts/deploy.sh` `RUNTIME_FILES`,
> `deploy-on-host.sh` compose service list) are **T4.2 — a §5.1 infrastructure HARD STOP**.
> See §8 for exactly what is carved out and merely *documented* here.

---

## 1. Objective & exit criteria

Author the **minimal, static** public site content for `staging.traderton.com`:

1. **Product identity / landing** — "Traderton — trading infrastructure for AI agents."
2. **Docs / venue guides** — surface (render or link) the already-canonical reference docs
   in `docs/reference/*` (venues, crypto ecosystem, trading glossary). **Do NOT re-author
   venue/trading content** — those docs are canonical (Step 6 / T3.2). Copy-never-author
   (CANONICAL-STATE §4.1) is about *trading behaviour*, not site chrome/wording — so the
   landing/status *copy* may be authored freely, but the venue/ecosystem/glossary *bodies*
   must be surfaced, not rewritten.
3. **Service-status page** — a static, human-facing status page. **No live boundary probe**
   (that would reach the execution surface — forbidden).

**NO trading dashboard. NO exposure of the execution boundary.** The site builds and serves
**LOCALLY only**.

**Exit criteria (from TASKS T4.1):**
- Site builds and serves locally; content present.
- No route reaches the execution boundary — an automated assertion mirrors the staging Caddy
  guard: the public vhost returns 404 on `/health*` and `/internal*` and never proxies to
  `boundary`.
- `pnpm lint` + `pnpm build` still green (adding the site must not break the workspace).
- VisualTester has eyeballed the pages locally.

---

## 2. Established facts (verified against the repo)

- **No frontend/web package exists.** `packages/*` = `{backtesting, boundary, db, domain,
  engine, market-data, strategy, venues, worker}` — all backend. `pnpm-workspace.yaml`
  globs `packages/*` + `scripts` only.
- **Canonical reference docs are present** at `docs/reference/`:
  `crypto-ecosystem.md`, `crypto-ecosystem-aspects.md`, `trading-glossary.md`, `README.md`,
  and `trading-venues/{index,hyperliquid,bybit,jupiter,1inch,funding-wallets}.md`.
- **`infra/hetzner/Caddyfile.staging` already defines the serving contract:**
  - `api.staging.traderton.com` → `reverse_proxy boundary:8080` (execution surface, HMAC).
  - `staging.traderton.com` → `reverse_proxy site:80`, with guard
    `@execution path /internal /internal/* /health /health/*` → `respond @execution 404`.
- **`infra/hetzner/compose.yaml` has services `{postgres, redis, migrate, boundary, caddy}`
  — NO `site` service**, even though the Caddyfile already references `site:80`. T4.1 must
  introduce a `site` that satisfies that reference, runnable locally.
- **`Dockerfile` builds the boundary image only.**
- **Publish surface (the T4.2 boundary):** `infra/hetzner/scripts/deploy.sh` `RUNTIME_FILES`
  (explicit upload allow-list) and `infra/hetzner/deploy-on-host.sh`
  (`docker compose … up -d postgres redis boundary caddy`). Neither mentions `site`.
  Touching either to actually ship the site = T4.2.
- **Existing guard-test style:** `infra/hetzner/tests/offline-guards.sh` — a `bash -euo
  pipefail` script that `grep`s the Caddyfile and validates compose via
  `docker compose config … | jq -e`. `infra/hetzner/tests/*.py` cover firewall/backup. New
  isolation tests should match this style and live under `infra/hetzner/tests/`.

---

## 3. Key decisions (with justification)

### D1 — Tech: plain static HTML, served by a stock image. **No build toolchain, no deps.**
AGENTS.md: "Do not add dependencies without justification." A 3-page static site needs no
framework, no bundler, no new workspace package. Hand-authored static `.html` + a tiny bit of
CSS is the simplest thing that fits (KISS). This also keeps the site **out of `pnpm -r`**
(the workspace globs `packages/*` + `scripts` only), so it cannot break `pnpm lint` /
`pnpm build`.

### D2 — Content lives in a top-level `site/` dir.
`site/` (sibling to `packages/`, `infra/`, `docs/`). It is a static asset tree, not a
workspace package — no `package.json`, so pnpm ignores it. Serving is done by mounting
`site/` into a stock `caddy:2-alpine` (or `nginx:alpine`) container.
**Recommendation: reuse `caddy:2-alpine`** — it is already the image used by the `caddy`
service, keeps the image set small, and a one-line `file_server` Caddyfile is trivial.

### D3 — How docs/venue guides are surfaced. **Decision: render Markdown to static HTML at
author time is overkill for T4.1; instead the docs section LINKS to / embeds the canonical
`docs/reference/*` content.**
Two sub-options were considered:
- (a) **Copy-free include**: the site's docs pages are thin HTML wrappers that link to the
  reference docs. Simplest; zero duplication; zero drift risk.
- (b) **Pre-render** `docs/reference/*.md` → HTML into `site/` via a script.
**Recommendation: (a) for T4.1.** It satisfies "surface the docs" with no toolchain, no
duplication, and no re-authoring. A later task may pre-render if the public site needs the
venue bodies inline. **If (b) is ever chosen, it is architecturally significant** (introduces
a Markdown build step + a dependency) → route to a Contemplator first. For T4.1, (a) stands.
  - Mechanic for (a): `site/` is mounted alongside a read-only mount of `docs/reference/` so
    the links resolve locally, **or** the docs pages carry short authored summaries + a link
    to the canonical file. Prefer authored summary + link to keep `site/` self-contained and
    avoid coupling the web root to the repo's `docs/` tree. Final choice is a LOW-stakes
    mechanical call for the implementer; default = authored summary + link to the canonical
    `docs/reference/...` path.

### D4 — Local serving + the `site` service. **Decision: a SEPARATE local compose override;
do NOT edit the staging `compose.yaml` to add `site` as part of T4.1.**
The staging `compose.yaml` is on the deploy path (`deploy.sh` uploads it; `deploy-on-host.sh`
runs it). Adding a `site` service there, wired to the real Caddy, blurs into the publish
step. The Caddyfile already *expects* `site:80`; actually **wiring + shipping that service is
T4.2**. For T4.1 (local, reversible):
- Add `infra/hetzner/compose.site-local.yaml` (a local-only override/standalone compose) that
  defines the `site` service (stock caddy serving `../../site`) and a local `caddy` using the
  **same `Caddyfile.staging`** so the guard is exercised verbatim.
- Run locally with `docker compose -f compose.site-local.yaml up` (documented in the plan /
  a README snippet under `site/`).
- **Explicitly mark** in that file's header comment that adding `site` to the *staging*
  `compose.yaml` + `deploy.sh RUNTIME_FILES` is the **T4.2 hard-stop boundary**.
This keeps the staging deploy path untouched while proving the exact Caddy guard locally.
**Flag:** the "where does `site` live in staging compose" question is architecturally
significant for T4.2 — it is prepared as documentation in §8, not executed here.

### D5 — Env `.example` twin rule. A static site needs **no env vars** → **no `.env` twin
required.** If implementation surfaces any (it should not), add its `.example` twin in the
same change per AGENTS.md.

---

## 4. Staged implementation (each stage: goal · files · commands · exit check)

### Stage 0 — Preconditions (read-only)
- **Goal:** confirm clean tree + context before authoring into traderton.
- **Commands:**
  - `git -C ~/dev_ai/traderton status --porcelain` (must be empty).
  - Confirm `docs/reference/` contents exist (they do — see §2).
- **Exit:** clean working tree on `main`; reference docs present.

### Stage 1 — Author the static site content
- **Goal:** the three content areas as minimal static HTML.
- **Files (new, under `site/`):**
  - `site/index.html` — landing: "Traderton — trading infrastructure for AI agents",
    one-paragraph identity, nav to Docs + Status. (Authored copy — allowed.)
  - `site/docs/index.html` — docs hub: links to venue guides, crypto ecosystem, glossary.
    Each entry = short authored summary + link to the canonical `docs/reference/...` doc
    (D3(a)). **Do not paste venue/ecosystem/glossary bodies verbatim re-authored.**
  - `site/status.html` — static service-status page (human-facing, no live boundary probe;
    a plain "components / last-reviewed" static table). Authored copy — allowed.
  - `site/assets/style.css` — minimal shared stylesheet (accessible: semantic HTML, color
    contrast, `lang` attr, meaningful `<title>`/headings).
  - `site/README.md` — what `site/` is, how to run it locally, and the T4.2 carve-out
    pointer (§8).
- **Exit:** files exist; HTML is valid, accessible (semantic landmarks, alt text, contrast),
  internal nav links resolve.

### Stage 2 — Local serving + `site` service (local-only compose)
- **Goal:** `staging.traderton.com` resolves to the static site **locally**, through the real
  `Caddyfile.staging` guard.
- **Files (new):**
  - `infra/hetzner/compose.site-local.yaml` — local-only compose defining:
    - `site` (image `caddy:2-alpine`) serving `../../site` on container port 80 via a tiny
      inline `file_server` config (or a committed `site/Caddyfile.local`).
    - `caddy` reusing `./Caddyfile.staging` with ports `80:80` (443 optional/omitted locally;
      no TLS needed to exercise the path guard over HTTP).
    - **Header comment:** "LOCAL ONLY. The staging `compose.yaml` + `deploy.sh RUNTIME_FILES`
      must gain `site` only in T4.2 (publish = §5.1 hard stop)."
  - Optional: `site/Caddyfile.local` — `:80 { root * /srv; file_server }` for the `site`
    container.
- **Commands:**
  - `docker compose -f infra/hetzner/compose.site-local.yaml up -d`
  - `curl -s -H 'Host: staging.traderton.com' http://localhost/` → 200, landing HTML.
- **Exit:** local Caddy serves the landing page for `Host: staging.traderton.com`.
- **Note:** this stage does NOT touch `compose.yaml`, `deploy.sh`, or `deploy-on-host.sh`.

### Stage 3 — Execution-boundary isolation assertion (the exit-criteria test)
- **Goal:** an automated test proving the public vhost blocks `/health*` and `/internal*`
  and never proxies to the boundary — mirroring the Caddy guard.
- **Files (new), matching the existing `tests/` style:**
  - `infra/hetzner/tests/site-isolation.sh` — `bash -euo pipefail`, two layers:
    1. **Static Caddyfile asserts (offline, like `offline-guards.sh`):**
       `grep -Fq '@execution path /internal /internal/* /health /health/*' Caddyfile.staging`,
       `grep -Fq 'respond @execution 404' Caddyfile.staging`,
       `grep -Fq 'reverse_proxy site:80' Caddyfile.staging`, and assert the public
       `staging.traderton.com` block contains **no** `reverse_proxy boundary` line.
    2. **Live local asserts (against the Stage-2 stack, when up):**
       `curl -s -o /dev/null -w '%{http_code}' -H 'Host: staging.traderton.com'
       http://localhost/health` → `404`; same for `/health/ready`, `/internal`,
       `/internal/x`; `GET /` → `200`. Guard the live portion behind a reachability check so
       the offline asserts always run in CI even without Docker.
  - Optionally extend `offline-guards.sh` with the "public vhost has no `boundary` proxy"
    static assert so it runs in the existing offline guard suite too.
- **Commands:** `bash infra/hetzner/tests/site-isolation.sh`
- **Exit:** script exits 0; 404 on `/health*` and `/internal*`, 200 on `/`, no boundary proxy
  in the public vhost.

### Stage 4 — Workspace verification (must stay green)
- **Goal:** adding the static site breaks nothing.
- **Commands (from repo root):**
  - `pnpm lint` (`tsc --noEmit`) — must pass.
  - `pnpm build` (`pnpm -r run build`) — must pass. (`site/` is not a workspace package, so
    it is not built; confirm it is NOT accidentally added to `pnpm-workspace.yaml`.)
- **Exit:** both green.

### Stage 5 — Visual verification (local)
- **Goal:** eyeball the pages.
- **Agent:** VisualTester against the Stage-2 local stack (or `site/` opened directly / via
  the `site` container). Check: landing identity renders; docs hub links resolve to the
  reference docs; status page renders; nav works; no trading dashboard; no console errors.
- **Exit:** VisualTester confirms the three content areas render and link correctly.

### Stage 6 — Record & commit (local only)
- **Goal:** persist the work per program rules.
- **Commands:**
  - `git -C ~/dev_ai/traderton add site infra/hetzner/compose.site-local.yaml
    infra/hetzner/tests/site-isolation.sh …`
  - One atomic local commit (NO push, NO merge to `main`).
- **Record:** update herobids `…/004-phase2-program/TASKS.md` T4.1 → ✅ and the cursor; append
  any decision to that program's `DECISIONS.md`. Note the T4.2 carve-out (§8).
- **Exit:** committed locally; trackers updated.

---

## 5. Test strategy

| Area | Level | How |
|---|---|---|
| Caddy guard (static) | Unit-ish shell assert | `site-isolation.sh` offline grep on `Caddyfile.staging` (+ optionally fold into `offline-guards.sh`). Always runnable, no Docker. |
| Boundary isolation (live) | Integration (local) | `site-isolation.sh` live `curl` vs the local stack: 404 `/health*` `/internal*`, 200 `/`. |
| Pages render / links | Visual (local) | VisualTester (Stage 5). |
| Workspace health | Build/lint | `pnpm lint` + `pnpm build` (Stage 4). |

No new unit-test *framework* work — the site has no TS/logic. Behaviour-named assertions
(e.g. "public vhost returns 404 for /health") per AGENTS.md.

---

## 6. Risks / open questions

- **R1 — docs surfacing mechanic (D3).** Default = authored summary + link to canonical
  `docs/reference/...`. If stakeholders want venue bodies inline, that is a Markdown
  pre-render step (new dep) → **architecturally significant → Contemplator** before doing it.
  Not required for T4.1 exit.
- **R2 — local Caddy on port 80.** May clash with a locally-running staging stack. Mitigate:
  document a port note / allow a `SITE_HTTP_PORT` override in the local compose (local-only,
  no `.env` twin needed since it is a compose default, not read by app code).
- **R3 — image choice (caddy vs nginx).** D2 picks `caddy:2-alpine` for image-set economy.
  LOW stakes; implementer may use `nginx:alpine` if simpler for the `site` container — not
  architecturally significant.
- **R4 — accidental publish coupling.** Any edit to `compose.yaml`, `deploy.sh`, or
  `deploy-on-host.sh` would cross into T4.2. Stage boundaries forbid this; the isolation test
  does not require it.

---

## 7. Architecturally-significant / hard-stop flags

- **HARD STOP (defer to T4.2, §5.1):** DNS, TLS/cert issuance, the VM deploy, adding `site`
  to the staging `compose.yaml`, and adding `site` artifacts to `deploy.sh RUNTIME_FILES` /
  the `deploy-on-host.sh` compose up list. **Prepared as docs in §8, NOT executed.**
- **Contemplator trigger (if raised):** choosing Markdown pre-render (D3(b)) — adds a build
  step + dependency and changes the docs-surfacing contract.

---

## 8. T4.2 carve-out — PREPARED, NOT EXECUTED (publish = HARD STOP §5.1)

Document these for T4.2; do not perform them in T4.1:

1. **Add `site` to staging `compose.yaml`** — define the `site` service
   (`caddy:2-alpine`/`nginx:alpine` serving the built `site/` content, `expose: ["80"]`, no
   host port — reachable only via `caddy`), and make `caddy` `depends_on` it. Decide how
   `site/` reaches the VM (baked into an image vs. uploaded as runtime files).
2. **Deliver `site/` to the VM** — either (a) add the `site/` content to `deploy.sh`
   `RUNTIME_FILES` (note the guard test forbids secrets/state in that list — static HTML is
   fine), or (b) build a `site` image in CI (new Dockerfile target) and pull it like the
   boundary image. **Recommend (b)** to match the existing image-pull model and keep
   `RUNTIME_FILES` minimal.
3. **DNS** — `staging.traderton.com` A/AAAA → the VM public IP.
4. **TLS** — Caddy auto-issues on first HTTPS hit once DNS resolves and 80/443 are open
   (already handled by UFW + the `email` directive in `Caddyfile.staging`); verify cert
   issuance post-publish.
5. **Update `offline-guards.sh`** to assert the new staging-compose `site` service shape once
   it exists (so the guard suite tracks reality).

All five require operator approval (infra mutation). Request it in T4.2; keep T4.2 status 🚫
until approved.

---

## 9. Handoff

Plan complete; **no critical unresolved blockers** for T4.1 (all open items are LOW-stakes
mechanical defaults or belong to T4.2). Ready for the **Implementer** to execute Stages 0–6.
Route D3(b) to a **Contemplator** only if inline-rendered venue bodies are later requested.
