#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mountpoint -q /srv/traderton
temporary_dir=$(mktemp -d /srv/traderton/backup.XXXXXXXX)
trap 'rm -rf -- "$temporary_dir"' EXIT
docker compose --env-file .env.staging exec -T postgres pg_dump -U traderton -d traderton -Fc > "$temporary_dir/postgres.dump"
docker compose --env-file .env.staging exec -T redis redis-cli --rdb /data/backup.rdb > /dev/null
docker compose --env-file .env.staging cp redis:/data/backup.rdb "$temporary_dir/redis.rdb" > /dev/null
restic backup --tag traderton-staging "$temporary_dir"
restic forget --tag traderton-staging --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
touch /srv/traderton/backup-last-success