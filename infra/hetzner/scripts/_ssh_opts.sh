# _ssh_opts.sh — Shared SSH options and environment helpers for Traderton deploy scripts.
#
# Source this file in deploy scripts to get:
#   SSH_OPTS              SSH options string for use with ssh/scp commands.
#   TRADERTON_SSH_KEY     Export for child scripts to inherit.
#   TRADERTON_ENV         Deployment environment: staging | production (default: staging).
#
# Environment variables:
#   TRADERTON_SSH_KEY     Override path to the SSH private key (optional).
#                          If unset, defaults to ~/.ssh/traderton_deploy_${TRADERTON_ENV}_key
#                          (e.g. traderton_deploy_staging_key or traderton_deploy_production_key).
#   TRADERTON_ENV         Deployment environment: staging | production (default: staging).
#
# Scripts that accept --env can call parse_env_flag() to set TRADERTON_ENV.
# When using --env, it MUST be the first argument (before any other flags).

: "${TF_DIR:="$(dirname "$(dirname "${BASH_SOURCE[0]}")")"}"
export TF_DIR

# Capture whether the user explicitly set TRADERTON_SSH_KEY before detection.
_TRADERTON_SSH_KEY_USER_SET="${TRADERTON_SSH_KEY:+1}"

resolve_ssh_key() {
  local _KEY
  if [[ "${_TRADERTON_SSH_KEY_USER_SET:-}" == "1" ]]; then
    _KEY="${TRADERTON_SSH_KEY:-}"
  else
    _KEY="${HOME}/.ssh/traderton_deploy_${TRADERTON_ENV}_key"
  fi

  SSH_OPTS="-o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new"
  if [[ -n "${_KEY}" && -f "${_KEY}" ]]; then
    SSH_OPTS="${SSH_OPTS} -i ${_KEY}"
  else
    echo "WARNING: SSH key not found at ${_KEY}. Set TRADERTON_SSH_KEY or pass --ssh-key." >&2
  fi

  export TRADERTON_SSH_KEY="${_KEY}"
}

# ─── Environment selection ────────────────────────────────────────────────

TRADERTON_ENV="${TRADERTON_ENV:-staging}"

case "${TRADERTON_ENV}" in
  staging|production) ;;
  *) echo "ERROR: Unknown TRADERTON_ENV=${TRADERTON_ENV}. Must be staging or production." >&2; exit 1 ;;
esac

export TRADERTON_ENV

# Resolve SSH key now that TRADERTON_ENV is known
resolve_ssh_key

# parse_env_flag — parse --env <name> from the current argument list.
# Call this after sourcing _ssh_opts.sh, before your own arg parsing.
# --env must appear before any other flags.
parse_env_flag() {
  TRADERTON_ENV_SHIFT=0
  local _args=("$@")
  local _i=0
  while [[ $_i -lt ${#_args[@]} ]]; do
    case "${_args[$_i]}" in
      --env)
        _i=$((_i + 1))
        if [[ $_i -ge ${#_args[@]} || -z "${_args[$_i]}" ]]; then
          echo "ERROR: --env requires a value (staging or production)." >&2
          exit 1
        fi
        TRADERTON_ENV="${_args[$_i]}"
        _i=$((_i + 1))
        ;;
      --env=*)
        TRADERTON_ENV="${_args[$_i]#*=}"
        _i=$((_i + 1))
        ;;
      *)
        break
        ;;
    esac
  done
  TRADERTON_ENV_SHIFT=$_i

  case "${TRADERTON_ENV}" in
    staging|production) ;;
    *) echo "ERROR: Unknown TRADERTON_ENV=${TRADERTON_ENV}. Must be staging or production." >&2; exit 1 ;;
  esac
  export TRADERTON_ENV
  resolve_ssh_key
}

# terraform_output — workspace-aware terraform output wrapper.
# Usage: terraform_output [-raw] <output_name>
# Runs in a subshell from TF_DIR. Each environment's state lives at a
# different S3 key (traderton/<env>/terraform.tfstate, see plan-apply.sh), so
# this must (re-)init the backend for TRADERTON_ENV before selecting the
# workspace, every call — otherwise whichever env was last plan-apply.sh'd on
# this machine is the only one visible, and the other fails with a misleading
# "workspace does not exist" error. Not cached: running init on every call is
# fine here.
# Each env uses its own TF_DATA_DIR (.terraform-envs/<env>, same as
# plan-apply.sh) instead of the shared .terraform/. `init` checks the locally
# selected workspace against the new key, so re-initing the shared dir while
# it still selected the other env aborted ("Currently selected workspace
# "production" does not exist"). Inherited TF_WORKSPACE / TF_CLI_ARGS* are
# cleared so they cannot override the selection or inject arguments.
# `workspace select` only, never `new`: a read must not
# create backend state (and `terraform output` in a missing workspace writes
# an empty state object to S3). See
# docs/bug-reports/2026/10/08/001-terraform-output-shares-data-dir-across-envs.md.
terraform_output() {
  (
    cd "${TF_DIR}" || { echo "ERROR: Cannot access terraform directory ${TF_DIR}" >&2; exit 1; }

    [[ -n "${TF_BACKEND_BUCKET:-}" ]] || { echo 'ERROR: TF_BACKEND_BUCKET is not set (source .env.terraform first).' >&2; exit 1; }
    local _tf_backend_region="${TF_BACKEND_REGION:-us-east-1}"

    local init_args=(-input=false -reconfigure
      "-backend-config=bucket=${TF_BACKEND_BUCKET}"
      "-backend-config=key=traderton/${TRADERTON_ENV}/terraform.tfstate"
      "-backend-config=region=${_tf_backend_region}"
    )
    if [[ -n "${TF_BACKEND_DYNAMODB_TABLE:-}" ]]; then
      init_args+=("-backend-config=dynamodb_table=${TF_BACKEND_DYNAMODB_TABLE}")
    fi
    # Relative to TF_DIR (we cd'ed above). Gitignored.
    export TF_DATA_DIR=".terraform-envs/${TRADERTON_ENV}"
    unset TF_WORKSPACE TF_CLI_ARGS TF_CLI_ARGS_init TF_CLI_ARGS_workspace TF_CLI_ARGS_output
    terraform init "${init_args[@]}" >/dev/null || {
      echo "ERROR: terraform init failed for backend key traderton/${TRADERTON_ENV}/terraform.tfstate (TF_DATA_DIR=${TF_DIR}/${TF_DATA_DIR})." >&2
      exit 1
    }

    terraform workspace select "${TRADERTON_ENV}" >/dev/null 2>&1 || {
      echo "ERROR: Terraform workspace '${TRADERTON_ENV}' does not exist." >&2
      echo "Run plan-apply.sh --env ${TRADERTON_ENV} first to create it." >&2
      exit 1
    }
    terraform output "$@"
  )
}