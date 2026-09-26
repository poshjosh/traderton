# Traderton — Hetzner Infrastructure

Deployment and operations infrastructure for Traderton's external trading
boundary, provisioned on Hetzner Cloud. Traderton owns its own VM, firewall and
data volume with **no dependency on Herobids Terraform state**; the two meet
only at a URL (`TRADERTON_BOUNDARY_URL`), HMAC-authenticated over HTTPS.

This README is a reference to the directory and its entry points. For the
end-to-end runbook, follow [`docs/setup.md`](./docs/setup.md).

## What's here

| Artifact | Purpose |
| --- | --- |
| `main.tf`, `backend.tf`, `environment.tfvars.example` | Terraform: Hetzner VM, firewall, data volume; S3 remote state + DynamoDB locking. Environment selected by `--env`, which picks `<env>.tfvars`, the workspace, and state key `traderton/<env>/terraform.tfstate`. |
| `plan-apply.sh` | `init` → `workspace` → `plan` (review) → `apply`, with an interactive confirm + `--yes`. Mirrors Herobids `provision.sh`; only extra guard is a bold warning when the plan DESTROYS resources. |
| `scripts/deploy.sh` | Local helper: resolves the VM IP via `terraform output public_ip`, scp's the runtime files + `.env.staging` + `.env.backup`, then runs the on-host deploy. |
| `deploy-on-host.sh` | Runs **on the VM**: verifies host/marker, `docker login ghcr.io`, pulls and starts Postgres/Redis/boundary, applies migrations, checks readiness. |
| `compose.yaml`, `Caddyfile.staging` | Runtime stack: Postgres/Redis/boundary + Caddy TLS (port 80/443). The boundary publishes no host port — reachable only through Caddy. |
| `cloud-init.sh.tftpl` | First-boot provisioning: Docker, Compose, restic, UFW (22/80/443). |
| `backup.sh`, `backup-job.sh`, `backup-alert.sh`, `backup-health.sh`, `*.service`, `*.timer` | Daily restic backup of Postgres/Redis + SMTP alerts + freshness checks. |
| `.env.*.example` | Committed templates for `.env.terraform`, `.env.staging`, `.env.backup` (real values are gitignored). |
| `tests/` | Offline guards (`offline-guards.sh`), plus `terraform test` and Python unit tests. |

## Workflow at a glance

First time setup

- Follow the instructions in `infra/hetzner/docs/setup.md`

Routine flow

- **Image** — pushed to ghcr.io automatically on push to `main` (`.github/workflows/build-push.yml`). No manual build.
- **Deploy** — `bash scripts/deploy.sh --env staging --release-sha <sha>` (`docs/setup.md` "Phase 5").
- **Wire Herobids** — set `TRADERTON_BOUNDARY_URL` + matching HMAC creds (`docs/setup.md` "Phase 3 — Wire them together").

## Environment model

Everything is environment-driven via `--env <staging|production>`; there is no
per-environment subdirectory. The same `main.tf`/`compose.yaml`/`Caddyfile`
serve every environment, differing only through `<env>.tfvars` and the runtime
`.env.*` files. See [`docs/setup.md`](./docs/setup.md) for the exact inputs.

## Variables

See `environment.tfvars.example` for the full, commented set. Key inputs:
`environment`, `location`, `server_type`, `ssh_public_key`, `api_hostname`,
`site_hostname`, `data_volume_size_gb`.

## Local checks

Run before considering infra changes complete (no remote backend or cloud access):

```sh
terraform -chdir=infra/hetzner fmt -check
terraform -chdir=infra/hetzner validate -no-color
terraform -chdir=infra/hetzner test -no-color
bash infra/hetzner/tests/offline-guards.sh
python3 -m unittest discover -s infra/hetzner/tests -p 'test_*.py'
```

`validate`/`test` need the Hetzner provider schema; a local-only
`terraform init -backend=false` against an existing provider cache is
sufficient. Never use a remote-backend init as a substitute for an approved
infrastructure change. Offline checks do not establish real project/zone/route
compatibility — a reviewed plan and live verification remain mandatory before
any apply or deploy.
