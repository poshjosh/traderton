#!/usr/bin/env bash
set -euo pipefail

# Hetzner block-storage volumes are exposed under /dev/disk/by-id/ as
# scsi-0HC_Volume_<numeric-id>. The name is not stable, so match by prefix.
device=""
for attempt in {1..60}; do
  for candidate in /dev/disk/by-id/scsi-0HC_Volume_*; do
    # Skip the raw glob if no match.
    [[ -e "$candidate" ]] || continue
    # Skip the DVD-ROM / other non-volume entries.
    [[ "$(readlink -f "$candidate")" != /dev/sr* ]] || continue
    device="$candidate"
    break
  done
  [[ -n "$device" && -b "$device" ]] && break
  device=""
  sleep 2
done
[[ -n "$device" && -b "$device" ]] || { echo 'Staging data volume is not attached' >&2; exit 1; }

# Format the volume on first use (Hetzner does not format it; automount=false).
if [[ "$(blkid -s TYPE -o value "$device")" != "ext4" ]]; then
  echo "Formatting ${device} as ext4 (first mount)"
  mkfs.ext4 -F "$device"
fi
[[ "$(blkid -s TYPE -o value "$device")" == ext4 ]] || { echo 'Unexpected data volume filesystem' >&2; exit 1; }
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