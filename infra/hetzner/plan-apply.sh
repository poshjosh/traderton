#!/usr/bin/env bash
# plan-apply.sh — env-aware Terraform plan/review/apply (mirrors Herobids provision.sh).
#
# Converged from the bespoke saved-plan digest gate to the Herobids convention:
# a plain `terraform plan` the operator reviews, an interactive confirm, then
# `terraform apply`. No saved-plan file, no SHA-256 digest gate, no guard-plan.py.
# The only extra safety net retained (at operator request) is a BOLD WARNING when
# the plan would DESTROY resources — it does not block, it just forces review.
#
# Usage:
#   plan-apply.sh [--env <staging|production>] [--var-file <path>] [--backend-env-file <path>] [--yes]
#
# The environment selects the <env>.tfvars var-file, the terraform workspace,
# and the S3 backend key traderton/<env>/terraform.tfstate (mirrors Herobids).
set -euo pipefail
cd "$(dirname "$0")"

ENVIRONMENT="staging"
BACKEND_ENV_FILE="${BACKEND_ENV_FILE:-${PWD}/.env.terraform}"
VAR_FILE=""
AUTO_APPROVE=false

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
    --yes|--auto-approve)
      AUTO_APPROVE=true
      shift
      ;;
    *)
      echo "ERROR: Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

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

for command_name in terraform jq; do
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

# ─── Plan (operator reviews this output) ─────────────────────────────────────
echo ""
echo "==> [${ENVIRONMENT}] Running terraform plan..."
PLAN_FILE="/tmp/traderton-${ENVIRONMENT}.tfplan"
terraform plan -input=false -no-color -var-file="$VAR_FILE" -out="$PLAN_FILE"

# ─── DELETE warning — bold, non-blocking (the only retained guard) ───────────
plan_json="$(mktemp)"
trap 'rm -f -- "$plan_json" "$PLAN_FILE"' EXIT
terraform show -json "$PLAN_FILE" > "$plan_json"
# Count resources whose action list includes "delete" and that are NOT a
# create-then-delete (delete-before-create replace is genuinely destructive).
delete_count="$(jq -r '
  [.resource_changes[]?
   | select(.change.actions | index("delete") != null)
   | select((.change.actions | index("create") | not) or
            (.change.actions | index("delete")) < (.change.actions | index("create")))
  ] | length
' "$plan_json")"

if [[ "${delete_count:-0}" != "0" ]]; then
  printf '\033[1;31m'
  echo '══════════════════════════════════════════════════════════════════'
  echo '  ⚠️  WARNING: THIS PLAN WILL DESTROY RESOURCES ⚠️'
  echo "       ${delete_count} resource(s) are being deleted or replaced."
  echo '  Review the plan above carefully before confirming.'
  echo '══════════════════════════════════════════════════════════════════'
  printf '\033[0m'
fi

# ─── Confirmation (mirrors Herobids: interactive, with --yes escape hatch) ───
if [[ "$AUTO_APPROVE" == "true" ]]; then
  echo "==> --yes/--auto-approve passed: skipping confirmation prompt."
else
  echo ""
  read -rp "Apply this plan? [y/N] " CONFIRM
  if [[ ! "$CONFIRM" =~ ^[Yy] ]]; then
    echo "Aborted. Re-run with the same arguments to apply."
    exit 0
  fi
fi

# ─── Apply ───────────────────────────────────────────────────────────────────
echo ""
echo "==> [${ENVIRONMENT}] Running terraform apply..."
if [[ "$AUTO_APPROVE" == "true" ]]; then
  terraform apply -input=false -no-color -auto-approve "$PLAN_FILE"
else
  terraform apply -input=false -no-color "$PLAN_FILE"
fi