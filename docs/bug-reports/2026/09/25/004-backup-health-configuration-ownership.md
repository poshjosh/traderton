# Bug Report: Backup health sourced non-root-owned configuration

- **Status:** FIXED
- **Severity:** Medium
- **Date:** 2026-09-25
- **Summary:** The health service could source a mode-600 backup environment file owned by a non-root user.

## Root Cause

Unlike the backup and alert services, the health check omitted the file-owner preflight before sourcing `.env.backup`.

## Fix

Require UID 0 ownership before sourcing, using the same mode and owner check as the other backup scripts.

## Files Changed

- `infra/hetzner/staging/backup-health.sh`
- `infra/hetzner/staging/tests/test_backup_alerts.py`

## Verification

- Python backup tests confirm a non-root-owned file is rejected before its contents run; offline shell guards and `pnpm lint` pass.