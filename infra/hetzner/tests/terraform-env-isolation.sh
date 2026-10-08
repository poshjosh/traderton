#!/usr/bin/env bash
# terraform-env-isolation.sh — offline test: terraform_output (scripts/_ssh_opts.sh)
# and plan-apply.sh keep staging and production Terraform state apart.
#
# Runs against a terraform stub that models the S3 backend: workspaces are per
# backend key, init rejects a selected workspace the key does not have, and
# workspace commands need a prior init in the same data dir. No network, no
# real Terraform. See
# docs/bug-reports/2026/10/08/001-terraform-output-shares-data-dir-across-envs.md.
#
# Run: bash infra/hetzner/tests/terraform-env-isolation.sh
set -euo pipefail

HETZNER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
WORK="$(cd "$WORK" && pwd)"

MOCK_TF_DIR="${WORK}/infra"
MOCK_BIN="${WORK}/bin"
export TF_MOCK_STATE="${WORK}/s3"
export TF_MOCK_CALLS="${WORK}/terraform-calls"
mkdir -p "${MOCK_TF_DIR}" "${MOCK_BIN}"
cp "${HETZNER_DIR}/plan-apply.sh" "${MOCK_TF_DIR}/"
: > "${MOCK_TF_DIR}/staging.tfvars"
: > "${WORK}/ssh-key"
# The backend env file must not be able to reintroduce a workspace override.
printf 'TF_BACKEND_BUCKET=test-bucket\nTF_BACKEND_REGION=eu-central-1\nTF_WORKSPACE=production\n' > "${MOCK_TF_DIR}/.env.terraform"

cat > "${MOCK_BIN}/terraform" <<'STUB'
#!/usr/bin/env bash
data_dir="${TF_DATA_DIR:-.terraform}"
echo "tf[${data_dir}] $*" >> "${TF_MOCK_CALLS}"
[[ -z "${TF_WORKSPACE:-}${TF_CLI_ARGS:-}" ]] || echo "LEAK TF_WORKSPACE='${TF_WORKSPACE:-}' TF_CLI_ARGS='${TF_CLI_ARGS:-}'" >> "${TF_MOCK_CALLS}"
selected="${TF_WORKSPACE:-$(cat "${data_dir}/environment" 2>/dev/null || echo default)}"
key="$(cat "${data_dir}/key" 2>/dev/null || true)"
ws_file() { printf '%s/%s.workspaces' "${TF_MOCK_STATE}" "${1//\//_}"; }
has_ws() { [[ "$2" == "default" ]] || grep -qx "$2" "$(ws_file "$1")" 2>/dev/null; }
need_init() { [[ -n "${key}" ]] || { echo "Error: Backend initialization required" >&2; exit 1; }; }
case "$1" in
  init)
    for a in "$@"; do [[ "$a" == -backend-config=key=* ]] && key="${a#-backend-config=key=}"; done
    has_ws "${key}" "${selected}" || { echo "Error: Currently selected workspace \"${selected}\" does not exist" >&2; exit 1; }
    mkdir -p "${data_dir}"; printf '%s' "${key}" > "${data_dir}/key" ;;
  workspace)
    need_init
    case "$2" in
      select)
        has_ws "${key}" "$3" || { echo "Error: workspace \"$3\" doesn't exist" >&2; exit 1; }
        printf '%s' "$3" > "${data_dir}/environment" ;;
      new)
        echo "$3" >> "$(ws_file "${key}")"
        printf '%s' "$3" > "${data_dir}/environment" ;;
    esac ;;
  output)
    need_init
    has_ws "${key}" "${selected}" && [[ "${selected}" != "default" ]] || { echo "Error: output from workspace '${selected}'" >&2; exit 1; }
    printf '203.0.113.%s' "$([[ "${key}" == traderton/staging/* ]] && echo 10 || echo 20)" ;;
  plan)
    need_init
    echo "ran plan key=${key} workspace=${selected}" >> "${TF_MOCK_CALLS}" ;;
  show) echo '{"resource_changes":[]}' ;;
  apply)
    need_init
    echo "ran apply key=${key} workspace=${selected}" >> "${TF_MOCK_CALLS}" ;;
esac
exit 0
STUB
chmod +x "${MOCK_BIN}/terraform"

FAILED=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1" >&2; FAILED=1; }
check() { local desc="$1"; shift; if "$@"; then pass "$desc"; else fail "$desc"; fi; }
calls_contain() { grep -Fq -- "$1" "${TF_MOCK_CALLS}"; }
calls_only_in() { ! grep '^tf\[' "${TF_MOCK_CALLS}" | grep -qv "^tf\[$1\] "; }

# reset_state — staging exists under the staging key, production under the
# production key; the shared .terraform/ still selects production (as after a
# production deploy).
reset_state() {
  rm -rf "${TF_MOCK_STATE}" "${MOCK_TF_DIR}/.terraform" "${MOCK_TF_DIR}/.terraform-envs"
  mkdir -p "${TF_MOCK_STATE}" "${MOCK_TF_DIR}/.terraform"
  echo staging > "${TF_MOCK_STATE}/traderton_staging_terraform.tfstate.workspaces"
  echo production > "${TF_MOCK_STATE}/traderton_production_terraform.tfstate.workspaces"
  printf 'production' > "${MOCK_TF_DIR}/.terraform/environment"
  printf 'traderton/production/terraform.tfstate' > "${MOCK_TF_DIR}/.terraform/key"
  : > "${TF_MOCK_CALLS}"
}

