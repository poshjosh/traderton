#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

grep -Eq '^[[:space:]]*key=traderton/\$\{ENVIRONMENT\}/terraform\.tfstate' plan-apply.sh || \
grep -Fq 'key=traderton/${ENVIRONMENT}/terraform.tfstate' plan-apply.sh
if grep -Eq '^resource "hcloud_network(_subnet)?" ' -- *.tf; then
  echo 'Traderton must not own the Herobids network or subnet' >&2
  exit 1
fi
grep -Fq 'Requires=traderton-data.service' docker-data.conf
grep -Fq 'Before=docker.service' traderton-data.service
grep -Fq 'install -m 0644 docker-data.conf /etc/systemd/system/docker.service.d/traderton-data.conf' deploy-on-host.sh
grep -Fq 'api_hostname' main.tf
# UFW opens 22/80/443; the boundary itself is reachable only via Caddy HTTP.
grep -Fq -- 'ufw allow 22/tcp' cloud-init.sh.tftpl
grep -Fq -- 'ufw allow 80/tcp' cloud-init.sh.tftpl
grep -Fq -- 'ufw allow 443/tcp' cloud-init.sh.tftpl
grep -Fq -- 'ufw default deny incoming' cloud-init.sh.tftpl
grep -Fq -- 'ufw --force enable' cloud-init.sh.tftpl
# The old DOCKER-USER iptables chain must not remain.
if grep -Eq 'DOCKER-USER|TRADERTON_BOUNDARY|iptables-restore' cloud-init.sh.tftpl; then
  echo 'Staging firewall must use UFW (herobids convention), not a DOCKER-USER iptables chain' >&2
  exit 1
fi
grep -Fq 'ufw status' deploy-on-host.sh
grep -Fq 'UFW ${port}/tcp allow is absent' deploy-on-host.sh
grep -Fq 'for port in 80 443' deploy-on-host.sh
grep -Fq '@execution path /internal /internal/* /health /health/*' Caddyfile.staging
grep -Fq 'respond @execution 404' Caddyfile.staging
grep -Fq 'reverse_proxy site:80' Caddyfile.staging
grep -Fq 'reverse_proxy boundary:8080' Caddyfile.staging
# Alerts reuse the SMTP (send-alert) convention; no HTTPS webhook remains.
if grep -Eq 'BACKUP_ALERT_WEBHOOK_URL|curl[[:space:]]+.*hook|Content-Type: application/json|alerts\.example\.test' backup-alert.sh backup.sh backup-job.sh backup-health.sh .env.backup.example; then
  echo 'Backup alerts must use the SMTP send-alert convention, not an HTTPS webhook' >&2
  exit 1
fi
grep -Fq 'ALERT_TO' .env.backup.example
grep -Fq 'ALERT_SMTP_HOST' .env.backup.example
# Local deploy helper must copy an explicit runtime list over SSH, never secrets or state.
[[ -f scripts/deploy.sh ]] || { echo 'scripts/deploy.sh missing' >&2; exit 1; }
grep -Fq 'RUNTIME_FILES=(' scripts/deploy.sh
grep -Fq 'terraform_output -raw public_ip' scripts/deploy.sh
grep -Fq 'scp ' scripts/deploy.sh
grep -Fq '_ssh_opts.sh' scripts/deploy.sh
grep -Fq './deploy-on-host.sh --confirm-staging' scripts/deploy.sh
# The uploaded runtime list must never include Terraform state, tfvars, or real env files.
if awk '/RUNTIME_FILES=\(/{f=1} f{print} f&&/\)/{exit}' scripts/deploy.sh | grep -Eq '\.env\.(staging|backup)|staging\.tfvars|\.tfstate|\.terraform'; then
  echo 'Deploy helper must not upload Terraform state, tfvars, or real env files' >&2
  exit 1
fi
for script in deploy-on-host.sh scripts/deploy.sh scripts/resolve-images.sh backup.sh backup-job.sh backup-alert.sh backup-health.sh check-backup-success.sh plan-apply.sh mount-data.sh cloud-init.sh.tftpl; do
  bash -n "$script"
done

private_ip=10.77.1.20
export POSTGRES_IMAGE="postgres:16@sha256:$(printf 'b%.0s' {1..64})"
export REDIS_IMAGE="redis:7@sha256:$(printf 'c%.0s' {1..64})"
export POSTGRES_PASSWORD=fixture
export DATABASE_URL=postgres://traderton:fixture@postgres:5432/traderton
export BOUNDARY_IMAGE="ghcr.io/poshjosh/traderton:sha-0123456789012345678901234567890123456789@sha256:$(printf 'a%.0s' {1..64})"
COMPOSE_PROFILES=migrate docker compose -f compose.yaml config --no-env-resolution --format json | jq -e -r '
  (.services.boundary | has("ports") | not) and
  .services.boundary.expose == ["8080"] and
  .services.caddy.image == "caddy:2-alpine" and
  (.services.caddy.ports | map(.published) | index("80") != null) and
  (.services.caddy.ports | map(.published) | index("443") != null) and
  (.services.postgres | has("ports") | not) and
  (.services.redis | has("ports") | not) and
  .services.migrate.environment.DATABASE_URL == "postgres://traderton:fixture@postgres:5432/traderton" and
  .services.migrate.environment.NODE_ENV == "staging" and
  (.services.migrate | has("env_file") | not) and
  .services.boundary.cap_drop == ["ALL"] and
  .services.boundary.security_opt == ["no-new-privileges:true"] and
  .services.boundary.mem_limit == "1073741824" and
  .services.boundary.cpus == 1 and
  .services.boundary.pids_limit == 256
' > /dev/null

if bash deploy-on-host.sh --confirm-staging invalid >/dev/null 2>&1; then
  echo 'Deploy accepted an unpinned release' >&2
  exit 1
fi
if bash deploy-on-host.sh --confirm-staging 0123456789012345678901234567890123456789 >/dev/null 2>&1; then
  echo 'Deploy accepted a non-staging host' >&2
  exit 1
fi
echo 'Offline staging guards passed'