# T4.2 — Publish `staging.traderton.com` (PREP ONLY — infrastructure HARD STOP)

**Status:** prepared, **NOT executed**. **Created:** 2026-10-01.
**Program:** herobids Phase 2 — Step 7 / `T4.2`
(`herobids/docs/features/2026/10/004-phase2-program/{ENTRYPOINT,TASKS}.md`).

> **This is a §5.1 infrastructure HARD STOP.** Everything below mutates
> infrastructure (DNS, TLS, VM deploy, the staging compose + deploy flow). An
> autonomous agent **must not execute any of it** — it is documented here so the
> operator can review and approve, then run it (or direct it) deliberately.
> Until approved, `T4.2` stays 🚫 in the tracker. The site content itself (T4.1)
> is already built and verified locally; publishing is purely the ship step.

## 0. Current state (what already exists)

- `site/` — the static public site (built + locally verified in T4.1).
- `infra/hetzner/Caddyfile.staging` — **already** reverse-proxies
  `staging.traderton.com` → `site:80` with the `/internal*` + `/health*` → 404
  guard. The apex `api.staging.traderton.com` → `boundary:8080`.
- `infra/hetzner/compose.yaml` — defines `postgres`, `redis`, `migrate`,
  `boundary`, `caddy`. **No `site` service yet** — so today the public vhost has
  no upstream to proxy. Publishing must add it.
- `infra/hetzner/scripts/deploy.sh` (`RUNTIME_FILES` upload allow-list) and
  `infra/hetzner/deploy-on-host.sh` (`docker compose … pull/up -d postgres redis
  boundary caddy`) — the deploy flow. Neither handles `site`.

## 1. Steps to publish (each requires operator approval)

### Step A — Deliver the `site` content to the VM
Two options; **(b) recommended** to match the existing image-pull model and keep
the upload allow-list minimal (the `offline-guards.sh` test forbids secrets/state
in `RUNTIME_FILES`; static HTML would be allowed, but an image is cleaner):

- **(a) Ship as runtime files:** add the `site/` tree to `deploy.sh`
  `RUNTIME_FILES` and mount it into a stock `caddy`/`nginx` `site` container.
- **(b) Ship as an image (recommended):** add a `site` build target to the
  Dockerfile (or a tiny second Dockerfile) that bakes `site/` into
  `caddy:2-alpine` with `Caddyfile.local`; have CI build+push it as
  `ghcr.io/<owner>/traderton-site:sha-<commit>` (mirror the boundary image
  workflow); pull it on the host like the boundary image.

### Step B — Add the `site` service to the STAGING `compose.yaml`
Define `site` with **no host port** (reachable only via `caddy` on the compose
network), `expose: ["80"]`, resource caps mirroring `boundary`
(`cap_drop: [ALL]`, `no-new-privileges`, mem/cpu/pids limits), and a healthcheck.
Make `caddy` `depends_on: { site: { condition: service_healthy } }`. Serve the
canonical docs: either bake `docs/reference/` into the site image (option A/b) or
mount it read-only.

### Step C — Wire `site` into `deploy-on-host.sh`
Add `site` to the `docker compose … pull …` and `docker compose … up -d …`
service lists (alongside `boundary`/`caddy`). If using image option (b), derive
the `SITE_IMAGE` ref the same way `BOUNDARY_IMAGE` is derived and export it for
compose interpolation.

### Step D — DNS
Create `staging.traderton.com` A/AAAA records → the staging VM public IP
(`terraform output public_ip`). The apex `api.staging.traderton.com` DNS already
exists for the boundary.

### Step E — TLS
Caddy auto-issues the cert on first HTTPS hit once DNS resolves and UFW allows
80/443 (both already asserted by `deploy-on-host.sh`). The `email` directive in
`Caddyfile.staging` is set. Verify cert issuance post-publish:
`curl -sI https://staging.traderton.com/` → 200; `/health` → 404; `/internal` →
404.

### Step F — Update the guard test for the new compose shape
Once `site` is in the staging `compose.yaml`, extend `offline-guards.sh` (and the
live portion of `site-isolation.sh`) to assert the staging `site` service shape
(no host port, `caddy depends_on site`, public vhost still 404s `/health*` +
`/internal*` over HTTPS).

## 2. Isolation invariant to preserve

The published public site MUST keep the execution surface unreachable:
`staging.traderton.com/health*` and `/internal*` → 404, and the public vhost must
never proxy `boundary`. This is already enforced by `Caddyfile.staging` and is
regression-tested by `infra/hetzner/tests/site-isolation.sh` (offline) — keep
that test green through the publish change.

## 3. The herobids→Traderton outbound-link question (depends on E1/E3)

If the operator decides herobids MAY link out to this site (ESCALATIONS N1,
E1/E3 family), the two removed herobids funding-doc links can be restored as
outbound links to `https://staging.traderton.com/docs/...` once published. Do not
restore them until that positioning decision is made.

## 4. Approval checklist (operator)

- [ ] Approve Step A delivery mechanism (recommend image option b).
- [ ] Approve the `site` service addition to the staging `compose.yaml`.
- [ ] Approve the `deploy-on-host.sh` service-list change.
- [ ] Approve DNS record creation for `staging.traderton.com`.
- [ ] Confirm TLS issuance after publish; run the HTTPS isolation checks.
- [ ] (Separately) resolve ESCALATIONS E1/E3 + N1 before any herobids→site links.
