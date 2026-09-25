#!/usr/bin/env bash
set -euo pipefail
[[ $# == 2 ]] || { echo 'Expected marker and alert command' >&2; exit 2; }
if [[ -f "$1" ]]; then
  age=$(( $(date +%s) - $(stat -c %Y "$1") ))
else
  age=-1
fi
if (( age < 0 || age > 129600 )); then
  echo 'Backup success is missing, older than 36 hours, or in the future' >&2
  bash "$2" stale
  exit 1
fi