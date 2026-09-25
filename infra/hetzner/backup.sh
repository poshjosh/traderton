#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
[[ -f /etc/traderton-staging/host-marker ]] || { echo 'Not a staging host' >&2; exit 1; }
[[ $(id -u) == 0 ]] || { echo 'Run backup as root' >&2; exit 1; }
[[ -f .env.backup && $(stat -c %a .env.backup) == 600 && $(stat -c %u .env.backup) == 0 ]] || { echo 'Provide root-owned .env.backup (mode 600)' >&2; exit 1; }
set -a
source .env.backup
set +a
for key in RESTIC_REPOSITORY RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
  [[ -n "${!key:-}" ]] || { echo "Missing backup credential $key" >&2; exit 1; }
done
bash ./backup-job.sh