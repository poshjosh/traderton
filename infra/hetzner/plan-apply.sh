#!/usr/bin/env bash
# plan-apply.sh — env-aware Terraform plan/review/apply with a saved-plan gate.
#
# Usage:
#   plan-apply.sh [--env <staging|production>] [--backend-env-file <path>] plan <absolute saved-plan path>
#   plan-apply.sh [--env <staging|production>] [--backend-env-file <path>] apply <absolute saved-plan path>
#
# The environment selects the <env>.tfvars var-file, the terraform workspace,
# and the S3 backend key traderton/<env>/terraform.tfstate (mirrors Herobids).
set -euo pipefail
cd "$(dirname "$0")"

ENVIRONMENT="staging"
BACKEND_ENV_FILE="${BACKEND_ENV_FILE:-${PWD}/.env.terraform}"
VAR_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      ENVIRONMENT="${2:-}"
      [[ -n "$ENVIRONMENT" ]] || { echo 'ERROR: --env requires a value' >&2; exit 2; }
      shift 2
      ;;
    --backend-env-file)
      BACKEND_ENV_FILE="${2:-}"
      [[ -n "$BACKEND_ENV_FILE" ]] || { echo 'ERROR: --backend-env-file requires a path' >&2; exit 2; }
      shift 2
      ;;
    --var-file)
      VAR_FILE="${2:-}"
      [[ -n "$VAR_FILE" ]] || { echo 'ERROR: --var-file requires a path' >&2; exit 2; }
      shift 2
      ;;
    *)
      break
      ;;
  esac
done

umask 077
if [[ $# != 2 || ( "$1" != plan && "$1" != apply ) ]]; then
  echo 'Usage: plan-apply.sh [--env <staging|production>] [--var-file <path>] [--backend-env-file <path>] plan|apply <absolute saved-plan path>' >&2
  exit 2
fi
[[ "$2" == /* ]] || { echo 'Use an absolute saved-plan path' >&2; exit 2; }
[[ "$ENVIRONMENT" =~ ^[a-z0-9_-]+$ ]] || { echo 'Invalid environment name' >&2; exit 2; }

if [[ -z "$VAR_FILE" ]]; then
  VAR_FILE="${PWD}/${ENVIRONMENT}.tfvars"
fi
if [[ "$VAR_FILE" != /* ]]; then
  VAR_FILE="${PWD}/${VAR_FILE}"
fi
[[ -f "$VAR_FILE" ]] || { echo "ERROR: ${VAR_FILE} not found" >&2; echo "Create it (e.g. from ${ENVIRONMENT}.tfvars.example)" >&2; exit 1; }

# Backend env file (S3 credentials + bucket config).
if [[ "$BACKEND_ENV_FILE" != /* ]]; then
  BACKEND_ENV_FILE="${PWD}/${BACKEND_ENV_FILE}"
fi
if [[ -f "$BACKEND_ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$BACKEND_ENV_FILE"
  set +a
fi

for command_name in terraform jq python3 sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 || { echo "ERROR: ${command_name} is required." >&2; exit 1; }
done

[[ -n "${TF_BACKEND_BUCKET:-}" ]] || { echo 'ERROR: TF_BACKEND_BUCKET is not set (source --backend-env-file or export it).' >&2; exit 1; }
TF_BACKEND_REGION="${TF_BACKEND_REGION:-us-east-1}"

# Initialize the S3 backend first (creates the `default` workspace state), then
# select/create the per-environment workspace. Order matters for a fresh
# remote backend: `terraform workspace` cannot run before `init` has set up
# the backend.
INIT_ARGS=(-input=false -reconfigure \
  "-backend-config=bucket=${TF_BACKEND_BUCKET}" \
  "-backend-config=key=traderton/${ENVIRONMENT}/terraform.tfstate" \
  "-backend-config=region=${TF_BACKEND_REGION}" \
)
if [[ -n "${TF_BACKEND_DYNAMODB_TABLE:-}" ]]; then
  INIT_ARGS+=("-backend-config=dynamodb_table=${TF_BACKEND_DYNAMODB_TABLE}")
fi
terraform init "${INIT_ARGS[@]}"
terraform workspace select "$ENVIRONMENT" 2>/dev/null || terraform workspace new "$ENVIRONMENT"

plan_file=$2
digest_file="${plan_file}.sha256"
if [[ "$1" == plan ]]; then
  [[ ! -e "$plan_file" && ! -e "$digest_file" ]] || { echo 'Saved plan or digest already exists' >&2; exit 2; }
  trap 'rm -f -- "$plan_file" "$digest_file"' ERR
  terraform plan -input=false -out="$plan_file" -no-color -var-file="$VAR_FILE" > /dev/null
else
  [[ -f "$plan_file" && -f "$digest_file" ]] || { echo 'Saved plan or digest is missing' >&2; exit 2; }
  [[ "$(sha256sum "$plan_file" | cut -d ' ' -f 1)" == "$(<"$digest_file")" ]] || { echo 'Saved plan identity changed' >&2; exit 1; }
fi
plan_json=$(mktemp)
trap 'rm -f -- "$plan_json"' EXIT
terraform show -json "$plan_file" > "$plan_json"
python3 tests/guard-plan.py "$plan_json"
if [[ "$1" == plan ]]; then
  sha256sum "$plan_file" | cut -d ' ' -f 1 > "$digest_file"
else
  [[ "$(sha256sum "$plan_file" | cut -d ' ' -f 1)" == "$(<"$digest_file")" ]] || { echo 'Saved plan identity changed during review' >&2; exit 1; }
  terraform apply -input=false -no-color "$plan_file"
fi