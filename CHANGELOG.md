# Changelog

All notable changes to this project will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- infrastructure code to infra/hetzner

## 0.0.2-2026.09.24

### Changed

- Split env files by role: `.env.example` (boundary/runtime), `.env.ops.*.example` (operator/test/validator credentials). Local test/validator scripts now default to `.env.ops.dev`.
- `validate-1inch-launch.ts` emits a WARN (not FAIL) when `ONEINCH_ROUTER_ADDRESS` is unset.
- `run-extra-tests.sh` summary distinguishes executed vs skipped vs failed suites.

### Added

- Drift test coverage for the `.env.ops.*.example` twins.
- CHANGELOG.md

## 0.0.1

### Added

- initial commit
