# Traderton useful commands

## Integration tests

### staging

```sh
# BOUNDARY_RESOLVE_IP is required when a machine's outbound DNS is broken
# (Zscaler etc.) — it pins api.staging.traderton.com to the VM IP so Node's
# fetch can reach it (mirror of `curl --resolve`). Omit it on a machine with
# working DNS.
BOUNDARY_RESOLVE_IP=2.28.19.89 scripts/shell/tests/run-live-boundary.sh --env-file infra/hetzner/.env.staging
```

### local

```sh
BOUNDARY_BASE_URL=http://localhost:8080 scripts/shell/tests/run-live-boundary.sh --env-file .env
```

## ssh into remote server

```sh
ssh -i ~/.ssh/traderton_deploy_staging_key root@2.28.19.89 \
  'cd /opt/traderton/staging && docker compose --env-file .env.staging logs --tail=80 boundary'
```  