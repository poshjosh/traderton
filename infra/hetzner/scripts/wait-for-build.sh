#!/usr/bin/env bash
# wait-for-build.sh — block until the GitHub "Build and Push" workflow run for
# the given commit has COMPLETED successfully, then print the release SHA.
#
# The deploy flow is: developer pushes to `main` → the `.github/workflows/
# build-push.yml` action builds and pushes `ghcr.io/.../traderton:sha-<commit>` →
# the on-host deploy pulls that tag. This script gates the deploy on that build
# finishing, so `deploy.sh` never races a half-pushed image.
#
# The SHA is NOT discovered here — it is already known locally as the commit that
# was pushed (`git rev-parse origin/main`). This script's job is only to CONFIRM
# the matching CI run reached a terminal success. Matching by `head_sha` ensures
# we never accept a stale/other run on the same ref.
#
# Usage:
#   wait-for-build.sh [--sha <40-char SHA>]          # defaults to origin/main
#   wait-for-build.sh --repo poshjosh/traderton --sha <sha>
#
# Output: the release SHA is printed as the FINAL line on stdout (so a caller can
# capture it:  sha=$(wait-for-build.sh ... | tail -n1)).
set -euo pipefail

REPO=""
SHA=""

# Known-minimum CI duration before the first poll (see note below).
waitBeforePolling=60
POLL_INTERVAL=10

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO="${2:-}"; [[ -n "$REPO" ]] || { echo 'ERROR: --repo requires owner/repo' >&2; exit 2; }; shift 2;;
    --sha)
      SHA="${2:-}"; [[ -n "$SHA" ]] || { echo 'ERROR: --sha requires a value' >&2; exit 2; }; shift 2;;
    *)
      echo "ERROR: Unknown option: $1" >&2; exit 2;;
  esac
done

# Resolve the GitHub owner/repo from the origin remote (fall back to the known repo).
if [[ -z "$REPO" ]]; then
  REPO="$(git config --get remote.origin.url 2>/dev/null | sed -E 's#(https://|git@)github.com[:/]?##; s#\.git$##')"
  [[ -n "$REPO" ]] || { echo 'ERROR: could not resolve GitHub repo from git remote; pass --repo owner/name' >&2; exit 2; }
fi

# Resolve the target commit (the one just pushed).
if [[ -z "$SHA" ]]; then
  SHA="$(git rev-parse origin/main 2>/dev/null || true)"
  [[ -n "$SHA" ]] || { echo 'ERROR: could not resolve origin/main; pass --sha <commit>' >&2; exit 2; }
fi
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "ERROR: --sha must be a 40-character commit SHA (got '$SHA')" >&2; exit 2; }

API_URL="https://api.github.com/repos/${REPO}/actions/runs"

# A single acceptable curl base (no token for now; add -H "Authorization: Bearer
# $GH_TOKEN" later if rate limits ever bite).
curl_args=(curl -fsSL -H "Accept: application/vnd.github+json")

echo "CI build gate: repo=$REPO sha=$SHA"

# Find the workflow run for this exact commit, if one exists yet.
# Returns the run's database id, or empty if not yet listed by the API.
find_run_id() {
  "${curl_args[@]}" "${API_URL}?head_sha=${SHA}&per_page=1" 2>/dev/null \
    | sed -n 's/.*"id": \([0-9]\{1,\}\).*/\1/p' | head -n1
}

# ── waitBeforePolling — why it is a named variable, not a bare `sleep 60` ─────
# 1. It is the ONE place to tune when the build gets faster/slower (image size,
#    cache misses, runner load) — no hunting through the loop body.
# 2. It documents the assumption: CI empirically takes ~66s, so polling before
#    this point is a pure waste of (rate-limited) API calls.
# 3. It is trivially overridable via `waitBeforePolling=90 deploy.sh ...`
#    without editing the script.
# ─────────────────────────────────────────────────────────────────────────────
for ((i = 1; i <= waitBeforePolling; i++)); do
  printf 'waiting %d of %ds for build-and-push to finish...\r' "$i" "$waitBeforePolling"
  sleep 1
done
echo

# ── Poll until the run completes; print progress on one overwriting line. ────
RUN_ID=""
for ((attempt = 1; attempt <= 90; attempt++)); do
  RUN_ID="$(find_run_id || true)"
  if [[ -n "$RUN_ID" ]]; then
    status="$("${curl_args[@]}" "${API_URL}/${RUN_ID}" 2>/dev/null | sed -n 's/.*"status": "\([^"]*\)".*/\1/p' | head -n1)"
    conclusion="$("${curl_args[@]}" "${API_URL}/${RUN_ID}" 2>/dev/null | sed -n 's/.*"conclusion": "\([^"]*\)".*/\1/p' | head -n1)"

    if [[ "$status" == "completed" ]]; then
      echo
      if [[ "$conclusion" == "success" ]]; then
        echo "CI build succeeded for ${SHA}"
        echo "$SHA"
        exit 0
      fi
      echo "ERROR: CI build for ${SHA} completed with conclusion '${conclusion:-none}'" >&2
      exit 1
    fi
    printf 'polling GitHub Actions run %s (status=%s)...\r' "$RUN_ID" "${status:-queued}"
  else
    printf 'polling GitHub Actions (run not listed yet)...\r' "$attempt"
  fi
  sleep "$POLL_INTERVAL"
done

echo
echo "ERROR: timed out waiting for CI build of ${SHA}" >&2
exit 1