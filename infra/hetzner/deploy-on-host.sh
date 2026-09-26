#!/usr/bin/env bash
# deploy-on-host.sh — runs ON the staging VM (NOT from your laptop). Performs
# the actual compose lifecycle: verifies host/marker + root, derives DATABASE_URL
# and the pinned BOUNDARY_IMAGE, `docker login ghcr.io`, pulls, migrates, starts
# boundary + caddy, and waits for readiness.
#
# This is uploaded to the VM by the LOCAL entrypoint `scripts/deploy.sh` and
# invoked there as `./deploy-on-host.sh --confirm-staging <sha>`. Do NOT run it
# directly from your laptop — it self-guards on the host marker and will refuse.
#
# Local deploy flow: `scripts/deploy.sh` (laptop) → uploads this file → SSHes in
# → runs `./deploy-on-host.sh --confirm-staging <sha>` on the VM.
set -euo pipefail

cd "$(dirname "$0")"
if [[ $# != 2 || "$1" != --confirm-staging ]]; then
  echo 'Usage: deploy.sh --confirm-staging <40-character release SHA>' >&2
  exit 2
fi
release_sha=$2
[[ "$release_sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'Release must be a full lowercase commit SHA' >&2; exit 2; }
[[ -f /etc/traderton-staging/host-marker && "$(hostname -s)" == traderton-staging ]] || { echo 'Not the Traderton staging VM' >&2; exit 1; }
[[ $(id -u) == 0 ]] || { echo 'Run as root on the staging VM' >&2; exit 1; }
[[ -f .env.staging && $(stat -c %a .env.staging) == 600 && $(stat -c %u .env.staging) == 0 ]] || { echo 'Provide root-owned .env.staging (mode 600)' >&2; exit 1; }
for key in POSTGRES_PASSWORD REDIS_URL BOUNDARY_CONSUMER_ID BOUNDARY_KEY_ID BOUNDARY_SIGNING_SECRET CREDENTIAL_ENCRYPTION_KEY GHCR_USERNAME GHCR_TOKEN; do
  grep -Eq "^${key}=.+" .env.staging || { echo "Missing $key in .env.staging" >&2; exit 1; }
done
ghcr_username=$(sed -n 's/^GHCR_USERNAME=//p' .env.staging)
[[ "$ghcr_username" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo 'GHCR_USERNAME must be a lowercase ghcr.io owner' >&2; exit 1; }
# Derive the full boundary image reference from the owner + release SHA tag
# (the build-push workflow tags each commit as ghcr.io/<owner>/traderton:sha-<commit>,
# which is unique and immutable — no separate digest pin needed).
boundary_image="ghcr.io/${ghcr_username}/traderton:sha-${release_sha}"
# Derive DATABASE_URL from POSTGRES_PASSWORD (URL-encode the password).
postgres_password=$(sed -n 's/^POSTGRES_PASSWORD=//p' .env.staging)
encoded_password=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$postgres_password")
database_url="postgres://traderton:${encoded_password}@postgres:5432/traderton"
unset postgres_password encoded_password
encryption_key=$(sed -n 's/^CREDENTIAL_ENCRYPTION_KEY=//p' .env.staging)
[[ "$encryption_key" =~ ^[0-9a-fA-F]{64}$ ]] || { echo 'CREDENTIAL_ENCRYPTION_KEY must be 64 hex characters' >&2; exit 1; }
unset encryption_key

# TLS model: confirm UFW allows 80 and 443 (Caddy terminates TLS; the boundary
# is reachable only via Caddy on the compose network, never directly).
for port in 80 443; do
  ufw status | grep -Eq "${port}/tcp[[:space:]]+ALLOW" || { echo "UFW ${port}/tcp allow is absent" >&2; exit 1; }
done
./mount-data.sh
for port in 80 443; do
  ufw status | grep -Eq "${port}/tcp[[:space:]]+ALLOW" || { echo "UFW ${port}/tcp allow is absent" >&2; exit 1; }
done
install -m 0644 traderton-data.service /etc/systemd/system/
install -d -m 0755 /etc/systemd/system/docker.service.d
install -m 0644 docker-data.conf /etc/systemd/system/docker.service.d/traderton-data.conf
systemctl daemon-reload
systemctl enable --now traderton-data.service
# Export the derived values so compose interpolation sees them.
export BOUNDARY_IMAGE="$boundary_image"
export DATABASE_URL="$database_url"
docker compose --env-file .env.staging config --quiet
# Authenticate to ghcr.io so the private boundary image can be pulled.
ghcr_token=$(sed -n 's/^GHCR_TOKEN=//p' .env.staging)
printf '%s' "$ghcr_token" | docker login ghcr.io -u "$ghcr_username" --password-stdin
unset ghcr_username ghcr_token
docker compose --env-file .env.staging pull postgres redis boundary caddy
docker compose --env-file .env.staging up -d postgres redis
docker compose --env-file .env.staging --profile migrate run --rm migrate
# Record the intended release before the new image runs. If readiness below
# fails, the record is overwritten with an explicit failed marker so a stale
# success is never left claiming a release that did not come up.
printf '%s\n' "$release_sha" > /etc/traderton-staging/release-sha
printf '%s\n' "$boundary_image" > /etc/traderton-staging/image-digest
docker compose --env-file .env.staging up -d boundary
ready=false
# 60 x 2s = 120s, covering the boundary healthcheck budget (20 retries x 5s = 100s)
# so a container that only just satisfies its own healthcheck is still observed ready.
for attempt in {1..60}; do
  if docker compose --env-file .env.staging exec -T boundary node -e "fetch('http://localhost:8080/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    ready=true
    break
  fi
  sleep 2
done
if [[ "$ready" != true ]]; then
  printf 'failed\n' > /etc/traderton-staging/release-sha
  printf 'failed\n' > /etc/traderton-staging/image-digest
  echo 'Boundary did not become ready' >&2
  exit 1
fi
# Bring up Caddy (TLS on 80/443) now that the boundary is healthy.
docker compose --env-file .env.staging up -d caddy
install -m 0644 traderton-backup.service traderton-backup-alert.service traderton-backup.timer traderton-backup-health.service traderton-backup-health.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now traderton-backup.timer
systemctl enable --now traderton-backup-health.timer