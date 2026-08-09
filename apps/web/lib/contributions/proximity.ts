import { sql, type SQL } from '@sportkarta/db';

/**
 * On-the-spot proximity for crowd contributions (operator decision 2026-08-07).
 *
 * A contribution claims something about the physical world — this pitch exists,
 * its surface is broken, it is still there. The claim is worth more when the
 * person making it was standing on it, so every contribution now carries the
 * distance between the contributor and the place they are describing.
 *
 * IT NEVER REFUSES A CONTRIBUTION, and that is the operator's choice as well as
 * the house rule. `apps/web/lib/sessions/checkin.ts` already settled the same
 * question for attendance: the anti-abuse layer records, and only the reward
 * stops. Refusing here would lose every honest edit made from a desktop, from a
 * basement sports hall, by somebody who denied the permission once a year ago,
 * or in the very common "photographed it this morning, filed it tonight" — while
 * costing a determined faker about thirty seconds in devtools.
 *
 * WHAT IT ACTUALLY BUYS, stated honestly so nobody over-trusts it:
 *  - a recorded signal on every row, so moderation can sort by it and an
 *    importer of fakes becomes visible as a pattern rather than one bad pin;
 *  - a cost asymmetry — being present is free for the honest and deliberate for
 *    the dishonest;
 *  - a reason to withhold points, which is what makes volume faking pointless.
 * It is NOT verification. Browser geolocation is self-reported: devtools sensor
 * override and mock-location apps both set any coordinate in seconds. Nothing
 * downstream may treat `onSite` as proof, only as evidence.
 *
 * NO COORDINATE IS EVER STORED. The latitude and longitude live for exactly one
 * SQL statement — the one that turns them into metres — and only the metres are
 * written down, exactly as `play_session_checkins.distance_m` does and for the
 * same reason: a column of coordinates is a record of where named people
 * physically were, and this platform does not keep one.
 */

/**
 * How close counts as "on the spot", in metres.
 *
 * The same 250 m the QR geofence uses, and deliberately the same number rather
 * than a second tunable: urban GPS is routinely 50 m out between tower blocks,
 * and a park's registered point is often its gate rather than the pitch. A
 * tighter radius would not stop anybody willing to fake a coordinate — it would
 * only fail honest people standing in the wrong corner.
 */
export const CONTRIBUTION_RADIUS_M = 250;

/**
 * The ceiling written to the database.
 *
 * Mirrors the check-in clamp and exists for the same failure: a desktop browser
 * falling back to an IP-derived fix can be 1 500 km out and a spoofed coordinate
 * 20 000 km. Unclamped, an out-of-range value would raise a CHECK violation,
 * abort the transaction and lose THE WHOLE CONTRIBUTION — turning an anti-abuse
 * signal into a way to destroy honest data. Far past the radius either way, so
 * clamping changes no decision.
 */
export const MAX_RECORDED_DISTANCE_M = 1_000_000;

export interface Coordinates {
  lat: number;
  lon: number;
}

/**
 * Parse a client-supplied position. Anything missing, unparseable or outside the
 * valid coordinate range becomes "no location" rather than an error: a broken
 * fix must degrade to unscored, never to a failed submission.
 */
export function parseCoordinates(
  lat: unknown,
  lon: unknown,
): Coordinates | null {
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90) return null;
  if (longitude < -180 || longitude > 180) return null;
  return { lat: latitude, lon: longitude };
}

/**
 * Metres from `coords` to a geometry, clamped, as a SQL scalar.
 *
 * `::geography` so the answer is metres on the spheroid rather than degrees —
 * the same cast the check-in path uses. Returns SQL NULL when there is no
 * position, which is the "location off" case and must stay distinguishable from
 * "far away": one is a person who declined, the other a claim about a place the
 * person was not at.
 */
export function distanceToGeomSql(geom: SQL, coords: Coordinates | null): SQL {
  if (!coords) return sql`NULL::int`;
  return sql`least(
    round(ST_Distance(
      ${geom}::geography,
      ST_SetSRID(ST_MakePoint(${coords.lon}::float8, ${coords.lat}::float8), 4326)::geography
    ))::int,
    ${MAX_RECORDED_DISTANCE_M}
  )`;
}

/** The same, for a bare lon/lat pair the caller is about to insert (add-facility). */
export function distanceToPointSql(
  target: Coordinates,
  coords: Coordinates | null,
): SQL {
  return distanceToGeomSql(
    sql`ST_SetSRID(ST_MakePoint(${target.lon}::float8, ${target.lat}::float8), 4326)`,
    coords,
  );
}

/**
 * Was the contributor close enough to be trusted?
 *
 * `null` (no location) is NOT on site. That is the whole point of the operator's
 * decision: a contribution with no position is exactly as unverifiable as one
 * from the next city, so both go to the queue and neither scores.
 */
export function isOnSite(distanceM: number | null): boolean {
  return distanceM !== null && distanceM <= CONTRIBUTION_RADIUS_M;
}
