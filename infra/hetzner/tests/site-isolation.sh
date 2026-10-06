#!/usr/bin/env bash
# site-isolation.sh — prove the public site vhost (staging.traderton.com) never
# reaches the execution surface: it serves static content, blocks /health* and
# /internal*, and never reverse-proxies the boundary.
#
# Two layers, matching the offline-guards.sh convention:
#   1. OFFLINE  — static grep asserts on Caddyfile.staging (always run, no Docker).
#   2. LIVE     — curl asserts against the local site stack IF it is reachable
#                 (infra/hetzner/compose.site-local.yaml). Skipped otherwise.
set -euo pipefail
cd "$(dirname "$0")/.."

# ── 1. Offline: the Caddy guard is present and the public vhost is site-only ──
grep -Fq '@execution path /internal /internal/* /health /health/*' Caddyfile.staging
grep -Fq 'respond @execution 404' Caddyfile.staging
grep -Fq 'reverse_proxy site:80' Caddyfile.staging

# The public (staging.traderton.com) vhost must NOT proxy the boundary. Extract
# that block and assert it carries no `reverse_proxy boundary` line. The apex/
# execution host (api.staging.traderton.com) is the only place boundary:8080 may
# appear.
public_block="$(awk '
  /^staging\.traderton\.com[[:space:]]*\{/ { inblock=1 }
  inblock { print }
  inblock && /^\}/ { exit }
' Caddyfile.staging)"
if [[ -z "$public_block" ]]; then
  echo 'Could not locate the staging.traderton.com vhost block in Caddyfile.staging' >&2
  exit 1
fi
if grep -Fq 'reverse_proxy boundary' <<<"$public_block"; then
  echo 'The public site vhost must never reverse_proxy the boundary' >&2
  exit 1
fi
if ! grep -Fq 'reverse_proxy site:80' <<<"$public_block"; then
  echo 'The public site vhost must reverse_proxy site:80' >&2
  exit 1
fi

# The local HTTP mirror must keep the SAME guard directives as the staging file
# (so exercising it locally proves the real guard). Lockstep asserts:
grep -Fq '@execution path /internal /internal/* /health /health/*' Caddyfile.site-local
grep -Fq 'respond @execution 404' Caddyfile.site-local
grep -Fq 'reverse_proxy site:80' Caddyfile.site-local
if grep -Fq 'reverse_proxy boundary' Caddyfile.site-local; then
  echo 'The local site mirror must never reverse_proxy the boundary' >&2
  exit 1
fi

# The local site compose must be local-only: it must carry the hard-stop marker,
# define the `site` service, and define NO boundary service (the local stack has
# no execution surface).
grep -Fq 'LOCAL ONLY' compose.site-local.yaml
grep -Eq '^[[:space:]]+site:' compose.site-local.yaml
if grep -Eq '^[[:space:]]+boundary:' compose.site-local.yaml; then
  echo 'The local site stack must not define a boundary (execution) service' >&2
  exit 1
fi

# The STAGING site image (Dockerfile.site) bakes site/Caddyfile.image as the
# file-server config. It must stay in lockstep with site/Caddyfile.local (same
# plain file server on :80), carry no execution surface, and never proxy the
# boundary. The edge Caddy (Caddyfile.staging) owns the path guard.
repo_root="$(cd ../.. && pwd)"
image_caddyfile="${repo_root}/site/Caddyfile.image"
local_caddyfile="${repo_root}/site/Caddyfile.local"
[[ -f "$image_caddyfile" ]] || { echo 'site/Caddyfile.image missing (baked into Dockerfile.site)' >&2; exit 1; }
grep -Fq 'root * /srv' "$image_caddyfile"
grep -Fq 'file_server' "$image_caddyfile"
if grep -Fq 'reverse_proxy boundary' "$image_caddyfile"; then
  echo 'The baked site image config must never reverse_proxy the boundary' >&2
  exit 1
fi
# Lockstep: the image config's directive body must match the local one's.
if ! diff -q \
  <(grep -E '^\s*(root|file_server)' "$image_caddyfile") \
  <(grep -E '^\s*(root|file_server)' "$local_caddyfile") >/dev/null; then
  echo 'site/Caddyfile.image file-server directives drifted from site/Caddyfile.local' >&2
  exit 1
fi
# Dockerfile.site must bake the site + reference docs and the image config, and
# must not drop a path guard into the site container (guard is edge-only).
grep -Fq 'COPY site/Caddyfile.image /etc/caddy/Caddyfile' "${repo_root}/Dockerfile.site"
grep -Fq 'COPY docs/reference/ /srv/docs/reference/' "${repo_root}/Dockerfile.site"
if grep -Fq 'reverse_proxy boundary' "${repo_root}/Dockerfile.site"; then
  echo 'Dockerfile.site must never reference the boundary' >&2
  exit 1
fi

bash -n tests/site-isolation.sh

echo 'Offline site-isolation guards passed'

# ── 2. Live: curl the local stack if it is up ────────────────────────────────
host='staging.traderton.com'
base="http://localhost:${SITE_HTTP_PORT:-80}"

code() {
  # Emit exactly the 3-digit status, or 000 if curl cannot connect. Printing
  # inside the `if` avoids concatenating curl's output with a fallback echo.
  local out
  if out="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 -H "Host: ${host}" "$1" 2>/dev/null)"; then
    printf '%s' "$out"
  else
    printf '000'
  fi
}

root_code="$(code "${base}/")"
if [[ "$root_code" == "000" ]]; then
  echo "Live stack not reachable at ${base} — skipping live asserts (run: docker compose -f infra/hetzner/compose.site-local.yaml up -d)"
  exit 0
fi

fail=0
assert() { # path expected
  local got; got="$(code "${base}$1")"
  if [[ "$got" != "$2" ]]; then
    echo "LIVE FAIL: ${host}$1 expected $2, got $got" >&2
    fail=1
  else
    echo "LIVE ok: ${host}$1 → $got"
  fi
}

assert "/" 200
assert "/docs/" 200
assert "/status.html" 200
assert "/legal/privacy-policy.html" 200
assert "/legal/user-agreement.html" 200
assert "/health" 404
assert "/health/ready" 404
assert "/internal" 404
assert "/internal/v1/tools:invoke" 404

if [[ "$fail" -ne 0 ]]; then
  echo 'Live site-isolation asserts failed' >&2
  exit 1
fi
echo 'Live site-isolation guards passed'
