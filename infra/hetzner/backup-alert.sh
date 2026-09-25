#!/usr/bin/env bash
# backup-alert.sh — send a Traderton staging backup alert via email (SMTP),
# mirroring herobids infra/hetzner/scripts/alert-common.sh + send-alert.sh.
#
# The same conventions as Herobids are reused: SMTP relay via a local sendmail
# or mail/mailx binary, configured with ALERT_FROM / ALERT_TO and the standard
# ALERT_SMTP_* environment. No HTTPS webhook. On failure or missing
# configuration the alert degrades to a daemon-error syslog line instead.
set -euo pipefail
cd "$(dirname "$0")"

if [[ $# != 1 || ( "$1" != failed && "$1" != stale ) ]]; then
  echo 'Usage: backup-alert.sh failed|stale' >&2
  exit 2
fi
kind=$1

# Read optional notification config from the backup env file if present and
# root-owned (mode 600); the SMTP_* and ALERT_* keys are the same operator
# contract Herobids uses for send-alert.sh. Missing file is not fatal — the
# alert still degrades to logger.
if [[ -f .env.backup ]]; then
  if [[ $(stat -c %a .env.backup) != 600 || $(stat -c %u .env.backup) != 0 ]]; then
    logger -p daemon.err -t traderton-backup 'Staging backup alert: env.backup not root-owned mode 600'
    exit 1
  fi
  set -a
  # shellcheck source=/dev/null
  source .env.backup
  set +a
fi

ALERT_FROM="${ALERT_FROM:-traderton-staging@localhost}"
ALERT_TO="${ALERT_TO:-}"
subject="Traderton staging backup ${kind}"
body="Traderton staging backup ${kind}. Host: $(hostname -s). Time: $(date -u +"%Y-%m-%dT%H:%M:%SZ")."

if [[ -z "${ALERT_TO:-}" ]]; then
  logger -p daemon.err -t traderton-backup "Staging backup ${kind}: ALERT_TO not configured"
  exit 1
fi

if command -v sendmail &>/dev/null; then
  if sendmail -t <<EOF
From: ${ALERT_FROM}
To: ${ALERT_TO}
Subject: ${subject}
Content-Type: text/plain; charset=utf-8

${body}
EOF
  then
    exit 0
  fi
  logger -p daemon.err -t traderton-backup "Staging backup ${kind}: sendmail delivery failed"
fi

if command -v mail &>/dev/null; then
  if mail -s "${subject}" "${ALERT_TO}" <<< "${body}"; then exit 0; fi
fi
if command -v mailx &>/dev/null; then
  if mailx -s "${subject}" "${ALERT_TO}" <<< "${body}"; then exit 0; fi
fi

logger -p daemon.err -t traderton-backup "Staging backup ${kind}: no sendmail/mail available"
exit 1