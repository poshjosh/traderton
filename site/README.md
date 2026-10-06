# Traderton public site (`staging.traderton.com`)

Minimal, static, human-facing site for Traderton: product identity, docs/venue
guides, and a service-status page. **No trading dashboard. No execution-boundary
exposure.**

The site is plain static HTML + CSS — no build toolchain, no dependencies, and
not a pnpm workspace package (so it never affects `pnpm lint` / `pnpm build`).

## Layout

```
site/
  index.html          # product identity / landing
  docs/index.html     # docs hub — links to the canonical docs/reference/* docs
  status.html         # static service status
  legal/index.html    # legal hub (avoids a raw directory listing)
  legal/privacy-policy.html   # trading data, venue disclosures, retention
  legal/user-agreement.html   # trading decisions/risk, execution modes, liability
  assets/style.css    # shared styles
  Caddyfile.local     # file-server config for the local `site` container
  Caddyfile.image     # file-server config baked into the staging site image
```

The docs hub links to the canonical reference docs in the repo's
`docs/reference/` (venues, crypto ecosystem, trading glossary). The local stack
mounts `docs/reference/` under `/docs/reference/` so those links resolve.

## Run locally

```sh
docker compose -f infra/hetzner/compose.site-local.yaml up -d

# Public site is served, with the real Caddyfile.staging path guard in front:
curl -s -H 'Host: staging.traderton.com' http://localhost/            # 200
curl -s -o /dev/null -w '%{http_code}' \
     -H 'Host: staging.traderton.com' http://localhost/health         # 404 (blocked)

# Prove isolation (offline + live):
bash infra/hetzner/tests/site-isolation.sh
```

If port 80 is taken: `SITE_HTTP_PORT=8088 docker compose -f infra/hetzner/compose.site-local.yaml up -d`
(and pass the same `SITE_HTTP_PORT` to the isolation test).

## Publishing is a separate task (T4.2 — infrastructure hard stop)

This directory and the local compose override do NOT publish the site. Wiring
`site` into the staging `compose.yaml`, shipping the content to the VM
(`scripts/deploy.sh` `RUNTIME_FILES` or a CI-built image), DNS, and TLS are all
**T4.2** and require operator approval. See
`docs/features/2026/10/01/001-minimal-public-site/001-plan.md` §8.
