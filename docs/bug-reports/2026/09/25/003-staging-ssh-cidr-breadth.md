# Bug Report: Staging SSH CIDRs allowed broad coverage

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-09-25
- **Summary:** Nonzero IPv4 CIDRs could jointly admit the entire internet to SSH.

## Root Cause

The Terraform validation and JSON guard rejected only the literal `0.0.0.0/0` network, not covering halves or other broad ranges.

## Fix

Allow only individual operator IPv4 `/32` addresses in both validation layers, and document the policy.

## Files Changed

- `infra/hetzner/staging/main.tf`
- `infra/hetzner/staging/tests/guard-plan.py`
- `infra/hetzner/staging/tests/staging-plan.tftest.hcl`
- `infra/hetzner/staging/tests/test_guard_plan.py`
- `infra/hetzner/staging/README.md`

## Verification

- Terraform tests reject covering halves and `/24`; Python guard tests reject covering halves.
- Terraform fmt and validate, offline guards, and `pnpm lint` pass.