import { sql, type SQL } from '@sportkarta/db';
import { rolesWith, type ClubPermission, type ClubRole } from '@sportkarta/lib/clubs';

import { clubWritableGuard } from './access';

/**
 * AUTHORIZATION LIVES IN THE STATEMENT (0039's rule 2; the ambassador pattern
 * of apps/web/lib/moderation.ts).
 *
 * requireClubStaff decides whether to RENDER a page. It does not authorise a
 * change: every read and write in apps/web/lib/clubs embeds one of these
 * fragments, so a statement issued for a club the actor does not work at — or
 * in a role that lacks the permission, or after the grant was revoked a second
 * ago — matches zero rows. apps/web/tests/club-scope.test.ts renders every
 * exported mutation and fails if one is missing its fragment.
 *
 * The NGO admin (users.role = 'admin') passes every club scope, checked in SQL
 * against the users row like every other grant; reads by an admin who is not
 * the club's staff are logged to club_audit as 'ngo_admin_viewed' by
 * requireClubStaff, where the club — the controller — can see them.
 */

export interface ClubActor {
  /** users.id of the signed-in person. */
  userId: string;
  clubId: string;
  /** Their role at this club, or null for an NGO admin who is not staff here. */
  role: ClubRole | null;
  /** users.role = 'admin' at the time of the request. */
  ngoAdmin: boolean;
}

/** Closed alias set, rendered with sql.raw — never caller text. */
export type ScopeAlias =
  | 'm'
  | 'mem'
  | 'p'
  | 'pl'
  | 'ms'
  | 'mb'
  | 'ch'
  | 'cb'
  | 'pay'
  | 'k'
  | 'o'
  | 'b'
  | 'ci'
  | 'l'
  | 'kd'
  | 's'
  | 'si'
  | 'inv'
  | 'a'
  | 'n'
  | 'cp'
  | 'q'
  | 'kc'
  | 'rs'
  | 'sv'
  | 'rv'
  | 'pr'
  | 'lh'
  | 'sh'
  | 'tb'
  | 'pd'
  | 'sa'
  | 'sm'
  | 'po'
  | 'rd'
  | 'i'
  | 'il'
  | 'x'
  | 'bc'
  | 'au'
  | 'th'
  | 'fb'
  | 'ev'
  | 'et'
  | 'er'
  | 'tm';

function staffHolds(actor: ClubActor, roles: readonly ClubRole[]): SQL {
  return sql`EXISTS (SELECT 1 FROM club_staff sc
                      WHERE sc.club_id = ${actor.clubId}::uuid
                        AND sc.user_id = ${actor.userId}
                        AND sc.role = ANY(${sql.param([...roles])}::text[]))`;
}

function ngoAdminSql(actor: ClubActor): SQL {
  return sql`EXISTS (SELECT 1 FROM users su
                      WHERE su.id = ${actor.userId} AND su.role = 'admin'
                        AND su.suspended_at IS NULL)`;
}

/**
 * `<alias>.club_id = <club>` AND the actor holds `permission` at that club
 * (or is the NGO admin). Use for reads.
 */
export function clubScope(actor: ClubActor, permission: ClubPermission, alias: ScopeAlias): SQL {
  return sql`(${sql.raw(alias)}.club_id = ${actor.clubId}::uuid
    AND (${staffHolds(actor, rolesWith(permission))} OR ${ngoAdminSql(actor)}))`;
}

/**
 * clubScope plus the club's entitlement: a pending, suspended, archived or
 * lapsed club is read-only (0039: entitlement is a predicate, not a flag).
 * Use for every INSERT … SELECT / UPDATE / DELETE.
 */
export function clubWriteScope(
  actor: ClubActor,
  permission: ClubPermission,
  alias: ScopeAlias,
): SQL {
  return sql`(${clubScope(actor, permission, alias)} AND ${clubWritableGuard(actor.clubId)})`;
}

/**
 * The actor may act on a club without a row alias (an INSERT … VALUES guarded
 * by `WHERE ${clubActorMay(...)}`).
 */
export function clubActorMay(
  actor: ClubActor,
  permission: ClubPermission,
  options: { write: boolean },
): SQL {
  const holds = sql`(${staffHolds(actor, rolesWith(permission))} OR ${ngoAdminSql(actor)})`;
  return options.write ? sql`(${holds} AND ${clubWritableGuard(actor.clubId)})` : holds;
}

/**
 * Rosters and attendance on a class occurrence: front-of-house sees every
 * class, a trainer only the ones they teach (the occurrence's substitute if
 * set, else the class's instructor). `o` aliases club_class_occurrences and
 * `k` club_classes in the calling statement.
 */
export function occurrenceStaffScope(
  actor: ClubActor,
  permissions: { all: ClubPermission; own: ClubPermission },
): SQL {
  return sql`(o.club_id = ${actor.clubId}::uuid AND (
      ${staffHolds(actor, rolesWith(permissions.all))}
      OR ${ngoAdminSql(actor)}
      OR (${staffHolds(actor, rolesWith(permissions.own))}
          AND coalesce(o.instructor_user_id, k.instructor_user_id) = ${actor.userId})))`;
}

/**
 * The member portal: the club records linked to this POPS account (active
 * links only), plus the records of children whose guardian is one of them.
 * `alias` is a club_members row.
 */
export function memberSelfScope(userId: string, clubId: string, alias: 'm' | 'mem'): SQL {
  const a = sql.raw(alias);
  return sql`(${a}.club_id = ${clubId}::uuid AND (
      EXISTS (SELECT 1 FROM club_member_links ml
               WHERE ml.member_id = ${a}.id AND ml.user_id = ${userId} AND ml.status = 'active')
      OR EXISTS (SELECT 1 FROM club_member_links gl
                  WHERE gl.member_id = ${a}.guardian_member_id AND gl.user_id = ${userId}
                    AND gl.status = 'active')))`;
}
