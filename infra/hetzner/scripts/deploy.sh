#!/usr/bin/env bash
# deploy.sh — push the Traderton runtime to the VM and run the on-host
# deploy. Runs from your laptop; the on-VM deploy-on-host.sh does the actual
# compose lifecycle. Mirrors the Herobids local → remote deploy convention.
#
# Usage:
#   deploy.sh [--env <staging|production>] [--env-file <path>] \
#             [--backend-env-file <path>] [--ssh-key <path>] \
#             [--release-sha <40-character SHA>]
#
# The VM public IP is resolved from `terraform output public_ip` (the
# <env> workspace). `.env.<env>` and `.env.backup` are copied from --env-file /
# their default paths; the directory of runtime files is copied from
# infra/hetzner/, excluding anything with secrets or Terraform state.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}/.."
source "${SCRIPT_DIR}/_ssh_opts.sh"

# Make failure unmistakable: on any non-zero exit, print an explicit banner
# naming the failing line so a half-finished deploy is never mistaken for a
# success. The success banner at the end clears the trap.
trap 'echo "==> Deploy FAILED (exit $? at line $LINENO) — ${TRADERTON_ENV} may be in a partial state; re-run after fixing" >&2' ERR

BACKEND_ENV_FILE="${BACKEND_ENV_FILE:-${PWD}/.env.terraform}"
BACKUP_ENV_FILE="${PWD}/.env.backup"
RELEASE_SHA=""
ENV_FILE_OVERRIDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      TRADERTON_ENV="${2:-}"; [[ -n "$TRADERTON_ENV" ]] || { echo 'ERROR: --env requires a value' >&2; exit 2; }
      case "$TRADERTON_ENV" in
        staging|production) ;;
        *) echo "ERROR: Unknown TRADERTON_ENV=${TRADERTON_ENV}. Must be staging or production." >&2; exit 1;;
      esac
      export TRADERTON_ENV
      resolve_ssh_key
      shift 2;;
    --env-file)
      ENV_FILE_OVERRIDE="${2:-}"; [[ -n "$ENV_FILE_OVERRIDE" ]] || { echo 'ERROR: --env-file requires a path' >&2; exit 2; }; shift 2;;
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

# ENV_FILE depends on TRADERTON_ENV, which --env (above) or _ssh_opts.sh's
# default may set — resolve it only now that argument parsing is complete.
ENV_FILE="${ENV_FILE_OVERRIDE:-${PWD}/.env.${TRADERTON_ENV}}"

# When no explicit --release-sha is given, resolve the pushed HEAD and wait for
# the matching GitHub "Build and Push" run to complete, then use its SHA. This
# makes the deploy fully automated: push → deploy.sh blocks until the image is
# built/pushed, then proceeds. An explicit --release-sha still short-circuits
# the CI gate (e.g. a re-deploy of an already-built commit).
if [[ -z "$RELEASE_SHA" ]]; then
  echo "==> No --release-sha given; waiting for CI build-and-push of origin/main..."
  RELEASE_SHA="$(bash "${SCRIPT_DIR}/wait-for-build.sh" | tail -n1)"
fi

[[ "$RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo 'ERROR: could not resolve a release SHA (pass --release-sha <commit> explicitly)' >&2; exit 2; }

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

# The runtime files that must live in /opt/traderton/<env> — explicit list,
# never a blanket copy, so secrets and Terraform state are never uploaded.
RUNTIME_FILES=(
  "Caddyfile.${TRADERTON_ENV}" compose.yaml deploy-on-host.sh
  mount-data.sh backup.sh backup-job.sh backup-alert.sh backup-health.sh check-backup-success.sh
  docker-data.conf
  traderton-data.service traderton-backup.service traderton-backup-alert.service
  traderton-backup.timer traderton-backup-health.service traderton-backup-health.timer
)
[[ -f "$ENV_FILE" ]] || { echo "ERROR: $ENV_FILE not found (create from .env.environment.example)" >&2; exit 1; }

scp_args=(${SSH_OPTS})
REMOTE="root@${IP}:/opt/traderton/${TRADERTON_ENV}/"
echo "==> Uploading runtime files to ${REMOTE}"
scp "${scp_args[@]}" "${RUNTIME_FILES[@]/#/$PWD/}" "${REMOTE}"

echo "==> Uploading .env.${TRADERTON_ENV} (mode 600) to root@${IP}:/opt/traderton/${TRADERTON_ENV}/.env.${TRADERTON_ENV}"
scp "${scp_args[@]}" "$ENV_FILE" "root@${IP}:/opt/traderton/${TRADERTON_ENV}/.env.${TRADERTON_ENV}"
if [[ -f "$BACKUP_ENV_FILE" ]]; then
  echo "==> Uploading .env.backup"
  scp "${scp_args[@]}" "$BACKUP_ENV_FILE" "root@${IP}:/opt/traderton/${TRADERTON_ENV}/.env.backup"
fi

echo "==> Running on-host deploy (--confirm-${TRADERTON_ENV} ${RELEASE_SHA})"
ssh "${scp_args[@]}" "root@${IP}" \
  "cd /opt/traderton/${TRADERTON_ENV} && chmod 600 .env.${TRADERTON_ENV} && ./deploy-on-host.sh --confirm-${TRADERTON_ENV} ${RELEASE_SHA}"

# Reached only when the SSH on-host deploy exited 0 (set -e aborts otherwise).
trap - ERR
echo "==> Deploy succeeded: ${TRADERTON_ENV} is running release ${RELEASE_SHA} at https://${IP}"