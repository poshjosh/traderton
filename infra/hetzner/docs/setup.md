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

**Create the Terraform variables file.** Copy `infra/hetzner/environment.tfvars.example` → `infra/hetzner/staging.tfvars`, then fill in values, including `ssh_public_key`.

## Phase 3

3. **Provision the VM** (plan, review, then apply):

```sh
cd traderton/infra/hetzner
bash plan-apply.sh --env staging
# review the plan output; answer 'y' to apply (or pass --yes for automation)
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

## Phase 5 - Deploy

 - **Set `GHCR_USERNAME` and `GHCR_TOKEN` in `.env.staging`** to a GitHub token with `read:packages` scope, so `deploy-on-host.sh` can `docker login ghcr.io` and pull the private image. See the "Image Build And Registry" section of `traderton/infra/hetzner/README.md`.
 
 - **Commit any changes, then push to main.** 
 
 - **Wait** After pushing to main, wait till the build-and-push action is successful, see: https://github.com/poshjosh/traderton/actions - this produces a new commit SHA and a new image digest.

 - **Get the git commit full SHA** (40 hex chars) using the below script:

```sh
cd /Users/chinomso.ikwuagwu/dev_ai/traderton
git rev-parse origin/main
```


- **Deploy the runtime on the VM.** From your laptop, run the local helper script:

```sh
cd traderton/infra/hetzner
bash scripts/deploy.sh --env staging
```

It resolves the VM IP via `terraform_output -raw public_ip`, copies the runtime files + `.env.staging` (mode 600) + `.env.backup` to `/opt/traderton/staging` over SSH, then runs the on-VM `./deploy-on-host.sh --confirm-staging <sha>`.

- **Verify Traderton is up**: 

```sh
curl --resolve 'api.staging.traderton.com:443:2.28.19.89' https://api.staging.traderton.com/health/ready -v
```

`https://api.staging.traderton.com/health/ready` should return HTTP 200.

Test if need (staging only)

```sh
scripts/shell/tests/run-live-boundary.sh --env-file infra/hetzner/.env.staging
```