import type pg from 'pg';

/**
 * Fixtures for the DB-backed «Клубове» suites (db/src/club-*.test.ts).
 *
 * Every account id starts with `e2e_club_` and every address ends in
 * `@example.org`, so a crashed run is cleaned by the next one. A club is
 * removed with `purgeClub`, which is the ONLY way the append-only ledgers let
 * go of their rows (0039's header) — so the tests exercise the real purge path
 * every time they clean up.
 *
 * Times are derived from the database clock, never written as calendar dates:
 * the booking trigger refuses an occurrence that has started, and a fixed date
 * in a fixture is a time bomb (see db/src/sessions-waitlist.test.ts).
 */

export const USER_PREFIX = 'e2e_club_';

export async function ensureUser(client: pg.Client, id: string): Promise<string> {
  const userId = id.startsWith(USER_PREFIX) ? id : `${USER_PREFIX}${id}`;
  await client.query(
    `INSERT INTO users (id, display_name, email) VALUES ($1, 'Тест', $2)
     ON CONFLICT (id) DO NOTHING`,
    [userId, `${userId}@example.org`],
  );
  return userId;
}

export interface ClubFixture {
  clubId: string;
  ownerId: string;
  locationId: string;
}

export async function makeClub(
  client: pg.Client,
  slug: string,
  /**
   * `paid`: paid a year ahead, so the club may write — every tier is paid
   * (2026-10-31), and a club with neither a trial nor a payment is lapsed.
   */
  options: { tier?: string; status?: string; paid?: boolean } = {},
): Promise<ClubFixture> {
  const ownerId = await ensureUser(client, `${slug}_owner`);
  const status = options.status ?? 'active';
  const club = await client.query<{ id: string }>(
    `INSERT INTO clubs (slug, name_bg, tier, status, approved_at, suspended_at, archived_at, paid_until)
     VALUES ($1, $2, $3, $4,
             CASE WHEN $4 = 'pending' THEN NULL ELSE now() END,
             CASE WHEN $4 = 'suspended' THEN now() END,
             CASE WHEN $4 = 'archived' THEN now() END,
             CASE WHEN $5 THEN current_date + 365 END)
     RETURNING id`,
    [`e2e-${slug}`, `Клуб ${slug}`, options.tier ?? 'standard', status, options.paid === true],
  );
  const clubId = club.rows[0]?.id ?? '';
  await client.query(`INSERT INTO club_staff (club_id, user_id, role) VALUES ($1, $2, 'owner')`, [
    clubId,
    ownerId,
  ]);
  const location = await client.query<{ id: string }>(
    `INSERT INTO club_locations (club_id, name, address) VALUES ($1, 'Зала', 'ул. Тестова 1')
     RETURNING id`,
    [clubId],
  );
  return { clubId, ownerId, locationId: location.rows[0]?.id ?? '' };
}

export async function makeMember(
  client: pg.Client,
  clubId: string,
  name: string,
  options: { email?: string; isMinor?: boolean; guardianId?: string } = {},
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO club_members (club_id, display_name, email, is_minor, guardian_member_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [clubId, name, options.email ?? null, options.isMinor ?? false, options.guardianId ?? null],
  );
  return result.rows[0]?.id ?? '';
}

export async function makePlan(
  client: pg.Client,
  clubId: string,
  options: { kind?: 'unlimited' | 'visits' | 'trial'; visits?: number; priceCents?: number } = {},
): Promise<string> {
  const kind = options.kind ?? 'unlimited';
  const result = await client.query<{ id: string }>(
    `INSERT INTO club_plans (club_id, name_bg, kind, price_cents, validity_months, visits_count)
     VALUES ($1, $2, $3, $4, 1, $5) RETURNING id`,
    [
      clubId,
      kind === 'visits' ? 'Карта 10 посещения' : 'Месечен абонамент',
      kind,
      options.priceCents ?? 5000,
      kind === 'unlimited' ? null : (options.visits ?? 10),
    ],
  );
  return result.rows[0]?.id ?? '';
}

/**
 * A sale: membership (plan snapshot) + its charge. Starts today (Sofia) and
 * runs `days` days unless told otherwise.
 */
