# Bug Report: Future backup success marker appeared fresh

- **Status:** FIXED
- **Severity:** Medium
- **Date:** 2026-09-25
- **Summary:** A future-dated backup marker bypassed the freshness alert.

## Root Cause

The freshness check rejected only ages greater than 36 hours, not negative ages.

## Fix

Treat a missing marker or a negative age as stale, and document future-dated marker alerts.

## Files Changed

- `infra/hetzner/staging/check-backup-success.sh`
- `infra/hetzner/staging/tests/test_backup_alerts.py`
- `infra/hetzner/staging/README.md`

## Verification

- Python backup tests confirm future-dated markers trigger an alert; offline shell guards and `pnpm lint` pass.