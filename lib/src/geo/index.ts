/**
 * Where Bulgaria is — declared ONCE.
 *
 * This box was previously written out five separate times: the add-facility
 * validator, the municipal-import normaliser, the OSM importer, the map canvas's
 * zoom floor, and the URL-view parser on the home page. All five agreed on
 * {22, 29, 41, 44.5}, and they agreed by coincidence rather than by
 * construction — nothing connected them, so the first person to widen one for a
 * border facility would have created a map that pans somewhere the validator
 * still rejects, or an importer that accepts a row the map cannot show.
 *
 * The rule this follows is the one the rest of the codebase already applies to
 * anything with more than one reader: `leaderboard_eligible_members` for
 * consent, `PUBLIC_FACILITY_PREDICATE` for visibility, `PARTNER_RENDERABLE` for
 * partners. A constant with five copies is five constants.
 *
 * DELIBERATELY LOOSER THAN THE COUNTRY. Bulgaria's true extent is about
 * 22.36–28.61 E and 41.24–44.22 N; this box has roughly 0.3–0.4° of slack on
 * every side. That slack is doing three jobs:
 *
 *   1. A facility ON the border must be enterable, and a validator that clipped
 *      the outline exactly would reject a real pitch in Vidin or Svilengrad.
 *   2. The map's `maxBounds` constrains the VIEWPORT, not the centre, so a box
 *      drawn tight to the coastline would make the coast itself unreachable —
 *      you could never get the edge of the country into the middle of the
 *      screen.
 *   3. It is a plausibility check, not a border. Deciding whether a point is
 *      inside Bulgaria properly is `ST_Contains` against the municipality
 *      polygons, which the importer already does when it derives a
 *      municipality; this box exists to reject Berlin and Cairo cheaply, before
 *      any database is touched.
 *
 * So: widen it if a real facility is refused. Do NOT tighten it to the outline.
 */
export const BULGARIA_BBOX = {
  minLon: 22.0,
  maxLon: 29.0,
  minLat: 41.0,
  maxLat: 44.5,
} as const;

export interface BboxPoint {
  lon: number;
  lat: number;
}

/**
 * Whether a coordinate is plausibly in Bulgaria.
 *
 * Rejects NaN and Infinity rather than letting them through a chain of
 * comparisons: `NaN < 22` is false and so is `NaN > 29`, so a naive
 * range check ACCEPTS NaN — which is how a missing coordinate becomes a
 * facility at the origin of the world.
 */
export function insideBulgaria(point: BboxPoint): boolean {
  if (!Number.isFinite(point.lon) || !Number.isFinite(point.lat)) return false;
  return (
    point.lon >= BULGARIA_BBOX.minLon &&
    point.lon <= BULGARIA_BBOX.maxLon &&
    point.lat >= BULGARIA_BBOX.minLat &&
    point.lat <= BULGARIA_BBOX.maxLat
  );
}

/**
 * The same box as MapLibre wants it: `[[west, south], [east, north]]`.
 *
 * A tuple rather than a `LngLatBounds`, so this module stays free of any map
 * dependency — `lib/` is imported by the worker and by scripts, and neither
 * should acquire maplibre-gl to find out where Bulgaria is.
 */
export const BULGARIA_BOUNDS: readonly [readonly [number, number], readonly [number, number]] = [
  [BULGARIA_BBOX.minLon, BULGARIA_BBOX.minLat],
  [BULGARIA_BBOX.maxLon, BULGARIA_BBOX.maxLat],
] as const;

/** The whole-country overview the map opens on when nothing else is asked for. */
export const BULGARIA_CENTER = { lng: 25.3, lat: 42.72, zoom: 6.8 } as const;
