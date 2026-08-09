#!/bin/bash
# Nightly backup: pg_dump (custom format) of all databases, then restic push
# off-box when configured.
#
# RETENTION IS CONDITIONAL ON THE OFF-BOX COPY EXISTING, and that is the whole
# point of this script's shape. Local dumps live on the same disk as the
# database they protect, so they are a convenience, not a backup. Keeping only
# three days of them is right ONLY when restic is really pushing elsewhere;
# with restic unconfigured the same rule quietly reduces the deployment to at
# most three days of history, all of it on the one disk whose failure is the
# thing being insured against. So: prune to three days only after a push has
# actually succeeded, and otherwise keep a fortnight and say plainly that
# nothing is off-box.
#
# The prune also runs AFTER the push rather than before it. A failed push with
# the old dumps already deleted is the worst of both worlds.
set -euo pipefail

stamp=$(date +%Y%m%d-%H%M%S)
dest=/backups/pg
mkdir -p "$dest"

for dbname in sportkarta umami glitchtip; do
  echo "[backup] pg_dump $dbname"
  pg_dump --format=custom --dbname="$dbname" --file="$dest/$dbname-$stamp.dump"
done

# A dump that cannot be listed cannot be restored, and finding that out during
# an incident is finding out too late.
for dump in "$dest"/*-"$stamp".dump; do
  if ! pg_restore --list "$dump" >/dev/null 2>&1; then
    echo "[backup] ERROR: $dump is not a readable archive — keeping everything, not pruning"
    exit 1
  fi
done
echo "[backup] verified $(ls -1 "$dest"/*-"$stamp".dump | wc -l) archive(s) readable"

pushed=no
if [[ -n "${RESTIC_REPOSITORY:-}" && -n "${RESTIC_PASSWORD:-}" ]]; then
  restic snapshots >/dev/null 2>&1 || restic init
  restic backup /backups/pg /data/uploads
  restic forget --keep-daily 14 --keep-weekly 8 --prune
  pushed=yes
  echo "[backup] restic push complete"
else
  echo "[backup] WARNING: restic not configured (RESTIC_REPOSITORY/RESTIC_PASSWORD empty)"
  echo "[backup] WARNING: NOTHING IS OFF-BOX. Every copy is on this server's disk."
fi

if [[ "$pushed" == yes ]]; then
  find "$dest" -name '*.dump' -mtime +3 -delete
  echo "[backup] pruned local dumps older than 3 days (durable copy is off-box)"
else
  find "$dest" -name '*.dump' -mtime +14 -delete
  echo "[backup] kept 14 days of local dumps (no off-box copy to fall back on)"
fi
