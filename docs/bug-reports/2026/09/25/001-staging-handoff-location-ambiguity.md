# Bug Report: Staging handoff conflated server locations

- **Status:** FIXED
- **Severity:** Medium
- **Date:** 2026-09-25
- **Summary:** One free-form handoff field ambiguously described both the existing Herobids server location and the intended Traderton server location.

## Root Cause

The `network_handoff` object required only `location`, while the staging instructions asked the operator to record two potentially different locations in it. Validation could not require each location separately.

## Fix

Require nonblank `herobids_location` and `traderton_location` fields. Document their distinct sources and update the offline fixtures and rejection tests.

## Files Changed

- `infra/hetzner/staging/network-handoff.tf`
- `infra/hetzner/staging/README.md`
- `infra/hetzner/staging/tests/network-handoff.tftest.hcl`

## Verification

- Offline `terraform test -no-color`: 7 passed, 0 failed.
- `terraform fmt -check -recursive` and `terraform validate -no-color`: passed.
- `pnpm lint`: passed.

Terraform cannot establish actual project membership or network-zone compatibility; the handoff still requires operator review before any apply.