# run_output <env> — terraform_output -raw public_ip, with hostile inherited env.
run_output() {
  RUN_EXIT=0
  RUN_OUTPUT="$(env -u TF_DATA_DIR -u TF_BACKEND_DYNAMODB_TABLE \
    PATH="${MOCK_BIN}:${PATH}" TF_DIR="${MOCK_TF_DIR}" TRADERTON_ENV="$1" TRADERTON_SSH_KEY="${WORK}/ssh-key" \
    TF_BACKEND_BUCKET=test-bucket TF_BACKEND_REGION=eu-central-1 TF_WORKSPACE=production TF_CLI_ARGS=-lock=false \
    bash -c 'source "$0"; terraform_output -raw public_ip' "${HETZNER_DIR}/scripts/_ssh_opts.sh" 2>&1)" || RUN_EXIT=$?
}

run_plan_apply() {
  RUN_EXIT=0
  RUN_OUTPUT="$(env -u TF_DATA_DIR -u TF_BACKEND_DYNAMODB_TABLE \
    PATH="${MOCK_BIN}:${PATH}" TF_WORKSPACE=production TF_CLI_ARGS=-lock=false \
    bash "${MOCK_TF_DIR}/plan-apply.sh" "$@" </dev/null 2>&1)" || RUN_EXIT=$?
}

echo "terraform_output"
reset_state
run_output staging
check "staging read after a production run succeeds" [ "${RUN_EXIT}" = 0 ]
check "returns staging's output" [ "${RUN_OUTPUT}" = "203.0.113.10" ]
check "runs only in .terraform-envs/staging" calls_only_in ".terraform-envs/staging"
check "inherited TF_WORKSPACE/TF_CLI_ARGS never reach terraform" bash -c '! grep -q LEAK "$0"' "${TF_MOCK_CALLS}"
check "shared .terraform/ is left untouched" [ "$(cat "${MOCK_TF_DIR}/.terraform/environment")" = "production" ]

: > "${TF_MOCK_CALLS}"
run_output production
check "production read in the same session returns production's output" [ "${RUN_OUTPUT}" = "203.0.113.20" ]
check "production read runs only in .terraform-envs/production" calls_only_in ".terraform-envs/production"

reset_state
: > "${TF_MOCK_STATE}/traderton_staging_terraform.tfstate.workspaces"
run_output staging
check "missing workspace: exits non-zero" [ "${RUN_EXIT}" != 0 ]
check "missing workspace: points at plan-apply.sh" grep -Fq 'Run plan-apply.sh --env staging' <<<"${RUN_OUTPUT}"
check "missing workspace: never creates it" bash -c '! grep -Fq "workspace new" "$0"' "${TF_MOCK_CALLS}"
check "missing workspace: never runs output" bash -c '! grep -Fq "] output " "$0"' "${TF_MOCK_CALLS}"

echo "plan-apply.sh"
reset_state
run_plan_apply --env staging --yes
check "staging plan/apply after a production run succeeds" [ "${RUN_EXIT}" = 0 ]
check "runs only in .terraform-envs/staging" calls_only_in ".terraform-envs/staging"
check "first call is init of the staging key" bash -c 'grep -m1 "^tf\[" "$0" | grep -Fq "init -input=false -reconfigure -backend-config=bucket=test-bucket -backend-config=key=traderton/staging/terraform.tfstate"' "${TF_MOCK_CALLS}"
check "applies the staging key + workspace" calls_contain "ran apply key=traderton/staging/terraform.tfstate workspace=staging"
check "does not create an existing workspace" bash -c '! grep -Fq "workspace new" "$0"' "${TF_MOCK_CALLS}"
check "inherited TF_WORKSPACE/TF_CLI_ARGS (shell or backend file) never reach terraform" bash -c '! grep -q LEAK "$0"' "${TF_MOCK_CALLS}"
check "shared .terraform/ is left untouched" [ "$(cat "${MOCK_TF_DIR}/.terraform/environment")" = "production" ]

reset_state
: > "${TF_MOCK_STATE}/traderton_staging_terraform.tfstate.workspaces"
mkdir -p "${MOCK_TF_DIR}/.terraform-envs/staging"
printf 'staging' > "${MOCK_TF_DIR}/.terraform-envs/staging/environment"
run_plan_apply --env staging --yes
check "new or reset environment: succeeds even with a remembered selection" [ "${RUN_EXIT}" = 0 ]
check "new or reset environment: creates the workspace under the staging key" [ "$(cat "${TF_MOCK_STATE}/traderton_staging_terraform.tfstate.workspaces")" = "staging" ]
check "new or reset environment: production key unchanged (no cross-keyed workspace)" [ "$(cat "${TF_MOCK_STATE}/traderton_production_terraform.tfstate.workspaces")" = "production" ]

if [[ "${FAILED}" != 0 ]]; then
  echo "Terraform env isolation tests FAILED" >&2
  echo "--- last terraform calls ---" >&2
  cat "${TF_MOCK_CALLS}" >&2
  exit 1
fi
echo "Terraform env isolation tests passed"
