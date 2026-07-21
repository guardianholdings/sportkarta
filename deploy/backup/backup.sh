#!/bin/bash
# Nightly backup: pg_dump (custom format) of all databases, then restic push
# off-box when configured. Local dumps are pruned after 3 days — the durable
# copy is the restic repository (Stage 7 restore drill depends on it).
set -euo pipefail

stamp=$(date +%Y%m%d-%H%M%S)
dest=/backups/pg
mkdir -p "$dest"

for dbname in sportkarta umami glitchtip; do
  echo "[backup] pg_dump $dbname"
  pg_dump --format=custom --dbname="$dbname" --file="$dest/$dbname-$stamp.dump"
done

find "$dest" -name '*.dump' -mtime +3 -delete

if [[ -n "${RESTIC_REPOSITORY:-}" && -n "${RESTIC_PASSWORD:-}" ]]; then
  restic snapshots >/dev/null 2>&1 || restic init
  restic backup /backups/pg /data/uploads
  restic forget --keep-daily 14 --keep-weekly 8 --prune
  echo "[backup] restic push complete"
else
  echo "[backup] WARNING: restic not configured (RESTIC_REPOSITORY/RESTIC_PASSWORD empty) — local dumps only, NOT off-box"
fi
