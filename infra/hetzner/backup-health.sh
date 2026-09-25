#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
[[ $(id -u) == 0 && -f /etc/traderton-staging/host-marker ]] || { echo 'Not the staging root' >&2; exit 1; }
[[ -f .env.backup && $(stat -c %a .env.backup) == 600 && $(stat -c %u .env.backup) == 0 ]] || { echo 'Provide root-owned .env.backup (mode 600)' >&2; exit 1; }
set -a
source .env.backup
set +a
mountpoint -q /srv/traderton || { echo 'Data volume is not mounted' >&2; bash ./backup-alert.sh stale; exit 1; }
bash ./check-backup-success.sh /srv/traderton/backup-last-success ./backup-alert.sh