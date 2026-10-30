import { getDb, sql } from '@sportkarta/db';
import type { IsoDate } from '@sportkarta/lib/clubs';

import { clubActorMay, type ClubActor } from './scope';

/**
 * The office dashboard («Табло»): today's figures, what needs doing, and the
 * onboarding checklist — every item ticked FROM DATA (a location exists, a
 * plan exists…), never from a stored "completed" flag.
 */

export interface DashboardData {
  checkinsToday: number;
  activeMembers: number;
  expiringCount: number;
  unpaidCount: number;
  expiring: {
    memberId: string;
    memberName: string;
    planName: string;
    planId: string;
    endsOn: IsoDate;
  }[];
  erasureRequests: { memberId: string; memberName: string }[];
  checklist: {
    location: boolean;
    logo: boolean;
    plan: boolean;
    class: boolean;
    staff: boolean;
    members: boolean;
    kiosk: boolean;
    publish: boolean;
  };
}

export async function dashboardData(actor: ClubActor): Promise<DashboardData> {
  const db = getDb();
  const clubId = actor.clubId;
  const allowed = clubActorMay(actor, 'office.view', { write: false });
  const [figures, expiring, erasure] = await Promise.all([
    db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM club_checkins ci
          WHERE ci.club_id = ${clubId}::uuid AND ci.sofia_day = (now() AT TIME ZONE 'Europe/Sofia')::date)
          AS checkins_today,
        (SELECT count(DISTINCT b.member_id)::int FROM club_membership_balances b
          WHERE b.club_id = ${clubId}::uuid AND b.state IN ('active', 'paused')) AS active_members,
        (SELECT count(*)::int FROM club_membership_balances b
          WHERE b.club_id = ${clubId}::uuid AND b.state = 'active'
            AND b.effective_ends_on <= (now() AT TIME ZONE 'Europe/Sofia')::date + 7) AS expiring,
        (SELECT count(*)::int FROM club_charge_balances cb
          WHERE cb.club_id = ${clubId}::uuid AND cb.status IN ('open', 'partial', 'overdue')) AS unpaid,
        EXISTS (SELECT 1 FROM club_locations l WHERE l.club_id = ${clubId}::uuid) AS has_location,
        EXISTS (SELECT 1 FROM clubs c WHERE c.id = ${clubId}::uuid AND c.logo_path IS NOT NULL) AS has_logo,
        EXISTS (SELECT 1 FROM club_plans p WHERE p.club_id = ${clubId}::uuid) AS has_plan,
        EXISTS (SELECT 1 FROM club_classes k WHERE k.club_id = ${clubId}::uuid) AS has_class,
        ((SELECT count(*) FROM club_staff s WHERE s.club_id = ${clubId}::uuid) > 1
          OR EXISTS (SELECT 1 FROM club_staff_invites si WHERE si.club_id = ${clubId}::uuid)) AS has_staff,
        EXISTS (SELECT 1 FROM club_members m WHERE m.club_id = ${clubId}::uuid) AS has_members,
        EXISTS (SELECT 1 FROM club_kiosk_devices kd WHERE kd.club_id = ${clubId}::uuid
                   AND kd.kind = 'kiosk' AND kd.paired_at IS NOT NULL) AS has_kiosk,
        EXISTS (SELECT 1 FROM clubs c WHERE c.id = ${clubId}::uuid AND c.visible) AS published
       WHERE ${allowed}
    `),
    db.execute(sql`
      SELECT b.member_id, m.display_name, b.plan_name, b.plan_id,
             to_char(b.effective_ends_on, 'YYYY-MM-DD') AS ends_on
        FROM club_membership_balances b
        JOIN club_members m ON m.club_id = b.club_id AND m.id = b.member_id
       WHERE b.club_id = ${clubId}::uuid AND b.state = 'active'
         AND b.effective_ends_on <= (now() AT TIME ZONE 'Europe/Sofia')::date + 7
         AND ${clubActorMay(actor, 'members.view', { write: false })}
       ORDER BY b.effective_ends_on, lower(m.display_name)
       LIMIT 10
    `),
    db.execute(sql`
      SELECT m.id, m.display_name FROM club_members m
       WHERE m.club_id = ${clubId}::uuid AND m.erasure_requested_at IS NOT NULL
         AND ${clubActorMay(actor, 'members.view', { write: false })}
       ORDER BY m.erasure_requested_at
    `),
  ]);
  const f = figures.rows[0] ?? {};
  return {
    checkinsToday: Number(f.checkins_today ?? 0),
    activeMembers: Number(f.active_members ?? 0),
    expiringCount: Number(f.expiring ?? 0),
    unpaidCount: Number(f.unpaid ?? 0),
    expiring: expiring.rows.map((row) => ({
      memberId: String(row.member_id),
      memberName: String(row.display_name),
      planName: String(row.plan_name),
      planId: String(row.plan_id),
      endsOn: String(row.ends_on),
    })),
    erasureRequests: erasure.rows.map((row) => ({
      memberId: String(row.id),
      memberName: String(row.display_name),
    })),
    checklist: {
      location: f.has_location === true,
      logo: f.has_logo === true,
      plan: f.has_plan === true,
      class: f.has_class === true,
      staff: f.has_staff === true,
      members: f.has_members === true,
      kiosk: f.has_kiosk === true,
      publish: f.published === true,
    },
  };
}
