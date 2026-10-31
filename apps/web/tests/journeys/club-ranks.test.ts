import { addDaysIso, sofiaToday } from '@sportkarta/lib/clubs';
import { getDb, getPool, sql } from '@sportkarta/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { clubExportCsv } from '@/lib/clubs/export';
import type { RankInput } from '@/lib/clubs/input';
import { eraseMember } from '@/lib/clubs/members';
import {
  awardNextRanks,
  awardRank,
  examReady,
  ladderCandidates,
  ladderForStaff,
  ladderStudents,
  listLadders,
  liveLadderRanks,
  memberRanks,
  moveRank,
  portalRankCount,
  portalRanks,
  removeRank,
  revokeAward,
  saveLadder,
  saveRank,
  setLadderArchived,
} from '@/lib/clubs/ranks';
import type { ClubActor } from '@/lib/clubs/scope';

import { hasDb } from './db';

vi.mock('server-only', () => ({}));

/**
 * Ranks and belts (0056), end to end against real Postgres. What must hold:
 *
 *   * management sets up ladders and ranks; trainers and management award and
 *     revoke — the club's own staff only, never the desk nor an NGO admin;
 *     another club sees nothing;
 *   * the database numbers the ranks, swaps two in one statement, refuses the
 *     41st, a rank of another ladder, a day in the future, an edit of an
 *     award, and the removal of a rank that was ever awarded;
 *   * the current rank is the newest award not revoked; the next rank's asks
 *     count check-ins since that day, in the ladder's sport only;
 *   * an exam day awards the rank the page showed and skips a client whose
 *     rank changed meanwhile; a newcomer is started on the first rank;
 *   * the portal shows the account's own records and its children's;
 *   * erasing the client takes their awards; the purge takes the rest.
 *
 * COMMITS under its own `e2e-jk-*` clubs and `e2e_club_jk_*` accounts,
 * removed through the real purge path.
 */

const PREFIX = 'e2e_club_jk_';

