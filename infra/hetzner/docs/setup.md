# Setup Infrastructure

This guide provisions and deploys a Traderton VM on Hetzner Cloud. It works for
**any environment**; substitute `<env>` with `staging` or `production`
throughout. Each environment has its own Terraform workspace, its own
`<env>.tfvars`, its own S3 state key (`traderton/<env>/terraform.tfstate`), and
its own `.env.<env>` runtime secrets file.

> Resource identifiers in `main.tf` are literally named `*.staging`
> (`hcloud_server.staging`, etc.) for historical reasons. That is only the
> Terraform address — the actual Hetzner resources are named and labelled per
> environment (`traderton-<env>`, `environment=<env>`). Do not be alarmed by the
> `.staging` suffix when provisioning production.

## Phase 0 - Prerequisites

- **Own the domain** (or have DNS access to it): e.g. `traderton.com`. You'll add A (and optionally AAAA) records later. Note that DNS changes may require access you don't have locally — if so, Phase 4 becomes a hand-off to whoever controls the zone.

- **Install the tools** if you don't have them: `terraform`, `jq`, `python3`, `docker`, `dig`, and `pnpm`. Check with `terraform -version`, `jq --version`, etc. (macOS: `brew install terraform jq python3 docker`.)

- **Get a Hetzner Cloud API token** (Hetzner Console → Security → API Tokens). You can use one token for multiple repos, if they are in the same hetzner account/project.

- **Get AWS S3 credentials** for Terraform state: an S3 bucket name, an AWS access key + secret, and a DynamoDB table (optional but recommended) name for state locking. Multiple repos can share the same bucket/table, if they use different state keys.

- **Hetzner Primary IP quota.** Each VM consumes 2 Primary IPs (one IPv4, one IPv6). If the project is near its Primary IP limit, provisioning fails with `Primary IP limit exceeded`. Free unused Primary IPs (or raise the quota) before provisioning.

## Phase 1 - Environment files

- **Create the Terraform/backend environment file.** Copy `infra/hetzner/.env.terraform.example` → `.env.terraform`, fill in the values. This file holds `HCLOUD_TOKEN` plus the S3 backend credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `TF_BACKEND_BUCKET`, `TF_BACKEND_REGION`, `TF_BACKEND_DYNAMODB_TABLE`). `plan-apply.sh` and `scripts/deploy.sh` source it automatically; you do **not** put the Hetzner token or backend creds in `*.tfvars`.

  ```sh
  cd traderton/infra/hetzner
  set -a; source .env.terraform; set +a   # if you ever need the vars in your own shell
  ```

- **Create the runtime secrets file.** Copy `infra/hetzner/.env.environment.example` → `.env.<env>` (e.g. `.env.production`) and fill in the runtime secrets. There is no `.env.<env>.example`; `.env.environment.example` is the single committed template for every environment. It carries `POSTGRES_PASSWORD`, `REDIS_URL`, `BOUNDARY_CONSUMER_ID`, `BOUNDARY_KEY_ID`, `BOUNDARY_SIGNING_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`, `NODE_ENV`, and `GHCR_USERNAME`/`GHCR_TOKEN`. Set `NODE_ENV=<env>` (the template defaults to `staging`). `scripts/deploy.sh` uploads this file to the VM as `.env.<env>` (mode 600).

- **(For deploy, Phase 5) create the backup env file.** Copy `.env.backup.example` → `.env.backup` and fill in restic/alert values. `scripts/deploy.sh` uploads it if present.

## Phase 2 - Generate deploy key and use in tfvars

### Step 1: Generate the SSH key pair (on your local machine)

Use an environment-specific key so staging and production never share a private
key:

```sh
ssh-keygen -t ed25519 -C "traderton-deploy-<env>" -f ~/.ssh/traderton_deploy_<env>_key -N ""
```

This creates:
- `~/.ssh/traderton_deploy_<env>_key`      (private — used to SSH into the VM)
- `~/.ssh/traderton_deploy_<env>_key.pub`  (public — pasted into `<env>.tfvars`)

For example, production uses `~/.ssh/traderton_deploy_production_key`.

### Step 2: Create the Terraform variables file

Copy `infra/hetzner/environment.tfvars.example` → `infra/hetzner/<env>.tfvars`,
then fill in values, including `ssh_public_key`, `api_hostname`, and
`site_hostname` for that environment.

Get the public key you generated and paste it into `<env>.tfvars` as
`ssh_public_key`:

```sh
cat ~/.ssh/traderton_deploy_<env>_key.pub
```

## Phase 3 - Provision the VM

Provision (init backend → select/create the `<env>` workspace → plan → review →
apply):

```sh
cd traderton/infra/hetzner
bash plan-apply.sh --env <env>
# review the plan output; answer 'y' to apply (or pass --yes for automation)
```

This creates (or completes) the SSH key, firewall, VM, data volume, and the
volume attachment.

**Review the plan before confirming.** On a first full provision you expect
roughly `5 to add, 0 to destroy`. On a **resumed** provision (some resources
already exist from an earlier partial apply) you'll see fewer adds and
`0 to destroy` — e.g. only `hcloud_server.staging` and
`hcloud_volume_attachment.data`. If the plan proposes to **destroy or replace**
the existing SSH key, firewall, or data volume, **stop** — the data volume has
`prevent_destroy = true` and losing it means losing Postgres/Redis data.

