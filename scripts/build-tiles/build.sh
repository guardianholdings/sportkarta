#!/usr/bin/env bash
#
# Produce a Bulgaria-only vector basemap extract (.pmtiles) from a Protomaps
# planet build, for self-hosted MapLibre tiles (docs/ROADMAP.md Stage 2).
#
# SOURCE  Protomaps daily planet build. These are dated files under
#         https://build.protomaps.com/ (ODbL, © OpenStreetMap contributors).
#         Old dailies are pruned, so there is no stable "latest" alias — pass a
#         recent date or a full URL. Default: today's UTC build; if that 404s,
#         open https://build.protomaps.com/ and pass an available date, e.g.
#           scripts/build-tiles/build.sh 20260720
#         A local planet .pmtiles path also works as SOURCE.
#
# OUTPUT  deploy/tiles/bulgaria.pmtiles (git-ignored — too large for the repo;
#         shipped to the VPS tiles volume as an ops step, see README.md).
#
# `pmtiles extract` streams only the tiles inside --bbox over HTTP range
# requests, so this downloads megabytes, not the multi-GB planet.
set -euo pipefail

# Bulgaria bounding box. Matches the facilities_geom_in_bulgaria CHECK in
# db/migrations/0001 (lon 22..29, lat 41..44.5) so basemap and data align.
BBOX="22.0,41.0,29.0,44.5"
MAXZOOM="${MAXZOOM:-14}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

DEFAULT_SOURCE="https://build.protomaps.com/$(date -u +%Y%m%d).pmtiles"
SOURCE="${1:-${SOURCE:-${DEFAULT_SOURCE}}}"
# A bare 8-digit date is a convenience for the Protomaps build URL.
if [[ "${SOURCE}" =~ ^[0-9]{8}$ ]]; then
  SOURCE="https://build.protomaps.com/${SOURCE}.pmtiles"
fi
OUTPUT="${2:-${OUTPUT:-${REPO_ROOT}/deploy/tiles/bulgaria.pmtiles}}"

if ! command -v pmtiles >/dev/null 2>&1; then
  cat >&2 <<'EOF'
error: the `pmtiles` CLI is not installed.

Install a release binary from https://github.com/protomaps/go-pmtiles/releases
(macOS: `brew install pmtiles`), then re-run this script.
EOF
  exit 1
fi

mkdir -p "$(dirname "${OUTPUT}")"

echo "Source : ${SOURCE}"
echo "Output : ${OUTPUT}"
echo "BBox   : ${BBOX}  (maxzoom ${MAXZOOM})"
echo

pmtiles extract "${SOURCE}" "${OUTPUT}" --bbox="${BBOX}" --maxzoom="${MAXZOOM}"

echo
echo "Wrote ${OUTPUT}"
pmtiles show "${OUTPUT}" | sed -n '1,20p' || true