async function cleanup(): Promise<void> {
  const db = getDb();
  const clubs = await db.execute(sql`SELECT id FROM clubs WHERE slug LIKE 'e2e-jk-%'`);
  for (const row of clubs.rows) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('pops.purging_club', ${String(row.id)}, true)`);
      await tx.execute(sql`DELETE FROM clubs WHERE id = ${String(row.id)}::uuid`);
    });
  }
  await db.execute(sql`DELETE FROM users WHERE id LIKE ${`${PREFIX}%`}`);
}

/** The error a raw statement fails with — it must fail. */
async function refusal(text: string, values: unknown[]): Promise<{ constraint?: string }> {
  try {
    await getPool().query(text, values);
  } catch (error) {
    return error as { constraint?: string };
  }
  throw new Error(`not refused: ${text}`);
}

function rank(nameBg: string, extra: Partial<RankInput> = {}): RankInput {
  return {
    nameBg,
    nameEn: null,
    colour: 'white',
    accent: null,
    stripes: 0,
    minAttendances: null,
    minMonths: null,
    ...extra,
  };
}

describe.skipIf(!hasDb)('club ranks journey (requires running database)', () => {
  let db: ReturnType<typeof getDb>;
  let clubId = '';
  let locationId = '';
  let owner: ClubActor;
  let desk: ClubActor;
  let trainer: ClubActor;
  const today = sofiaToday();

  async function account(label: string): Promise<string> {
    const id = `${PREFIX}${label}_${Math.random().toString(36).slice(2, 8)}`;
    await db.execute(sql`
      INSERT INTO users (id, display_name, email, email_verified)
      VALUES (${id}, ${`Клиент ${label}`}, ${`${id}@example.org`}, true)
    `);
    return id;
  }

  async function staff(role: 'desk' | 'trainer'): Promise<ClubActor> {
    const userId = await account(role);
    await db.execute(sql`
      INSERT INTO club_staff (club_id, user_id, role) VALUES (${clubId}::uuid, ${userId}, ${role})
    `);
    return { userId, clubId, role, ngoAdmin: false };
  }

  /** A client record, linked to a new account unless it is a child. */
  async function client(
    label: string,
    options: { guardian?: string } = {},
  ): Promise<{ memberId: string; userId: string | null }> {
    const created = await db.execute(sql`
      INSERT INTO club_members (club_id, display_name, is_minor, guardian_member_id)
      VALUES (${clubId}::uuid, ${`Клиент ${label}`}, ${options.guardian !== undefined},
              ${options.guardian ?? null}::uuid)
      RETURNING id
    `);
    const memberId = String(created.rows[0]?.id);
    if (options.guardian !== undefined) return { memberId, userId: null };
    const userId = await account(label);
    await db.execute(sql`
      INSERT INTO club_member_links (member_id, club_id, user_id, status, method)
      VALUES (${memberId}::uuid, ${clubId}::uuid, ${userId}, 'active', 'claim')
    `);
    return { memberId, userId };
  }

  /** One past occurrence of a class in `sport`, `daysAgo` days back. */
  async function occurrence(sport: string, daysAgo: number): Promise<string> {
    const klass = await db.execute(sql`
      INSERT INTO club_classes (club_id, location_id, title, sport, starts_at_local,
                                duration_minutes, capacity, public, trial_allowed,
                                booking_opens_hours)
      VALUES (${clubId}::uuid, ${locationId}::uuid, ${`Клас ${sport}`}, ${sport},
              (date_trunc('hour', now()) - make_interval(days => ${daysAgo}::int))
                AT TIME ZONE 'Europe/Sofia',
              60, 20, true, false, 720)
      RETURNING id
    `);
    const result = await db.execute(sql`
      INSERT INTO club_class_occurrences (club_id, class_id, starts_at, ends_at, starts_at_local)
      SELECT c.club_id, c.id, c.starts_at_local AT TIME ZONE 'Europe/Sofia',
             (c.starts_at_local AT TIME ZONE 'Europe/Sofia') + interval '60 minutes',
             c.starts_at_local
        FROM club_classes c WHERE c.id = ${String(klass.rows[0]?.id)}::uuid
      RETURNING id
    `);
    return String(result.rows[0]?.id);
  }

  /** A desk check-in at an occurrence (or the open gym), `daysAgo` days back. */
  async function checkIn(memberId: string, occurrenceId: string | null, daysAgo: number) {
    await db.execute(sql`
      INSERT INTO club_checkins (club_id, member_id, occurrence_id, location_id, method,
                                 recorded_by, covered, sofia_day)
      VALUES (${clubId}::uuid, ${memberId}::uuid, ${occurrenceId}::uuid, ${locationId}::uuid,
              'desk', ${owner.userId}, false,
              (now() AT TIME ZONE 'Europe/Sofia')::date - ${daysAgo}::int)
    `);
  }

  beforeAll(async () => {
    db = getDb();
    await cleanup();
    const ownerId = await account('owner');
    const club = await db.execute(sql`
      INSERT INTO clubs (slug, name_bg, tier, status, approved_at, paid_until, visible)
      VALUES (${`e2e-jk-${Math.random().toString(36).slice(2, 8)}`}, 'Клуб Пояси',
              'community', 'active', now(), (now() + interval '1 year')::date, true)
      RETURNING id
    `);
    clubId = String(club.rows[0]?.id);
    await db.execute(sql`
      INSERT INTO club_staff (club_id, user_id, role) VALUES (${clubId}::uuid, ${ownerId}, 'owner')
    `);
    owner = { userId: ownerId, clubId, role: 'owner', ngoAdmin: false };
    const location = await db.execute(sql`
      INSERT INTO club_locations (club_id, name, address)
      VALUES (${clubId}::uuid, 'Доджо', 'ул. Тестова 2') RETURNING id
    `);
    locationId = String(location.rows[0]?.id);
    desk = await staff('desk');
    trainer = await staff('trainer');
  });

  afterAll(async () => {
    await cleanup();
    await getPool().end();
  });

  it('sets up a ladder, orders its ranks, and awards them from attendance', async () => {
    // Only management sets up a ladder.
    expect(
      await saveLadder(db, trainer, { nameBg: 'Джудо', nameEn: null, sport: 'judo' }, null),
    ).toEqual({ ok: false, error: 'not_allowed' });
    const created = await saveLadder(
      db,
      owner,
      { nameBg: 'Джудо', nameEn: 'Judo', sport: 'judo' },
      null,
      [
        rank('Бял пояс'),
        rank('Жълт пояс', { colour: 'yellow', minAttendances: 2 }),
        rank('Оранжев пояс', { colour: 'orange', accent: 'white', stripes: 2, minMonths: 3 }),
      ],
    );
    if (!created.ok) throw new Error('ladder refused');
    const ladderId = created.ladderId;
    let ladder = await ladderForStaff(owner, ladderId, 'bg');
    expect(ladder?.rankList.map((r) => [r.position, r.name])).toEqual([
      [1, 'Бял пояс'],
      [2, 'Жълт пояс'],
      [3, 'Оранжев пояс'],
    ]);
    const [white, yellow, orange] = ladder?.rankList ?? [];
    if (!white || !yellow || !orange) throw new Error('ranks missing');
    expect(orange).toMatchObject({ colour: 'orange', accent: 'white', stripes: 2, minMonths: 3 });
    expect((await ladderForStaff(owner, ladderId, 'en'))?.name).toBe('Judo');

    // A swap is one statement; moving back restores the order.
    expect(await moveRank(db, desk, orange.id, 'up')).toBe(false);
    expect(await moveRank(db, owner, orange.id, 'up')).toBe(true);
    ladder = await ladderForStaff(owner, ladderId, 'bg');
    expect(ladder?.rankList.map((r) => r.name)).toEqual(['Бял пояс', 'Оранжев пояс', 'Жълт пояс']);
    expect(await moveRank(db, owner, orange.id, 'down')).toBe(true);
    expect(await moveRank(db, owner, orange.id, 'down')).toBe(false);

    // Attendance: judo classes count from the award's day; yoga and the open
    // gym do not, nor a judo class before the award.
    const anna = await client('anna');
    const days = [12, 8, 5, 2];
    const judo = await Promise.all(days.map((daysAgo) => occurrence('judo', daysAgo)));
    for (const [index, occ] of judo.entries()) await checkIn(anna.memberId, occ, days[index] ?? 0);
    await checkIn(anna.memberId, await occurrence('yoga', 3), 3);
    await checkIn(anna.memberId, null, 4);

    // The desk does not grade; an NGO admin never grades for a club.
    const tenDaysAgo = addDaysIso(today, -10);
    const promotion = { awardedOn: tenDaysAgo, reason: 'promotion' as const };
    expect(await awardRank(db, desk, anna.memberId, white.id, promotion)).toEqual({
      ok: false,
      error: 'not_allowed',
    });
    const ngoId = await account('ngo');
    await db.execute(sql`UPDATE users SET role = 'admin' WHERE id = ${ngoId}`);
    const ngo: ClubActor = { userId: ngoId, clubId, role: null, ngoAdmin: true };
    expect(await awardRank(db, ngo, anna.memberId, white.id, promotion)).toEqual({
      ok: false,
      error: 'not_allowed',
    });
    // A trainer does; the same award twice is one.
    expect(await awardRank(db, trainer, anna.memberId, white.id, promotion)).toEqual({ ok: true });
    expect(
      await awardRank(db, trainer, anna.memberId, white.id, { ...promotion, reason: 'exam' }),
    ).toEqual({ ok: false, error: 'already_awarded' });
    expect(
      await awardRank(db, owner, anna.memberId, yellow.id, {
        awardedOn: addDaysIso(today, 1),
        reason: 'exam',
      }),
    ).toEqual({ ok: false, error: 'award_date_future' });

    // 3 judo check-ins since the award (the one 12 days ago is before it):
    // yellow asks 2 — ready.
    const [progress] = await ladderStudents(trainer, ladderId, 'bg');
    expect(progress).toMatchObject({
      memberId: anna.memberId,
      memberName: 'Клиент anna',
      awardedOn: tenDaysAgo,
      attended: 3,
      minAttendances: 2,
      ready: true,
    });
    expect(progress?.current.id).toBe(white.id);
    expect(progress?.next?.id).toBe(yellow.id);
    expect((await examReady(desk, 'bg')).map((row) => row.memberId)).toEqual([anna.memberId]);

    // An exam day: the page showed yellow; a second submit of the same page
    // is skipped (the next is orange now), never orange.
    const pick = [{ memberId: anna.memberId, rankId: yellow.id }];
    expect(
      await awardNextRanks(db, owner, ladderId, pick, { awardedOn: today, reason: 'exam' }),
    ).toEqual({ ok: true, awarded: 1, skipped: 0 });
    expect(
      await awardNextRanks(db, owner, ladderId, pick, { awardedOn: today, reason: 'exam' }),
    ).toEqual({ ok: true, awarded: 0, skipped: 1 });
    const now = await memberRanks(desk, anna.memberId, 'bg');
    expect(now.progress[0]).toMatchObject({ attended: 0, ready: false, minMonths: 3 });
    expect(now.progress[0]?.current.id).toBe(yellow.id);
    expect(now.progress[0]?.next?.id).toBe(orange.id);
    const inThreeMonths = await db.execute(
      sql`SELECT (${today}::date + interval '3 months')::date::text AS d`,
    );
    expect(now.progress[0]?.monthsMetOn).toBe(inThreeMonths.rows[0]?.d);
    expect(now.history.map((award) => award.rank.id)).toEqual([yellow.id, white.id]);

    // Revoked, the yellow award stays in the history and white is current
    // again; an award is never edited, never removed, revoked only once.
    const yellowAward = now.history[0]?.id ?? '';
    expect(await revokeAward(db, desk, yellowAward)).toBeNull();
    expect(await revokeAward(db, trainer, yellowAward)).toBe(anna.memberId);
    expect(await revokeAward(db, trainer, yellowAward)).toBeNull();
    const after = await memberRanks(owner, anna.memberId, 'bg');
    expect(after.progress[0]?.current.id).toBe(white.id);
    expect(after.history[0]?.revokedAt).not.toBeNull();
    expect(
      (
        await refusal('UPDATE club_member_ranks SET reason = $1 WHERE id = $2', [
          'exam',
          yellowAward,
        ])
      ).constraint,
    ).toBe('club_member_ranks_fixed');
    expect(
      (await refusal('DELETE FROM club_member_ranks WHERE id = $1', [yellowAward])).constraint,
    ).toBe('club_member_ranks_fixed');

    // A rank ever awarded stays; an unused one goes.
    expect(await removeRank(db, owner, yellow.id)).toEqual({ ok: false, error: 'rank_in_use' });
    const extra = await saveRank(
      db,
      owner,
      ladderId,
      rank('Зелен пояс', { colour: 'green' }),
      null,
    );
    if (!extra.ok) throw new Error('rank refused');
    expect((await ladderForStaff(owner, ladderId, 'bg'))?.rankList.at(-1)?.position).toBe(4);
    expect(await removeRank(db, desk, extra.rankId)).toEqual({ ok: false, error: 'not_allowed' });
    expect(await removeRank(db, owner, extra.rankId)).toEqual({ ok: true });

    // The audit names the client for every award and revocation.
    const audit = await db.execute(sql`
      SELECT action FROM club_audit
       WHERE club_id = ${clubId}::uuid AND subject_member_id = ${anna.memberId}::uuid
       ORDER BY id
    `);
    expect(audit.rows.map((row) => row.action)).toEqual([
      'rank_awarded',
      'rank_awarded',
      'rank_revoked',
    ]);
  });

  it('starts newcomers on the first rank and shows the portal its own records', async () => {
    const created = await saveLadder(
      db,
      owner,
      { nameBg: 'БЖЖ', nameEn: null, sport: 'bjj' },
      null,
      [rank('Бял'), rank('Син', { colour: 'blue', minAttendances: 1 })],
    );
    if (!created.ok) throw new Error('ladder refused');
    const ladderId = created.ladderId;
    const [white, blue] = (await ladderForStaff(owner, ladderId, 'bg'))?.rankList ?? [];
    if (!white || !blue) throw new Error('ranks missing');

    const parent = await client('parent');
    const child = await client('child', { guardian: parent.memberId });
    const stranger = await client('stranger');
    await checkIn(child.memberId, await occurrence('bjj', 1), 1);
    await checkIn(stranger.memberId, null, 1);

    // Trained in BJJ lately and holds nothing on it: the child, not the
    // stranger (open gym only).
    const candidates = await ladderCandidates(trainer, ladderId);
    expect(candidates.map((c) => c.memberId)).toEqual([child.memberId]);
    expect(candidates[0]).toMatchObject({ visits: 1, lastSeen: addDaysIso(today, -1) });

    // Started on the first rank; a pick of any other rank is skipped.
    expect(
      await awardNextRanks(
        db,
        trainer,
        ladderId,
        [
          { memberId: child.memberId, rankId: white.id },
          { memberId: stranger.memberId, rankId: blue.id },
        ],
        { awardedOn: addDaysIso(today, -1), reason: 'promotion' },
      ),
    ).toEqual({ ok: true, awarded: 1, skipped: 1 });
    expect(await ladderCandidates(trainer, ladderId)).toEqual([]);

    // The guardian's portal shows the child's belt; the stranger's shows none.
    const mine = await portalRanks(String(parent.userId), clubId, 'bg');
    expect(mine.progress.map((row) => [row.memberId, row.current.id, row.attended])).toEqual([
      [child.memberId, white.id, 1],
    ]);
    expect(mine.progress[0]?.ready).toBe(true);
    expect(mine.history.map((award) => award.memberName)).toEqual(['Клиент child']);
    expect(await portalRankCount(String(parent.userId), clubId)).toBe(1);
    expect(await portalRankCount(String(stranger.userId), clubId)).toBe(0);
    expect((await portalRanks(String(stranger.userId), clubId, 'bg')).progress).toEqual([]);

    // Archived, the ladder leaves the forms and the exam list and takes no award.
    expect(await setLadderArchived(db, desk, ladderId, true)).toBe(false);
    expect(await setLadderArchived(db, owner, ladderId, true)).toBe(true);
    expect((await liveLadderRanks(owner, 'bg')).map((l) => l.id)).not.toContain(ladderId);
    expect((await examReady(owner, 'bg')).map((row) => row.ladderId)).not.toContain(ladderId);
    expect(
      await awardRank(db, owner, child.memberId, blue.id, { awardedOn: today, reason: 'exam' }),
    ).toEqual({ ok: false, error: 'not_allowed' });
    expect(await setLadderArchived(db, owner, ladderId, false)).toBe(true);
    expect((await listLadders(desk, 'bg')).map((l) => l.name)).toEqual(['БЖЖ', 'Джудо']);
  });

  it('refuses what the database must refuse, and keeps other clubs out', async () => {
    const created = await saveLadder(
      db,
      owner,
      { nameBg: 'Таекуондо', nameEn: null, sport: null },
      null,
      [rank('Бял')],
    );
    if (!created.ok) throw new Error('ladder refused');
    const ladderId = created.ladderId;

    // Forty ranks to a ladder (the trigger sees the rows the statement added).
    const tooMany = await refusal(
      `INSERT INTO club_ranks (club_id, ladder_id, position, name_bg, colour)
       SELECT $1, $2, 0, 'Пояс ' || n, 'white' FROM generate_series(1, 40) n`,
      [clubId, ladderId],
    );
    expect(tooMany.constraint).toBe('club_ranks_too_many');

    // A rank of another ladder is not this ladder's.
    const other = (await ladderForStaff(owner, ladderId, 'bg'))?.rankList[0];
    const judo = (await listLadders(owner, 'bg')).find((l) => l.name === 'Джудо');
    const someone = await client('someone');
    expect(
      (
        await refusal(
          `INSERT INTO club_member_ranks (club_id, ladder_id, rank_id, member_id, awarded_on, reason)
           VALUES ($1, $2, $3, $4, current_date - 1, 'exam')`,
          [clubId, judo?.id, other?.id, someone.memberId],
        )
      ).constraint,
    ).toBe('club_member_ranks_rank_fk');

    // A rank never moves to another ladder.
    expect(
      (await refusal('UPDATE club_ranks SET ladder_id = $1 WHERE id = $2', [judo?.id, other?.id]))
        .constraint,
    ).toBe('club_ranks_keep_ladder');

    // Another club's owner sees and does nothing here.
    const elsewhere = await account('elsewhere');
    const otherClub = await db.execute(sql`
      INSERT INTO clubs (slug, name_bg, tier, status, approved_at, paid_until, visible)
      VALUES (${`e2e-jk-${Math.random().toString(36).slice(2, 8)}`}, 'Друг клуб',
              'community', 'active', now(), (now() + interval '1 year')::date, true)
      RETURNING id
    `);
    await db.execute(sql`
      INSERT INTO club_staff (club_id, user_id, role)
      VALUES (${String(otherClub.rows[0]?.id)}::uuid, ${elsewhere}, 'owner')
    `);
    const intruder: ClubActor = { userId: elsewhere, clubId, role: 'owner', ngoAdmin: false };
    expect(await listLadders(intruder, 'bg')).toEqual([]);
    expect(await ladderForStaff(intruder, ladderId, 'bg')).toBeNull();
    expect(
      await awardRank(db, intruder, someone.memberId, String(other?.id), {
        awardedOn: today,
        reason: 'exam',
      }),
    ).toEqual({ ok: false, error: 'not_allowed' });
    expect(await saveRank(db, intruder, ladderId, rank('Чужд'), null)).toEqual({
      ok: false,
      error: 'not_allowed',
    });
  });

  it('exports every award, and erasing a client takes theirs', async () => {
    const csv = await clubExportCsv(owner, 'ranks');
    const lines = csv.replace(/^\uFEFF/, '').split('\r\n');
    expect(lines[0]).toBe('ladder,rank,position,member,awarded_on,reason,recorded_by,revoked_at');
    // The revoked yellow award is in it, with the time it was revoked.
    const yellowLine = lines.find((line) => line.startsWith('Джудо,Жълт пояс,2,Клиент anna,'));
    expect(yellowLine?.split(',').at(-1)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

    const erased = await client('erased');
    const ladder = (await liveLadderRanks(owner, 'bg')).find((l) => l.name === 'Джудо');
    const first = ladder?.ranks[0];
    expect(
      await awardRank(db, owner, erased.memberId, String(first?.id), {
        awardedOn: today,
        reason: 'prior',
      }),
    ).toEqual({ ok: true });
    expect(await eraseMember(db, owner, erased.memberId)).toBe('ok');
    const left = await db.execute(sql`
      SELECT count(*)::int AS n FROM club_member_ranks WHERE member_id = ${erased.memberId}::uuid
    `);
    expect(left.rows[0]?.n).toBe(0);
  });

  it('keeps grading with the club’s own staff, and the portal with live links', async () => {
    const created = await saveLadder(
      db,
      owner,
      { nameBg: 'Карате', nameEn: null, sport: 'karate' },
      null,
      [rank('Бял'), rank('Жълт', { colour: 'yellow' }), rank('Зелен', { colour: 'green' })],
    );
    if (!created.ok) throw new Error('ladder refused');
    const ladderId = created.ladderId;
    const [white, yellow, green] = (await ladderForStaff(owner, ladderId, 'bg'))?.rankList ?? [];
    if (!white || !yellow || !green) throw new Error('ranks missing');
    const pupil = await client('pupil');
    const startPick = [{ memberId: pupil.memberId, rankId: white.id }];
    const day = { awardedOn: addDaysIso(today, -3), reason: 'promotion' as const };

    // The desk, an NGO admin and another club's owner never award an exam day.
    const ngoId = await account('ngo2');
    await db.execute(sql`UPDATE users SET role = 'admin' WHERE id = ${ngoId}`);
    const ngo: ClubActor = { userId: ngoId, clubId, role: null, ngoAdmin: true };
    const elsewhere = await account('elsewhere2');
    const intruder: ClubActor = { userId: elsewhere, clubId, role: 'owner', ngoAdmin: false };
    for (const actor of [desk, ngo, intruder]) {
      expect(await awardNextRanks(db, actor, ladderId, startPick, day)).toEqual({
        ok: false,
        error: 'not_allowed',
      });
    }
    expect(await awardNextRanks(db, trainer, ladderId, startPick, day)).toEqual({
      ok: true,
      awarded: 1,
      skipped: 0,
    });

    // A day before the current rank's is skipped: it would never become current.
    const early = { awardedOn: addDaysIso(today, -5), reason: 'exam' as const };
    expect(
      await awardNextRanks(
        db,
        owner,
        ladderId,
        [{ memberId: pupil.memberId, rankId: yellow.id }],
        early,
      ),
    ).toEqual({ ok: true, awarded: 0, skipped: 1 });

    // Only the club's own grading staff revoke; a revoked rank may be given again that day.
    const award = (await memberRanks(owner, pupil.memberId, 'bg')).history[0]?.id ?? '';
    for (const actor of [desk, ngo, intruder]) {
      expect(await revokeAward(db, actor, award)).toBeNull();
    }
    expect(await revokeAward(db, owner, award)).toBe(pupil.memberId);
    expect(await awardRank(db, owner, pupil.memberId, white.id, day)).toEqual({ ok: true });

    // Setting up the ladder is management's: neither a trainer nor another club.
    for (const actor of [trainer, intruder]) {
      expect(await saveRank(db, actor, ladderId, rank('Чужд'), null)).toEqual({
        ok: false,
        error: 'not_allowed',
      });
      expect(await moveRank(db, actor, green.id, 'up')).toBe(false);
      expect(await removeRank(db, actor, green.id)).toEqual({ ok: false, error: 'not_allowed' });
      expect(await setLadderArchived(db, actor, ladderId, true)).toBe(false);
    }
    expect((await ladderForStaff(owner, ladderId, 'bg'))?.rankList.map((r) => r.id)).toEqual([
      white.id,
      yellow.id,
      green.id,
    ]);

    // Another club reads nothing of it.
    expect(await ladderStudents(intruder, ladderId, 'bg')).toEqual([]);
    expect(await examReady(intruder, 'bg')).toEqual([]);
    expect(await ladderCandidates(intruder, ladderId)).toEqual([]);
    expect(await memberRanks(intruder, pupil.memberId, 'bg')).toEqual({
      progress: [],
      history: [],
    });

    // An archived client takes no award.
    const gone = await client('gone');
    await db.execute(
      sql`UPDATE club_members SET archived_at = now() WHERE id = ${gone.memberId}::uuid`,
    );
    expect(
      await awardRank(db, owner, gone.memberId, white.id, { awardedOn: today, reason: 'exam' }),
    ).toEqual({ ok: false, error: 'not_allowed' });

    // A pending link shows the portal nothing.
    await db.execute(sql`
      UPDATE club_member_links SET status = 'pending' WHERE member_id = ${pupil.memberId}::uuid
    `);
    expect(await portalRankCount(String(pupil.userId), clubId)).toBe(0);
    expect(await portalRanks(String(pupil.userId), clubId, 'bg')).toEqual({
      progress: [],
      history: [],
    });
  });
});
