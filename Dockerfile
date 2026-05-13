# syntax=docker/dockerfile:1.7
#
# Agent OS container image.
#
# Two-stage build:
#   1. `build`   - install full deps (incl. native toolchain) and compile TS -> dist/.
#   2. `runtime` - copy compiled artifacts + production deps onto a slim base.
#
# The container runs the `agent-os` CLI (entrypoint). The workspace
# (config, agents, workflows, evals, SQLite DB) lives under /data and is
# intended to be a mounted volume so the image itself stays stateless.
#
# See docs/deployment.md for usage.

# ---- Stage 1: build ----
FROM node:20-bookworm-slim AS build
WORKDIR /app

# System deps needed to compile better-sqlite3 from source.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
    && rm -rf /var/lib/apt/lists/*

# Install deps first so this layer is cacheable across source-only edits.
# .npmrc pins `legacy-peer-deps=true` (zod v3/v4 split, per Phase 14 Bundle A).
COPY package.json package-lock.json .npmrc ./
# Workspaces are declared in the root package.json; copy each workspace
# package.json so `npm ci` can resolve the workspace graph even when we
# skip installing workspace deps with --workspaces=false.
COPY web/package.json ./web/package.json
RUN npm ci --workspaces=false --include-workspace-root \
      && npm rebuild better-sqlite3

# Copy sources and compile.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Stage 2: runtime ----
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV AGENT_OS_WORKSPACE=/data

# Install production deps only. better-sqlite3 ships a prebuilt for
# linux-x64/arm64 on most Node 20 images, but we rebuild defensively in
# case the prebuilt is missing for the current arch. tini runs as PID 1
# so child processes (spawned `node`, MCP servers, etc.) reap correctly.
COPY --from=build /app/package.json /app/package-lock.json /app/.npmrc ./
COPY --from=build /app/web/package.json ./web/package.json
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ tini \
    && npm ci --omit=dev --workspaces=false --include-workspace-root \
    && npm rebuild better-sqlite3 \
    && apt-get purge -y python3 make g++ \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* \
    && npm cache clean --force

# Copy compiled output and workspace defaults that ship inside the image.
# Users override these by bind-mounting their own /data with replacements.
COPY --from=build /app/dist ./dist
COPY agent-os.config.yaml ./agent-os.config.yaml
COPY agents ./agents
COPY workflows ./workflows
COPY evals ./evals

# Run as a non-root user. Bind-mounted volumes must be writable by uid 10001
# (see docs/deployment.md "Non-root user" for the chown gotcha).
RUN useradd --create-home --uid 10001 agent \
      && mkdir -p /data \
      && chown -R agent:agent /app /data
USER agent

VOLUME ["/data"]
WORKDIR /data

# Default invocation: `docker run agent-os` runs the health check.
# Override with `docker run agent-os run <agent> "<prompt>"`, etc.
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/dist/cli/index.js"]
CMD ["doctor"]
