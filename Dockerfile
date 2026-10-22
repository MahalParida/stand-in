# syntax=docker/dockerfile:1
#
# Stand-In hosted demo image (spec M6): one container serves apps/mcp-server
# (/mcp, /sim/api/*, /health, /.well-known/*) and the built apps/alexa-sim page.
#
#   docker build --platform linux/amd64 -t stand-in:latest .
#
# No secrets are baked in: STANDIN_TOKEN, the OAuth client secret and the runtime
# AWS credentials are passed only as container environment at deploy time
# (scripts/deploy-lightsail.sh).

ARG NODE_IMAGE=node:22-bookworm-slim
ARG PNPM_VERSION=12.6.0
ARG COREPACK_VERSION=0.36.0

# ---------------------------------------------------------------------------
# base: Node 22 + pnpm via corepack
# ---------------------------------------------------------------------------
# hadolint ignore=DL3029
FROM --platform=linux/amd64 ${NODE_IMAGE} AS base
ARG PNPM_VERSION
ARG COREPACK_VERSION
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PNPM_HOME=/pnpm \
    CI=true
# The corepack bundled with Node 22 may predate the npm signing keys of recent
# pnpm releases, so pin a newer corepack first.
RUN npm install -g "corepack@${COREPACK_VERSION}" \
 && corepack enable \
 && corepack prepare "pnpm@${PNPM_VERSION}" --activate
WORKDIR /app

# Workspace manifests only, so dependency layers cache across source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/disclosure-guard/package.json packages/disclosure-guard/
COPY packages/providers/package.json packages/providers/
COPY apps/fake-business/package.json apps/fake-business/
COPY apps/call-agent/package.json apps/call-agent/
COPY apps/mcp-server/package.json apps/mcp-server/
COPY apps/alexa-sim/package.json apps/alexa-sim/
COPY eval/package.json eval/

# ---------------------------------------------------------------------------
# build: full install, build every workspace (incl. apps/alexa-sim/dist)
# ---------------------------------------------------------------------------
FROM base AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY eval ./eval
COPY data ./data
RUN pnpm -r build

# ---------------------------------------------------------------------------
# prod-deps: production dependencies of @standin/mcp-server and its workspace
# deps only. better-sqlite3 13 is N-API and ships a linux-x64 (glibc) addon;
# this stage runs on linux/amd64, so the addon loaded below is the one the
# runtime uses. The smoke check fails the build if it cannot load.
# ---------------------------------------------------------------------------
FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod --filter "@standin/mcp-server..."
RUN node -e "const D=require(require.resolve('better-sqlite3',{paths:['/app/packages/core']}));const db=new D(':memory:');db.prepare('select 1 as x').get();db.close();console.log('better-sqlite3 ok', process.platform, process.arch)"

# ---------------------------------------------------------------------------
# runtime: production deps + compiled output only, non-root
# ---------------------------------------------------------------------------
# hadolint ignore=DL3029
FROM --platform=linux/amd64 ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    STANDIN_MODE=offline \
    HOST=0.0.0.0 \
    PORT=8080 \
    SQLITE_PATH=/data/standin.db
WORKDIR /app

COPY --from=prod-deps --chown=root:root /app ./
COPY --from=build --chown=root:root /app/packages/core/dist ./packages/core/dist
COPY --from=build --chown=root:root /app/packages/disclosure-guard/dist ./packages/disclosure-guard/dist
COPY --from=build --chown=root:root /app/packages/providers/dist ./packages/providers/dist
COPY --from=build --chown=root:root /app/apps/fake-business/dist ./apps/fake-business/dist
COPY --from=build --chown=root:root /app/apps/call-agent/dist ./apps/call-agent/dist
COPY --from=build --chown=root:root /app/apps/mcp-server/dist ./apps/mcp-server/dist
# Alexa+ add-on icons and carousel image, served at /addon-assets/*.png.
COPY --from=build --chown=root:root /app/apps/mcp-server/assets ./apps/mcp-server/assets
COPY --from=build --chown=root:root /app/apps/alexa-sim/dist ./apps/alexa-sim/dist
# Dial allowlist, read at runtime by apps/call-agent (../../../data from dist/).
COPY --from=build --chown=root:root /app/data/business-directory.json ./data/business-directory.json

# Writable SQLite directory owned by the unprivileged `node` user (uid 1000).
# Lightsail container disk is ephemeral: the DB resets on redeploy and
# restart recovery marks interrupted calls FAILED.
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# STANDIN_MODE defaults to offline; the Lightsail deployment sets STANDIN_MODE=aws.
CMD ["node", "apps/mcp-server/dist/main.js"]
