# T4.2 — Publish `staging.traderton.com`

**Status:** **APPROVED + EXECUTED (option b, CI site image).** Operator granted
the infra greenlight and authorized pushing `main` for this on 2026-10-01.
**Created:** 2026-10-01. **Program:** herobids Phase 2 — Step 7 / `T4.2`
(`herobids/docs/features/2026/10/004-phase2-program/{ENTRYPOINT,TASKS}.md`).

> **Originally a §5.1 infrastructure HARD STOP.** Everything below mutates
> infrastructure (DNS, TLS, VM deploy, the staging compose + deploy flow). The
> operator reviewed, approved, and greenlit execution — including the normally-
> separate `main`-push invariant — so this was carried out via the CI-image path
> (option A/b: a baked `traderton-site` image built+pushed by CI and pulled on
> the VM, mirroring the boundary image model).
>
> **What was done (chosen path = image, option b):**
> - `Dockerfile.site` bakes `site/` + `docs/reference/` into `caddy:2-alpine`
>   (serves `/srv` on `:80` via `site/Caddyfile.image`; config files excluded
>   from the web root).
> - `.github/workflows/build-push.yml` gained a **Build and push site** job →
>   `ghcr.io/<owner>/traderton-site:sha-<commit>` (same commit-SHA tag model).
> - Staging `compose.yaml` gained the `site` service (no host port, `expose 80`,
>   `cap_drop: [ALL]`, `no-new-privileges`, mem/cpu/pids caps, healthcheck);
>   `caddy` now `depends_on` both `boundary` and `site` being healthy.
> - `deploy-on-host.sh` derives `SITE_IMAGE` from the release SHA, pulls + brings
>   up `site`, and `caddy` depends on it.
> - DNS: the operator created the A records (`staging` + `api` →
>   `2.28.19.89`); Caddy auto-issues TLS on first HTTPS hit.
> - Guard tests (`offline-guards.sh`, `site-isolation.sh`) extended to assert the
>   new staging `site` service shape + the baked-image/local-config lockstep.

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

## 4. Approval checklist (operator) — RESOLVED 2026-10-01

- [x] Approve Step A delivery mechanism → **image, option b** (approved).
- [x] Approve the `site` service addition to the staging `compose.yaml`.
- [x] Approve the `deploy-on-host.sh` service-list change.
- [x] Approve DNS record creation → operator created `staging` + `api` A records
      (`2.28.19.89`).
- [x] Confirm TLS issuance after publish; run the HTTPS isolation checks.
- [ ] (Separately, still open) resolve ESCALATIONS E1/E3 + N1 before any
      herobids→site links.
