#!/usr/bin/env bash
# deploy.sh — push the Traderton staging runtime to the VM and run the on-host
# deploy. Runs from your laptop; the on-VM deploy.sh does the actual compose
# lifecycle. Mirrors the Herobids local → remote deploy convention.
#
# Usage:
#   deploy.sh [--env <staging|production>] [--env-file <path>] \
#             [--backend-env-file <path>] [--ssh-key <path>] \
#             [--release-sha <40-character SHA>]
#
# The VM public IP is resolved from `terraform output public_ip` (the staging
# workspace). `.env.staging` and `.env.backup` are copied from --env-file /
# their default paths; the directory of runtime files is copied from
# infra/hetzner/, excluding anything with secrets or Terraform state.
set -euo pipefail
cd "$(dirname "$0")/.."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_ssh_opts.sh"

BACKEND_ENV_FILE="${BACKEND_ENV_FILE:-${PWD}/.env.terraform}"
ENV_FILE="${PWD}/.env.staging"
BACKUP_ENV_FILE="${PWD}/.env.backup"
RELEASE_SHA=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      TRADERTON_ENV="${2:-}"; [[ -n "$TRADERTON_ENV" ]] || { echo 'ERROR: --env requires a value' >&2; exit 2; }; shift 2;;
    --env-file)
      ENV_FILE="${2:-}"; [[ -n "$ENV_FILE" ]] || { echo 'ERROR: --env-file requires a path' >&2; exit 2; }; shift 2;;
    --backend-env-file)
      BACKEND_ENV_FILE="${2:-}"; [[ -n "$BACKEND_ENV_FILE" ]] || { echo 'ERROR: --backend-env-file requires a path' >&2; exit 2; }; shift 2;;
    --ssh-key)
      TRADERTON_SSH_KEY="${2:-}"; [[ -n "$TRADERTON_SSH_KEY" ]] || { echo 'ERROR: --ssh-key requires a path' >&2; exit 2; }; shift 2;;
    --release-sha)
      RELEASE_SHA="${2:-}"; [[ -n "$RELEASE_SHA" ]] || { echo 'ERROR: --release-sha requires a value' >&2; exit 2; }; shift 2;;
    *)
      echo "ERROR: Unknown option: $1" >&2; exit 2;;
  esac
done

[[ "$RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo 'Provide --release-sha <40-character commit SHA>' >&2; exit 2; }

for t in terraform scp ssh; do
  command -v "$t" >/dev/null 2>&1 || { echo "ERROR: $t is required." >&2; exit 1; }
done

# Resolve the VM public IP and SSH key from the shared helpers.
if [[ -f "$BACKEND_ENV_FILE" ]]; then
  set -a; source "$BACKEND_ENV_FILE"; set +a
fi
resolve_ssh_key
IP=$(terraform_output -raw public_ip)
[[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "ERROR: could not resolve public_ip (got '$IP')" >&2; exit 1; }

# The runtime files that must live in /opt/traderton/staging — explicit list,
# never a blanket copy, so secrets and Terraform state are never uploaded.
RUNTIME_FILES=(
  Caddyfile.staging compose.yaml deploy.sh
  mount-data.sh backup.sh backup-job.sh backup-alert.sh backup-health.sh check-backup-success.sh
  docker-data.conf
  traderton-data.service traderton-backup.service traderton-backup-alert.service
  traderton-backup.timer traderton-backup-health.service traderton-backup-health.timer
)
[[ -f "$ENV_FILE" ]] || { echo "ERROR: $ENV_FILE not found (create from .env.environment.example)" >&2; exit 1; }

scp_args=(${SSH_OPTS})
REMOTE="root@${IP}:/opt/traderton/staging/"
echo "==> Uploading runtime files to ${REMOTE}"
scp "${scp_args[@]}" "${RUNTIME_FILES[@]/#/$PWD/}" "${REMOTE}"

echo "==> Uploading .env.staging (mode 600) to root@${IP}:/opt/traderton/staging/.env.staging"
scp "${scp_args[@]}" "$ENV_FILE" "root@${IP}:/opt/traderton/staging/.env.staging"
if [[ -f "$BACKUP_ENV_FILE" ]]; then
  echo "==> Uploading .env.backup"
  scp "${scp_args[@]}" "$BACKUP_ENV_FILE" "root@${IP}:/opt/traderton/staging/.env.backup"
fi

echo "==> Running on-host deploy (--confirm-staging ${RELEASE_SHA})"
ssh "${scp_args[@]}" "root@${IP}" \
  "cd /opt/traderton/staging && chmod 600 .env.staging && ./deploy.sh --confirm-staging ${RELEASE_SHA}"