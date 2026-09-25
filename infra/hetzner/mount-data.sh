#!/usr/bin/env bash
set -euo pipefail

device=/dev/disk/by-id/scsi-0HC_Volume_traderton-staging-data
for attempt in {1..60}; do
  [[ -b "$device" ]] && break
  sleep 2
done
[[ -b "$device" ]] || { echo 'Staging data volume is not attached' >&2; exit 1; }
[[ "$(blkid -s TYPE -o value "$device")" == ext4 ]] || { echo 'Unexpected data volume filesystem; refusing to format' >&2; exit 1; }
install -d -m 0700 /srv/traderton
uuid=$(blkid -s UUID -o value "$device")
if ! mountpoint -q /srv/traderton; then
  mount -o noatime "UUID=$uuid" /srv/traderton
fi
[[ "$(findmnt -n -o UUID /srv/traderton)" == "$uuid" ]] || { echo 'Wrong volume mounted at /srv/traderton' >&2; exit 1; }
if ! grep -q "^UUID=$uuid " /etc/fstab; then
  printf 'UUID=%s /srv/traderton ext4 noatime,nofail 0 2\n' "$uuid" >> /etc/fstab
fi
install -d -m 0700 /srv/traderton/postgres /srv/traderton/redis