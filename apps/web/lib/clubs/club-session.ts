import 'server-only';

import { getDb, sql } from '@sportkarta/db';
import {
  can,
  clubAccessState,
  isClubRole,
  sofiaToday,
  type ClubAccessState,
  type ClubKind,
  type ClubPermission,
  type ClubRole,
  type ClubStatus,
  type ClubTier,
} from '@sportkarta/lib/clubs';
import { notFound } from 'next/navigation';
import { cache } from 'react';

import { requireUser, type CurrentUser } from '../auth-session';

import { clubsEnabled } from './access';
import type { ClubActor } from './scope';

/**
 * The club office's page gate (docs/ROADMAP.md Stage 9).
 *
 * `requireClubStaff(slug, permission)` is to the office what requireRole is to
 * /admin: anonymous visitors go to sign in (and come back), and everybody who
 * may not see the page gets a 404 — a member of the public has no business
 * learning which clubs exist in the back office, or that a slug is a club at
 * all. It RENDERS a page; it never authorises a change. Every statement in
 * apps/web/lib/clubs embeds its own scope (scope.ts), so a stale context cannot
 * write anything.
 *
 * One statement reads the club and the actor's grant together. It is cached
 * per request (React `cache`), so the layout and the page share it.
 */

export interface ClubSummary {
  id: string;
  slug: string;
  nameBg: string;
  nameEn: string | null;
  kind: ClubKind;
  tier: ClubTier;
  status: ClubStatus;
  visible: boolean;
  trialEndsOn: string | null;
  paidUntil: string | null;
  memberCap: number | null;
  logoPath: string | null;
  locale: 'bg' | 'en';
  accessState: ClubAccessState;
}

export interface ClubContext {
  user: CurrentUser;
  actor: ClubActor;
  club: ClubSummary;
}

/** 404 unless the add-on is switched on. Every club route calls it first. */
export function requireClubsEnabled(): void {
  if (!clubsEnabled()) notFound();
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

const loadContext = cache(async (slug: string): Promise<ClubContext | null> => {
  const user = await requireUser();
  const result = await getDb().execute(sql`
    SELECT c.id, c.slug, c.name_bg, c.name_en, c.kind, c.tier, c.status, c.visible,
           to_char(c.trial_ends_on, 'YYYY-MM-DD') AS trial_ends_on,
           to_char(c.paid_until, 'YYYY-MM-DD') AS paid_until,
           c.member_cap, c.logo_path, c.locale, s.role
      FROM clubs c
      LEFT JOIN club_staff s ON s.club_id = c.id AND s.user_id = ${user.id}
     WHERE c.slug = ${slug}
  `);
  const row = result.rows[0];
  if (!row) return null;
  const role = isClubRole(row.role) ? row.role : null;
  const ngoAdmin = user.role === 'admin';
  if (role === null && !ngoAdmin) return null;

  const club: ClubSummary = {
    id: String(row.id),
    slug: String(row.slug),
    nameBg: String(row.name_bg),
    nameEn: textOrNull(row.name_en),
    kind: String(row.kind) as ClubKind,
    tier: String(row.tier) as ClubTier,
    status: String(row.status) as ClubStatus,
    visible: row.visible === true,
    trialEndsOn: textOrNull(row.trial_ends_on),
    paidUntil: textOrNull(row.paid_until),
    memberCap: row.member_cap === null ? null : Number(row.member_cap),
    logoPath: textOrNull(row.logo_path),
    locale: row.locale === 'en' ? 'en' : 'bg',
    accessState: 'pending',
  };
  club.accessState = clubAccessState(club, sofiaToday());

  if (role === null) {
    // The NGO admin reading a club they do not work at: logged where the
    // club, as controller of what is shown, can see it — once an hour per
    // admin per club, so a session of clicking around is one line, not fifty.
    await getDb().execute(sql`
      INSERT INTO club_audit (club_id, actor_id, actor_kind, action)
      SELECT ${club.id}::uuid, ${user.id}, 'ngo_admin', 'ngo_admin_viewed'
       WHERE NOT EXISTS (
         SELECT 1 FROM club_audit a
          WHERE a.club_id = ${club.id}::uuid AND a.actor_id = ${user.id}
            AND a.action = 'ngo_admin_viewed' AND a.acted_at > now() - interval '1 hour')
    `);
  }

  return { user, actor: { userId: user.id, clubId: club.id, role, ngoAdmin }, club };
});

/**
 * The page gate. `permission` is what the page SHOWS; an NGO admin passes
 * every permission (and is logged). Returns the context for the page.
 */
export async function requireClubStaff(
  slug: string,
  permission: ClubPermission,
): Promise<ClubContext> {
  requireClubsEnabled();
  const context = await loadContext(slug);
  if (!context) notFound();
  const { role, ngoAdmin } = context.actor;
  if (!ngoAdmin && (role === null || !can(role, permission))) notFound();
  return context;
}

/** Like requireClubStaff, but for a page any of several permissions opens. */
export async function requireClubStaffAny(
  slug: string,
  permissions: readonly ClubPermission[],
): Promise<ClubContext> {
  requireClubsEnabled();
  const context = await loadContext(slug);
  if (!context) notFound();
  const { role, ngoAdmin } = context.actor;
  if (!ngoAdmin && (role === null || !permissions.some((p) => can(role, p)))) notFound();
  return context;
}

/** What the actor may do here, for rendering. The NGO admin may do anything. */
export function actorCan(actor: ClubActor, permission: ClubPermission): boolean {
  if (actor.ngoAdmin) return true;
  return actor.role !== null && can(actor.role, permission);
}

/** Display name of a club in a locale (en falls back to bg). */
export function clubName(club: { nameBg: string; nameEn: string | null }, locale: string): string {
  return locale === 'en' && club.nameEn ? club.nameEn : club.nameBg;
}

/** For type-only consumers that need the role list without the lib import. */
export type { ClubRole };
