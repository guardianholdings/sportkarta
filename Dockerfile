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

# ── worker: full workspace (simple + reliable; slim later if pull size hurts) ─
FROM build AS worker
ENV NODE_ENV=production
# osmium-tool: OSM extract filtering for the import.osm job (scripts/import-osm).
RUN apk add --no-cache osmium-tool
USER node
CMD ["node", "apps/worker/dist/index.js"]

# ── migrate: one-shot drizzle-kit runner (docker compose --profile ops) ──────
FROM build AS migrate
WORKDIR /app/db
CMD ["pnpm", "db:migrate"]
