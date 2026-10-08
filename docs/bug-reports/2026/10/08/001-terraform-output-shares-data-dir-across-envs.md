# Bug Report: `terraform_output` and `plan-apply.sh` share one Terraform data dir across staging and production
- **Status:** FIXED (2026-10-08). Not committed yet. Verified offline only (see "Verification").
- **Severity:** High.
  - **Impact:**
    - On a machine whose `infra/hetzner/.terraform/` last selected one env, `scripts/deploy.sh --env <other>` aborts while resolving the VM IP. So does `plan-apply.sh --env <other>`.
    - `terraform_output` could also create a workspace in S3 as a side effect of a read.
    - The same failure aborted a herobids staging deploy on 2026-10-08.
  - **Not affected:** deployed hosts. Terraform runs only on the operator machine.
- **Date found:** 2026-10-08
- **Found via:** the herobids fix for the same pattern (herobids `docs/bug-reports/2026/10/08/005-terraform-output-init-aborts-on-stale-shared-workspace-selection.md`), followed by a review of traderton's copy. 7172f92 ported herobids bug 001's approach to traderton.
- **Components:** `infra/hetzner/scripts/_ssh_opts.sh` (`terraform_output`, sole caller `scripts/deploy.sh`), `infra/hetzner/plan-apply.sh`.

## Root cause
Both scripts ran `terraform init -reconfigure -backend-config=key=traderton/<env>/terraform.tfstate` in the shared `infra/hetzner/.terraform/`.

- The key is fixed at init time. Init also checks the workspace already selected in `.terraform/environment` against the new key's workspaces.
- After a production run, `environment` says `production`. Under the staging key that workspace does not exist, so init aborts with `Currently selected workspace "production" does not exist`.
- The operator machine is in that state now: `environment` = `production`, with the production key configured.
- So the next `deploy.sh --env staging` or `plan-apply.sh --env staging` would have hit it. In herobids, a legacy cross-keyed workspace object hid the failure until it was deleted. It is unknown whether traderton's bucket has any such objects.

Two more defects in `terraform_output`:

- **It created workspaces.** It ran `workspace select || workspace new`, copied from `plan-apply.sh` in 7172f92. A read could therefore create a workspace in S3. That dropped 90f9ff0's deliberate rule: fail and point the operator at `plan-apply.sh`.
- **Inherited `TF_WORKSPACE` / `TF_CLI_ARGS*` were honoured.** These could come from the shell or `.env.terraform`, and could redirect the workspace or inject arguments.

## Fix
- **Both scripts:**
  - Use a per-env data dir, `TF_DATA_DIR=.terraform-envs/<env>` relative to `infra/hetzner` (gitignored in `infra/hetzner/.gitignore`). It only ever holds its own env's key and selection, and the shared `.terraform/` is no longer touched.
  - Unset inherited `TF_WORKSPACE` / `TF_CLI_ARGS*` after sourcing `.env.terraform`.
- **`terraform_output`:**
  - Uses `workspace select` only.
  - A missing workspace fails with "Run plan-apply.sh --env <env> first", restoring 90f9ff0's behaviour.
  - Init failures are reported instead of being silently swallowed by `>/dev/null`.
- **`plan-apply.sh`:**
  - Keeps `select || new`, because it is the provisioning entry point.
  - Clears the per-env dir's remembered selection before init. If that workspace's state was deleted, init then cannot abort before the workspace is recreated.
- **Cost:** the first run per env installs providers into its data dir.

## Verification
- New offline test `infra/hetzner/tests/terraform-env-isolation.sh`. It uses a terraform stub that models per-key workspaces and init's selection check. It covers:
  - a staging read after a production run, then a production read in the same session
  - hostile inherited `TF_WORKSPACE` / `TF_CLI_ARGS`, from the shell and from `.env.terraform`
  - a missing workspace: no `new`, and no `output`
  - `plan-apply.sh` with an existing workspace, and with a new or reset one
- Against the HEAD scripts, 15 of the test's 21 checks fail. With the fix, all pass.
- `offline-guards.sh` passes, and now also runs `bash -n` on `_ssh_opts.sh` and the new test.
- **Not verified live.** `infra/hetzner/README.md` forbids ad-hoc remote-backend inits. Verify on the next `scripts/deploy.sh --env staging` and `plan-apply.sh` run. A first run per env downloads providers.

## Remaining gaps
- Docs elsewhere that tell operators to run raw `terraform output` in `infra/hetzner` were updated: README, `docs/setup.md` Phase 3/5. `docs/features/2026/10/01/001-minimal-public-site/002-publish-prep.md` is historical and left as-is.
- The bucket was not checked for cross-keyed workspace objects such as `env:/staging/traderton/production/...`. One such object, `env:/staging/traderton/production/terraform.tfstate` (181 B), was seen in the shared bucket listing on 2026-10-08. It is likely created by the old `select || new` against a stale key. Archive or delete it with operator approval.