export async function sellMembership(
  client: pg.Client,
  clubId: string,
  memberId: string,
  planId: string,
  options: { startOffsetDays?: number; days?: number; offset?: number } = {},
): Promise<{ membershipId: string; chargeId: string }> {
  const membership = await client.query<{ id: string }>(
    `INSERT INTO club_memberships
       (club_id, member_id, plan_id, plan_name, kind, audience, price_cents, visits_total,
        starts_on, ends_on, visits_used_offset)
     SELECT p.club_id, $2, p.id, p.name_bg, p.kind, p.audience, p.price_cents, p.visits_count,
            (now() AT TIME ZONE 'Europe/Sofia')::date + $4::int,
            (now() AT TIME ZONE 'Europe/Sofia')::date + $4::int + $5::int - 1,
            $6
       FROM club_plans p WHERE p.club_id = $1 AND p.id = $3
     RETURNING id`,
    [
      clubId,
      memberId,
      planId,
      options.startOffsetDays ?? 0,
      options.days ?? 30,
      options.offset ?? 0,
    ],
  );
  const membershipId = membership.rows[0]?.id ?? '';
  const charge = await client.query<{ id: string }>(
    `INSERT INTO club_charges (club_id, member_id, membership_id, kind, label, amount_cents,
                               issued_on, due_on)
     SELECT m.club_id, m.member_id, m.id, 'membership', m.plan_name, greatest(m.price_cents, 1),
            m.starts_on, m.starts_on + 7
       FROM club_memberships m WHERE m.id = $1
     RETURNING id`,
    [membershipId],
  );
  return { membershipId, chargeId: charge.rows[0]?.id ?? '' };
}

/**
 * A one-off class and its single occurrence, `daysAhead` days from now at the
 * top of the hour, wall clock read off the real instant so the local-clock
 * trigger always agrees.
 */
export async function makeOccurrence(
  client: pg.Client,
  fixture: ClubFixture,
  options: {
    daysAhead?: number;
    capacity?: number | null;
    instructorId?: string | null;
    bookingOpensHours?: number;
  } = {},
): Promise<{ classId: string; occurrenceId: string }> {
  const klass = await client.query<{ id: string }>(
    `INSERT INTO club_classes
       (club_id, location_id, title, sport, instructor_user_id, starts_at_local,
        duration_minutes, capacity, booking_opens_hours)
     VALUES ($1, $2, 'Йога', 'yoga', $3,
             (date_trunc('hour', now()) + make_interval(days => $4::int)) AT TIME ZONE 'Europe/Sofia',
             60, $5, $6)
     RETURNING id`,
    [
      fixture.clubId,
      fixture.locationId,
      options.instructorId ?? null,
      options.daysAhead ?? 2,
      options.capacity === undefined ? 10 : options.capacity,
      options.bookingOpensHours ?? 168,
    ],
  );
  const classId = klass.rows[0]?.id ?? '';
  const occurrence = await client.query<{ id: string }>(
    `INSERT INTO club_class_occurrences (club_id, class_id, starts_at, ends_at, starts_at_local)
     SELECT c.club_id, c.id,
            c.starts_at_local AT TIME ZONE 'Europe/Sofia',
            (c.starts_at_local AT TIME ZONE 'Europe/Sofia') + interval '60 minutes',
            c.starts_at_local
       FROM club_classes c WHERE c.id = $1
     RETURNING id`,
    [classId],
  );
  return { classId, occurrenceId: occurrence.rows[0]?.id ?? '' };
}

/** The real purge path: the GUC that lets the ledgers go, for this club only. */
export async function purgeClub(client: pg.Client, clubId: string): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('pops.purging_club', $1, true)`, [clubId]);
    await client.query(`DELETE FROM clubs WHERE id = $1`, [clubId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** Remove every club whose slug starts with e2e-, and every fixture account. */
export async function cleanupClubFixtures(client: pg.Client): Promise<void> {
  const clubs = await client.query<{ id: string }>(`SELECT id FROM clubs WHERE slug LIKE 'e2e-%'`);
  for (const row of clubs.rows) await purgeClub(client, row.id);
  await client.query(`DELETE FROM users WHERE id LIKE $1`, [`${USER_PREFIX}%`]);
}

/** The SQLSTATE and constraint of a failed statement, for precise assertions. */
export async function failure(
  promise: Promise<unknown>,
): Promise<{ code?: string; constraint?: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; constraint?: string; message: string };
    return { code: e.code, constraint: e.constraint, message: e.message };
  }
  throw new Error('expected the statement to fail, and it succeeded');
}
