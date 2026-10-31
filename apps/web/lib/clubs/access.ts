import { sql, type SQL } from '@sportkarta/db';
import { CLUB_GRACE_DAYS } from '@sportkarta/lib/clubs';

/**
 * The «Клубове» feature flag and the SQL twins of lib/src/clubs/access.ts.
 *
 * FLAG. `CLUBS_ENABLED` must be exactly "true" (the PARTNER_STRIP_ENABLED /
 * AUTH_GOOGLE_ENABLED pattern) and is read at request time, so turning the
 * pilot on is a compose change, not a rebuild. With it off every club route
 * 404s and every embedded club surface renders nothing.
 *
 * PREDICATES. Whether a club may WRITE, and whether its public page RENDERS,
 * are written here ONCE as SQL and embedded in every statement that needs them
 * — never re-derived in application code from a row read earlier, which would
 * open a window between the read and the write. `clubAccessState` in
 * lib/src/clubs/access.ts is the same rule for rendering banners, and
 * apps/web/tests/journeys/clubs-access.test.ts holds the two equal.
 */

export function clubsEnabled(): boolean {
  return process.env.CLUBS_ENABLED === 'true';
}

/** Today on the Sofia calendar, in SQL. */
export const SOFIA_TODAY_SQL: SQL = sql`(now() AT TIME ZONE 'Europe/Sofia')::date`;

/**
 * The table alias a predicate is written against. A closed union rendered
 * with sql.raw: never caller text.
 */
export type ClubAlias = 'c' | 'club' | 'wc';

/**
 * status = active AND the later of paid_until / trial_ends_on plus the grace
 * is today or later — on every tier, since none is free (2026-10-31, 0060).
 * greatest() ignores a NULL argument, so a club with only a trial, or only a
 * payment, is judged by the one it has. With neither, the comparison is NULL:
 * coalesce makes that a plain false, so `NOT clubWritableSql()` (the admin's
 * «Изтекли» tab) and a selected `live` column see a lapsed club, not a gap.
 */
export function clubWritableSql(alias: ClubAlias = 'c'): SQL {
  const a = sql.raw(alias);
  return sql`(${a}.status = 'active' AND coalesce(
    greatest(${a}.paid_until, ${a}.trial_ends_on) + ${CLUB_GRACE_DAYS}::int >= ${SOFIA_TODAY_SQL},
    false))`;
}

/**
 * CLUB_RENDERABLE: the public page, the /klubove directory, the facility-page
 * block and the map preview chip all embed this — the owner published it AND
 * the club may operate. Hiding or lapsing a club withdraws it everywhere at once
 * (the PARTNER_RENDERABLE rule, apps/web/lib/partners.ts).
 */
export function clubRenderableSql(alias: ClubAlias = 'c'): SQL {
  return sql`(${sql.raw(alias)}.visible AND ${clubWritableSql(alias)})`;
}

/**
 * A guard for a write statement that does not otherwise join `clubs`:
 * `AND ${clubWritableGuard(clubId)}` makes the write match zero rows when the
 * club is pending, suspended, archived or past its grace.
 */
export function clubWritableGuard(clubId: string): SQL {
  return sql`EXISTS (SELECT 1 FROM clubs wc WHERE wc.id = ${clubId}::uuid AND ${clubWritableSql('wc')})`;
}
