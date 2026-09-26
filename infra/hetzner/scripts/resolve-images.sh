#!/usr/bin/env bash
# resolve-images.sh — print the three digest-pinned image values for .env.staging.
#
# 1. Pulls postgres:16 and prints POSTGRES_IMAGE (image:tag@sha256:<digest>).
# 2. Pulls redis:7 and prints REDIS_IMAGE (image:tag@sha256:<digest>).
# 3. Asks for the boundary release SHA, pulls the built boundary image from
#    ghcr.io, and prints the BOUNDARY_DIGEST (just sha256:<digest>).
#
# Usage:
#   resolve-images.sh [--env-file <path>] [--release-sha <40-char SHA>]
#
# If --release-sha is omitted, it is prompted for. The ghcr.io owner is read
# from GHCR_USERNAME in the env file (defaults to poshjosh).
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="${PWD}/.env.staging"
RELEASE_SHA=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      ENV_FILE="${2:-}"; [[ -n "$ENV_FILE" ]] || { echo 'ERROR: --env-file requires a path' >&2; exit 2; }; shift 2;;
    --release-sha)
      RELEASE_SHA="${2:-}"; [[ -n "$RELEASE_SHA" ]] || { echo 'ERROR: --release-sha requires a value' >&2; exit 2; }; shift 2;;
    *)
      echo "ERROR: Unknown option: $1" >&2; exit 2;;
  esac
done

command -v docker >/dev/null 2>&1 || { echo 'ERROR: docker is required.' >&2; exit 1; }

# Resolve the ghcr.io owner from the env file (GHCR_USERNAME), falling back to poshjosh.
GHCR_OWNER="poshjosh"
if [[ -f "$ENV_FILE" ]]; then
  owner=$(sed -n 's/^GHCR_USERNAME=//p' "$ENV_FILE" | head -n1 | tr -d '\r')
  [[ -n "$owner" ]] && GHCR_OWNER="$owner"
fi

echo '============================================================='
echo 'POSTGRES_IMAGE'
echo '============================================================='
docker pull postgres:16
echo
POSTGRES_REF="postgres:16@$(docker inspect --format='{{index .RepoDigests 0}}' postgres:16 | sed 's/.*@//')"
echo "POSTGRES_IMAGE=${POSTGRES_REF}"

echo
echo '============================================================='
echo 'REDIS_IMAGE'
echo '============================================================='
docker pull redis:7
echo
REDIS_REF="redis:7@$(docker inspect --format='{{index .RepoDigests 0}}' redis:7 | sed 's/.*@//')"
echo "REDIS_IMAGE=${REDIS_REF}"

# Prompt for the boundary release SHA if not provided.
if [[ -z "$RELEASE_SHA" ]]; then
  echo
  echo '============================================================='
  echo 'BOUNDARY_DIGEST — need the boundary release SHA'
  echo '============================================================='
  echo 'The boundary image is built and pushed by .github/workflows/build-push.yml'
  echo 'on every push to main, tagged ghcr.io/<owner>/traderton:sha-<40-char-commit>'
  echo 'The SHA is the full git commit SHA: run `git rev-parse origin/main`.'
  echo
  read -rp 'Paste the 40-character release SHA: ' RELEASE_SHA
fi
[[ "$RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "ERROR: release SHA must be 40 lowercase hex chars, got '$RELEASE_SHA'" >&2; exit 2; }

BOUNDARY_REF="ghcr.io/${GHCR_OWNER}/traderton:sha-${RELEASE_SHA}"
echo
echo '============================================================='
echo 'BOUNDARY_DIGEST'
echo '============================================================='
echo "Pulling ${BOUNDARY_REF} (linux/amd64) ..."
# The build-push workflow runs on amd64 runners, so the image only has an amd64
# manifest. Pull explicitly for that platform (works even on Apple Silicon).
docker pull --platform linux/amd64 "$BOUNDARY_REF"
echo
full_ref=$(docker inspect --format='{{index .RepoDigests 0}}' "$BOUNDARY_REF")
# Extract the digest: everything after the last '@'.
digest="sha256:${full_ref##*@sha256:}"
echo "Full image reference: ${full_ref}"
echo
echo "The part AFTER the last '@' is the digest. Use it WITH the sha256: prefix:"
echo
echo "BOUNDARY_DIGEST=${digest}"

echo
echo '============================================================='
echo 'WHERE TO PUT THESE'
echo '============================================================='
echo "All three values go in ${ENV_FILE}:"
echo "  POSTGRES_IMAGE=<postgres ref above>        (full image:tag@sha256:...) "
echo "  REDIS_IMAGE=<redis ref above>              (full image:tag@sha256:...) "
echo "  BOUNDARY_DIGEST=sha256:<64-hex digest>     (digest only, no repo/tag)  "
echo
echo 'POSTGRES_IMAGE and REDIS_IMAGE are the FULL refs (image:tag@sha256:...).'
echo 'BOUNDARY_DIGEST is only the sha256:<hex> part — the rest (ghcr.io owner,'
echo 'repository, and the :sha-<release> tag) is derived at deploy time from'
echo 'GHCR_USERNAME + the --release-sha argument to scripts/deploy.sh.'
echo
echo 'After filling them in, deploy with:'
echo "  bash scripts/deploy.sh --env staging --release-sha ${RELEASE_SHA}"