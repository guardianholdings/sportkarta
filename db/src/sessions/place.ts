import { sql, type SQL } from 'drizzle-orm';

/**
 * Where a game is played, with what it takes to NAME the place the way the map
 * does (apps/web/lib/sessions/place-name.ts): its own name, or — for an unnamed
 * one — its sports and its area. 91% of the corpus has no name, and the game
 * surfaces used to print «—», or the game's own sport, where the place should be.
 *
 * One definition for every read that names a game's place — the lists, the
 * single game, the member's «Следва», the calendar and the weekly city page —
 * so none of them drifts to a different set of columns.
 */
export interface SessionPlace {
  facilityName: string | null;
  facilitySports: string[];
  facilityQuarter: string | null;
  /** The municipality's Bulgarian name, as the facility row carries it. */
  facilityMunicipality: string | null;
}

/** The columns behind `SessionPlace`, for a query whose facility is `f`. */
export const SESSION_PLACE_COLUMNS: SQL = sql`
  f.name AS facility_name, f.sport_types AS facility_sports,
  f.quarter AS facility_quarter, place_m.name_bg AS facility_municipality`;

/**
 * The join SESSION_PLACE_COLUMNS reads. Not aliased `m`: the club queries
 * already use `m` for club_members, and a shared fragment must not collide.
 */
export const SESSION_PLACE_JOIN: SQL = sql`LEFT JOIN municipalities place_m ON place_m.id = f.municipality_id`;

export function sessionPlaceFromRow(row: Record<string, unknown>): SessionPlace {
  return {
    facilityName: (row.facility_name as string | null) ?? null,
    facilitySports: Array.isArray(row.facility_sports) ? row.facility_sports.map(String) : [],
    facilityQuarter: (row.facility_quarter as string | null) ?? null,
    facilityMunicipality: (row.facility_municipality as string | null) ?? null,
  };
}