Get the public IP (use `-raw` to get an unquoted value you can pass to `dig`,
`scp`, etc.):

```sh
terraform output -raw public_ip
```

## Phase 4 - Setup Domain Records (A and AAAA)

DNS for `traderton.com` is managed on AWS Route 53. If you do not have Route 53
API access locally, this phase is a **hand-off**: report the exact records
below to whoever controls the zone. Do not skip it — Caddy's automatic TLS
issuance and the Phase 5 `/health/ready` check both require `api_hostname` to
resolve to the VM.

### Check who serves the zone

```sh
dig NS traderton.com +short
# ns-49.awsdns-06.com.  ns-664.awsdns-19.net.  (Route 53)
```

### Add DNS A records

Point both hostnames from `<env>.tfvars` at the Phase 3 public IP:

- `api.traderton.com`  → `A` → `<public_ip>`   (production API)
- `traderton.com`      → `A` → `<public_ip>`   (production site)

For staging the hostnames are `api.staging.traderton.com` and
`staging.traderton.com` instead.

Optional: add `AAAA` records to the VM's public IPv6
(`terraform state show hcloud_server.staging | grep ipv6_address`) if you want
IPv6.

After the records propagate, verify:

```sh
dig @8.8.8.8 api.traderton.com +short   # expect the <public_ip>
dig @8.8.8.8 traderton.com     +short
```

An empty result means the record is not yet live — TLS and the readiness check
will fail until it resolves.

## Phase 5 - Deploy

> ⚠️ **Environment support caveat (as of this writing).** The deploy scripts
> are currently **hard-wired to staging** and will NOT deploy production
> unmodified:
> - `cloud-init.sh.tftpl` always creates `/etc/traderton-staging/host-marker`
>   and `/opt/traderton/staging` regardless of `environment`, and does not set
>   the VM hostname.
> - `deploy-on-host.sh` guards on `hostname -s == traderton-staging` and
>   `/etc/traderton-staging/host-marker`, reads only `.env.staging`, writes
>   `/etc/traderton-staging/release-sha`, and accepts only `--confirm-staging`.
> - `scripts/deploy.sh` uploads to `/opt/traderton/staging/`, ships
>   `.env.staging` + `Caddyfile.staging`, and calls `--confirm-staging`.
>
> On a production VM the server hostname is `traderton-production`, so
> `deploy-on-host.sh`'s hostname guard fails and the deploy aborts before
> starting any containers. Deploying production requires first parameterising
> these scripts by `<env>` (host marker path, hostname check, env-file name,
> release-sha path, confirm flag, Caddyfile, and the `/opt/traderton/<env>`
> upload target) and adding a `Caddyfile.production`. Until that work lands,
> treat production Phase 5 as blocked. The steps below describe the intended
> env-parameterised flow.

- **Set `GHCR_USERNAME` and `GHCR_TOKEN` in `.env.<env>`** to a GitHub token with `read:packages` scope, so `deploy-on-host.sh` can `docker login ghcr.io` and pull the private image. See the "Image Build And Registry" section of `traderton/infra/hetzner/README.md`.

- **Set `NODE_ENV` correctly in `.env.<env>`** — it must be `production` for the production environment (not `staging`). `deploy-on-host.sh` hard-fails if any of these eight keys is missing or empty: `POSTGRES_PASSWORD`, `REDIS_URL`, `BOUNDARY_CONSUMER_ID`, `BOUNDARY_KEY_ID`, `BOUNDARY_SIGNING_SECRET`, `CREDENTIAL_ENCRYPTION_KEY` (64 hex chars), `GHCR_USERNAME`, and `GHCR_TOKEN` (the last two are the same credentials as the previous bullet). `NODE_ENV` itself is consumed as the config overlay, not in that hard-fail check — but it must still be correct for the environment.

- **Commit any changes, then push to main.** (If `origin/main` already contains the commit you intend to deploy, no push is needed — the image for that SHA is already built.)

- **Wait** for the build-and-push action to succeed: https://github.com/poshjosh/traderton/actions — this produces the image tag `ghcr.io/<owner>/traderton:sha-<commit>`.

- **Get the git commit full SHA** (40 hex chars):

```sh
cd /Users/chinomso.ikwuagwu/dev_ai/traderton
git rev-parse origin/main
```

- **Deploy the runtime on the VM.** From your laptop:

```sh
cd traderton/infra/hetzner
bash scripts/deploy.sh --env <env>
# or pin a known-built commit: bash scripts/deploy.sh --env <env> --release-sha <40-hex-sha>
```

It resolves the VM IP via `terraform output -raw public_ip`, copies the runtime
files + `.env.<env>` (mode 600) + `.env.backup` to `/opt/traderton/<env>` over
SSH, then runs the on-VM `./deploy-on-host.sh --confirm-<env> <sha>`.

- **Verify Traderton is up.** Once DNS resolves and Caddy has issued TLS:

```sh
curl https://api.traderton.com/health/ready -v
```

Expect HTTP 200. Before DNS is live you can bypass it with `--resolve`:

```sh
curl --resolve "api.traderton.com:443:<public_ip>" https://api.traderton.com/health/ready -v
# note: TLS will only succeed once Caddy has issued a cert, which itself needs
# public DNS pointing at the VM, so --resolve is mainly a post-DNS sanity check.
```

Optional live boundary test (staging only):

```sh
scripts/shell/tests/run-live-boundary.sh --env-file infra/hetzner/.env.staging
```
