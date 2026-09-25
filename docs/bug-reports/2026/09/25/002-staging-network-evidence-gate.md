# Bug Report: Staging plan network identity was self-checked

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-09-25
- **Summary:** A saved plan could change both its handoff and attachment network IDs without failing the guard.

## Root Cause

The guard compared the attachment only to a variable in the same plan; it had no independently reviewed Herobids identity to compare against.

## Fix

Require an approved, separately supplied Herobids evidence JSON with reviewer and source reference; compare network ID, subnet and caller identities at plan and apply time. Document the external approval and file-integrity requirement.

## Files Changed

- `infra/hetzner/staging/tests/guard-plan.py`
- `infra/hetzner/staging/plan-apply.sh`
- `infra/hetzner/staging/tests/test_guard_plan.py`
- `infra/hetzner/staging/README.md`

## Verification

- Python staging tests pass, including same-plan ID tampering and apply rejection with absent evidence.
- Terraform fmt, validate and tests, offline guards, and `pnpm lint` pass.

The JSON flag does not authenticate the reviewer; protect and approve the record outside the plan workflow.