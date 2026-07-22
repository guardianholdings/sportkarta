# syntax=docker/dockerfile:1
# Multi-target build: web (Next standalone), worker (pg-boss), migrate (drizzle-kit).
# CI builds each target and pushes to GHCR; nothing is built on the VPS.

FROM node:24-alpine AS base
RUN npm install -g pnpm@11.15.1
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY db/package.json db/
COPY lib/package.json lib/
COPY scripts/import-osm/package.json scripts/import-osm/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# "worker..." also builds its workspace dependencies (@sportkarta/import-osm).
RUN pnpm --filter @sportkarta/web build && pnpm --filter "@sportkarta/worker..." build

# ── web: slim Next.js standalone runtime ─────────────────────────────────────
FROM node:24-alpine AS web
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

# ── worker: Debian runtime (osmium-tool is Debian-packaged; Alpine 3.24 dropped
# it — only libosmium remains there). Full workspace copied from the Alpine build
# stage: the worker's runtime deps are pure JS (pg, pg-boss, dotenv, drizzle,
# esbuild-bundled import-osm), so the musl→glibc move is safe, and osmium is only
# ever invoked as a runtime subprocess. Slim later if pull size hurts.
FROM node:24-bookworm-slim AS worker
WORKDIR /app
ENV NODE_ENV=production
# osmium-tool: OSM extract filtering for the import.osm job (scripts/import-osm).
RUN apt-get update \
  && apt-get install -y --no-install-recommends osmium-tool \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app /app
USER node
# Run through tsx: @sportkarta/db is consumed as TS source (exports ./src/index.ts,
# no build step) with .js import specifiers that plain `node` can't resolve — tsx
# handles the .ts loading + .js→.ts remapping, matching the rest of the monorepo.
CMD ["apps/worker/node_modules/.bin/tsx", "apps/worker/dist/index.js"]

# ── migrate: one-shot drizzle-kit runner (docker compose --profile ops) ──────
FROM build AS migrate
WORKDIR /app/db
CMD ["pnpm", "db:migrate"]
