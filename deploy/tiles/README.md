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
