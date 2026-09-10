# AUTHORED (Phase 9b item F2c) — the boundary process image (the M2 REST
# consumer boundary, @traderton/boundary). Multi-stage pnpm-workspace build:
# install → build all packages → run `node packages/boundary/dist/bin.js`.
#
# This is ops scaffolding (the durable F artifact), not trading behaviour. The
# same image also runs `pnpm --filter @traderton/db db:migrate` for the compose
# migrate step (see docker-compose.yml).

FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# ── Dependencies + build ──────────────────────────────────────────────────────
FROM base AS build
# Copy the workspace manifests first for a cached install layer.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
# The root tsconfigs the per-package tsconfigs extend (`../../tsconfig.base.json`)
# — without these, tsc falls back to pre-ES2015 defaults and the build fails.
COPY tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY config ./config
RUN pnpm install --frozen-lockfile
RUN pnpm -r run build

# ── Runtime ────────────────────────────────────────────────────────────────────
# Keep the full workspace (dev deps included) so `drizzle-kit migrate` is
# available for the compose migrate step and the boundary can resolve its
# workspace deps. Minimal-footprint pruning is a later optimisation, not an F2c
# concern.
FROM build AS runtime
ENV NODE_ENV=production
# The boundary listens on BOUNDARY_PORT (default 8080); compose maps it.
EXPOSE 8080
CMD ["node", "packages/boundary/dist/bin.js"]
