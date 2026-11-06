# Self-hosted vector basemap tiles

SportKarta serves its own MapLibre basemap from a single Bulgaria-only
`.pmtiles` archive — no external tile service (docs/ROADMAP.md Stage 2).

## Files

- `bulgaria.pmtiles` — the extract. **Git-ignored** (`.gitignore` here): it is
  tens of MB, so it lives in the VPS `tiles` volume, not the repo.

## Source & license

- **Source:** a [Protomaps](https://protomaps.com/) daily planet build
  (`https://build.protomaps.com/<YYYYMMDD>.pmtiles`), clipped to Bulgaria.
- **Underlying data:** © [OpenStreetMap](https://www.openstreetmap.org/copyright)
  contributors, licensed **ODbL**. The Protomaps basemap schema and build
  tooling are open source (BSD-3-Clause).
- **Attribution (shown on every map view — CLAUDE.md rule):**
  `© OpenStreetMap` + `Protomaps`. Carried in the MapLibre style source's
  `attribution` field (`apps/web/lib/map/style.ts`) and rendered by the map's
  attribution control.

## Regenerate

```
pnpm tiles:build              # today's Protomaps build
pnpm tiles:build 20260720     # a specific dated build (if today's isn't up yet)
```

Requires the [`pmtiles`](https://github.com/protomaps/go-pmtiles) CLI
(`brew install pmtiles`). The extract streams only the tiles inside the
Bulgaria bbox over HTTP range requests — megabytes, not the multi-GB planet.
Output goes to `deploy/tiles/bulgaria.pmtiles`.

## Regional underlay (desktop map)

Beyond the national archive's edges (about 45.09° N and 40.98° N, and the
tile columns either side) the style draws only its flat background. The
desktop map therefore also draws a small regional archive UNDER the national
one, so that Romania, Serbia, North Macedonia, Greece, Turkey and the Black
Sea are real map and the country can sit in the middle of the screen:

- **File:** `apps/web/public/basemap/region-<YYYYMMDD>.pmtiles`, bbox
  14,36–37,49, zooms 0–7, about 13 MB. **Committed**, unlike `bulgaria.pmtiles`,
  and served by the app itself: same origin, range requests, browser-cached for
  a month (the build date in the name changes with the content). It is not under
  `/tiles/`, which Caddy serves from the volume.
- **Build:** `pnpm tiles:build region`, from the Protomaps build pinned as
  `REGION_BUILD` in `scripts/build-tiles/build.sh`. Protomaps prunes old
  dailies: to rebuild, set an available date there, change `UNDERLAY_PATH` in
  `apps/web/lib/map/underlay.ts` to the new file name (the unit tests check that
  the two agree) and delete the old file.
- **Drawing:** the same layers and paint as the national source, from one
  function (`apps/web/lib/map/style.ts`), up to map zoom 11. Wherever national
  tiles exist, their opaque earth and water cover it, and the app does not
  fetch the underlay tiles they cover at all (`skipUnderlayTile`). The phone
  layout and the place listings do not use it.
- **Licence and attribution:** as above; the source carries the same string.

## Glyphs (map label fonts)

The MapLibre style also needs font glyphs (`/fonts/{fontstack}/{range}.pbf`)
to render labels — the `Noto Sans Regular` stack (covers Cyrillic). Like the
basemap, these are a self-hosted asset, not committed:

- Generate PBF glyphs from a TTF with a tool such as
  [`font-maker`](https://github.com/maplibre/font-maker) /
  [`fontnik`](https://github.com/mapbox/node-fontnik), producing
  `Noto Sans Regular/{0-255,256-511,…}.pbf`.
- Serve them at `/fonts/*` (add a Caddy `handle_path /fonts/*` block, or drop
  the files under `apps/web/public/fonts/`).

If glyphs are absent, MapLibre renders label codepoints locally and logs a
warning — labels still appear, so a missing glyph set never breaks the map.

## Serving

- **Local dev:** the Next.js route `apps/web/app/tiles/[...path]/route.ts`
  serves this file with HTTP range support. Set `TILES_DIR` if the file is not
  at `deploy/tiles/`.
- **Production:** Caddy serves `/tiles/*` from the `tiles` volume with native
  range support (`deploy/Caddyfile`). Load a freshly built `bulgaria.pmtiles`
  into that volume as an ops step — e.g. copy it into the running Caddy
  container's `/srv/tiles`, or `docker cp` it onto the `tiles` volume. The app
  degrades to a plain background if the file is absent, so a missing basemap
  never breaks the map or facility data.
