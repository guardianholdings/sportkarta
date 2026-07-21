#!/usr/bin/env bash
# Destroys the LOCAL dev database volume and rebuilds it: fresh Postgres,
# migrations, seed. Never touches anything remote.
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose -f compose.dev.yml rm -sf db
docker volume rm -f sportkarta_dev-pgdata
docker compose -f compose.dev.yml up -d --wait db
pnpm db:migrate
pnpm db:seed
echo "db:reset complete — fresh, migrated, seeded."
