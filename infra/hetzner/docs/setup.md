# Setup Infrastructure

## Phase 0 - Prerequisites

- **Own the domain** (or have DNS access to it): e.g. `traderton.com`. You'll add A (and optionally AAAA records) later.

- **Install the tools** if you don't have them: `terraform`, `jq`, `python3`, `docker`, `dig`, and `pnpm`. Check with `terraform -version`, `jq --version`, etc. (macOS: `brew install terraform jq python3 docker`.)

- **Get a Hetzner Cloud API token** (Hetzner Console → Security → API Tokens). You can use one token for multiple repos, if they are in the same hetzner account/project.

- **Get AWS S3 credentials** for Terraform state: an S3 bucket name, an AWS access key + secret, and a DynamoDB table (optional but recommended) name for state locking. Multiple repos can share the same bucket/table, if they use different state keys.

## Phase 1 - Environment files

- **Create the backend environment file.** Copy `infra/hetzner/.env.backend.example` → `.env.backend`, fill in the values.

## Phase 2 - Generate deploy key and use in tfvars

### Step 1: Generate the SSH key pair (on your local machine)

```sh
ssh-keygen -t ed25519 -C "traderton-deploy-staging" -f ~/.ssh/traderton_deploy_staging_key -N ""
```

This creates:
- `~/.ssh/traderton_deploy_staging_key` 
- `~/.ssh/traderton_deploy_staging_key.pub` 

You'll paste the **public** key (`.pub`) into Traderton's tfvars, and use the **private** key to SSH into the VM.

### Step 2

**Create the Terraform variables file.** Copy `infra/hetzner/staging.tfvars.example` → `infra/hetzner/staging.tfvars`, then fill in values, including `ssh_public_key`.

for `ssh_source_cidrs`, get your real public IPv4 as a /32 by running the following command:

```sh
curl -4 ifconfig.co
# example output
# 136.226.170.119
```

use the value like this:

```tfvars
ssh_source_cidrs = [
  "136.226.170.119/32",
]
```

## Phase 3

3. **Provision the VM** (plan first, review, then apply):

```sh
cd traderton/infra/hetzner
bash plan-apply.sh --env staging plan ~/traderton-staging.tfplan
# review the plan, then:
bash plan-apply.sh --env staging apply ~/traderton-staging.tfplan
```

This creates the VM, firewall, and data volume. Get the public IP with `terraform output public_ip`.

## Phase 4 - Setup Domain Records (A and AAAA)

### Check your domain `dig NS <domain> +short`

```sh
dig NS traderton.com +short
# Example output
# ns-49.awsdns-06.com.
# ns-664.awsdns-19.net.
# ns-1429.awsdns-50.org.
# ns-1587.awsdns-06.co.uk.
```

### Add DNS A records

Example:
- `staging.traderton.com` → `A` → `<server_ipv4>`
- `api.staging.traderton.com` → `A` → `<server_ipv4>`

Optional:
- add an `AAAA` record too if you want IPv6 and your server has a public IPv6

You do **not** need another `NS` record for `staging`.

After adding it, test with:
```sh
dig @8.8.8.8 staging.traderton.com +short
# expected output format
# 2.28.19.89 -> staging
```

For AAAA record
```sh
dig @8.8.8.8 AAAA staging.traderton.com +short
```

## Phase 5

- **Deploy the runtime on the VM.** From your laptop, run the local helper script:

```sh
cd traderton/infra/hetzner
bash scripts/deploy.sh --env staging --release-sha <full-release-sha_40-chars>
```

  It resolves the VM IP via `terraform output public_ip`, copies the runtime files + `.env.staging` (mode 600) + `.env.backup` to `/opt/traderton/staging` over SSH, then runs the on-VM `./deploy.sh --confirm-staging <sha>`.

   - **Before deploying, the boundary image must exist in ghcr.io.** The `.github/workflows/build-push.yml` workflow builds and pushes it automatically on every push to `main` (tag `ghcr.io/<owner>/traderton:sha-<40-char-sha>`). No manual build/push needed.
   - **Set `GHCR_USERNAME` and `GHCR_TOKEN` in `.env.staging`** to a GitHub token with `read:packages` scope, so `deploy.sh` can `docker login ghcr.io` and pull the private image. See the "Image Build And Registry" section of `traderton/infra/hetzner/README.md`.

- **Verify Traderton is up**: `https://api.staging.traderton.com/health/ready` should return HTTP 200.

=============

## Phase 2 — Herobids

1. **Create the Terraform variables file.** Copy `herobids/infra/hetzner/remote.tfvars.example` → `staging.tfvars`, fill in `hcloud_token`, `ssh_public_key_path`, `deploy_ssh_private_key`, `git_repo_url`, `app_domain = "staging.openaidom.com"`, `environment = "staging"`. See `herobids/infra/hetzner/remote.tfvars.example`.

2. **Create the backend credentials file.** Copy `herobids/infra/hetzner/.env.backend.example` → `.env.backend`, fill in the same S3 bucket/credentials from Phase 0 step 3.

3. **Provision the staging server.** Follow the "Staging" section of `herobids/infra/hetzner/README.md` (the `./scripts/provision.sh --env staging --var-file staging.tfvars` flow).

4. **Create the app env file.** Copy `herobids/.env.example` → `.env.staging`, fill in staging-safe secrets (JWT, OAuth, LLM keys, mock billing). See `herobids/.env.example`.

5. **Deploy.** Follow the "Staging" section of `herobids/infra/hetzner/README.md`: `./scripts/setup-env.sh --env staging --file .env.staging` then `./deploy.sh --env staging --env-file .env.staging`.

6. **Seed an admin user** (one-time): `ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=... ./scripts/seed-admin.sh --env staging`.

7. **Add DNS** for Herobids: point `staging.openaidom.com` (A record) at the Herobids staging server IP.

8. **Run the smoke test.** Follow `herobids/infra/hetzner/scripts/smoke-test.sh --env staging` and the runbook at `herobids/docs/runbooks/staging-smoke-test.md`.

---

## Phase 3 — Wire them together

1. **Point Herobids at Traderton.** In Herobids' `.env.staging` (both API and worker), set `TRADERTON_BOUNDARY_URL=https://api.staging.traderton.com` and matching HMAC values (`BOUNDARY_CONSUMER_ID`, `BOUNDARY_KEY_ID`, `BOUNDARY_SIGNING_SECRET`) that match what you put in Traderton's `.env.staging`. See the "For that later live validation" section of `traderton/infra/hetzner/README.md`.

2. **Verify the handoff**: from a running Herobids container, `curl https://api.staging.traderton.com/health/ready` → 200, and confirm an unsigned call returns `authentication.invalid_caller`.
