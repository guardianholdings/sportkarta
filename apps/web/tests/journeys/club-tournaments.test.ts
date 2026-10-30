import { getDb, getPool, sql } from '@sportkarta/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  cancelEventPlace,
  publishEvent,
  registerForEvent,
  saveEvent,
  saveEventTicket,
} from '@/lib/clubs/events';
import { clubExportCsv } from '@/lib/clubs/export';
import type { EventInput } from '@/lib/clubs/input';
import type { ClubActor } from '@/lib/clubs/scope';
import { unlinkRecord } from '@/lib/clubs/links';
import { eraseMember } from '@/lib/clubs/members';
import {
  clubRatings,
  drawTournament,
  hideEntrantName,
  memberNameConsents,
  publicTournament,
  recordMatch,
  setNamePublic,
  tournamentForStaff,
} from '@/lib/clubs/tournaments';

import { hasDb } from './db';

vi.mock('server-only', () => ({}));

/**
 * Tournaments (0054), end to end against real Postgres. What must hold:
 *
 *   * management draws; a trainer records results but does not draw; the
 *     desk does neither; another club sees nothing;
 *   * single elimination: the byes go to the top seeds and are decided at
 *     once; a winner moves on by itself; no draws; a result is corrected only
 *     while the next match has none; a re-draw only before any result;
 *   * round robin: everybody meets everybody, and the table follows the
 *     results (3 for a win, 1 for a draw);
 *   * the club rating is an Elo fold over results — derived, never stored;
 *   * the public results name an entrant only with their own consent, which
 *     is always withdrawable and ends with the place;
 *   * the database keeps the rest: a bye names its winner, an elimination
 *     match is never a draw and a draw is level, a recorded result is never
 *     deleted, and a drawn tournament keeps its format.
 *
 * COMMITS under its own `e2e-jt-*` clubs and `e2e_club_jt_*` accounts,
 * removed through the real purge path.
 */

const PREFIX = 'e2e_club_jt_';

/** The error a raw statement fails with — it must fail. */
async function refusal(text: string, values: unknown[]): Promise<{ constraint?: string }> {
  try {
    await getPool().query(text, values);
  } catch (error) {
    return error as { constraint?: string };
  }
  throw new Error(`not refused: ${text}`);
}

async function cleanup(): Promise<void> {
  const db = getDb();
  const clubs = await db.execute(sql`SELECT id FROM clubs WHERE slug LIKE 'e2e-jt-%'`);
  for (const row of clubs.rows) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('pops.purging_club', ${String(row.id)}, true)`);
      await tx.execute(sql`DELETE FROM clubs WHERE id = ${String(row.id)}::uuid`);
    });
  }
  await db.execute(sql`DELETE FROM users WHERE id LIKE ${`${PREFIX}%`}`);
}

describe.skipIf(!hasDb)('club tournaments journey (requires running database)', () => {
  let db: ReturnType<typeof getDb>;
  let clubId = '';
  let locationId = '';
  let owner: ClubActor;
  let desk: ClubActor;
  let trainer: ClubActor;

  async function account(label: string): Promise<string> {
    const id = `${PREFIX}${label}_${Math.random().toString(36).slice(2, 8)}`;
    await db.execute(sql`
      INSERT INTO users (id, display_name, email, email_verified)
      VALUES (${id}, ${`Играч ${label}`}, ${`${id}@example.org`}, true)
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

  const hours = (h: number) => new Date(Date.now() + h * 3600_000);

  const input = (startsIn: number): EventInput => ({
    kind: 'tournament',
    titleBg: 'Турнир по тенис',
    titleEn: null,
    descriptionBg: null,
    descriptionEn: null,
    sport: 'tennis',
    locationId,
    resourceId: null,
    startsAt: hours(startsIn),
    endsAt: hours(startsIn + 6),
    registrationOpensAt: null,
    registrationClosesAt: null,
    capacity: null,
    teamEvent: false,
    payment: 'desk',
    cancelDeadlineHours: 0,
    public: true,
  });

  /** A published tournament with `entrants` confirmed players; returns the event and the accounts. */
  async function tournament(
    entrants: number,
    startsIn: number,
  ): Promise<{ eventId: string; players: string[] }> {
    const created = await saveEvent(db, owner, input(startsIn), null);
    if (!created.ok) throw new Error(created.error);
    const ticketSaved = await saveEventTicket(
      db,
      owner,
      created.eventId,
      {
        nameBg: 'Участие',
        nameEn: null,
        priceCents: 0,
        memberPriceCents: null,
        capacity: null,
        audience: 'all',
        sortOrder: 0,
      },
      null,
    );
    expect(ticketSaved.ok).toBe(true);
    expect(await publishEvent(db, owner, created.eventId)).toBe('ok');
    const ticket = await db.execute(sql`
      SELECT id FROM club_event_tickets WHERE event_id = ${created.eventId}::uuid
    `);
    const players: string[] = [];
    for (let i = 0; i < entrants; i += 1) {
      const player = await account(`p${String(i)}`);
      const place = await registerForEvent(
        db,
        { kind: 'member', userId: player, clubId },
        created.eventId,
        { ticketId: String(ticket.rows[0]?.id), memberId: null, teamName: null },
      );
      expect(place).toMatchObject({ ok: true, state: 'confirmed' });
      players.push(player);
    }
    return { eventId: created.eventId, players };
  }

  beforeAll(async () => {
    db = getDb();
    await cleanup();
    const ownerId = await account('owner');
    const club = await db.execute(sql`
      INSERT INTO clubs (slug, name_bg, tier, status, approved_at, paid_until, visible)
      VALUES (${`e2e-jt-${Math.random().toString(36).slice(2, 8)}`}, 'Клуб Турнири', 'standard',
              'active', now(), (now() + interval '1 year')::date, true)
      RETURNING id
    `);
    clubId = String(club.rows[0]?.id);
    await db.execute(sql`
      INSERT INTO club_staff (club_id, user_id, role) VALUES (${clubId}::uuid, ${ownerId}, 'owner')
    `);
    owner = { userId: ownerId, clubId, role: 'owner', ngoAdmin: false };
    const location = await db.execute(sql`
      INSERT INTO club_locations (club_id, name, address)
      VALUES (${clubId}::uuid, 'Кортове', 'ул. Тестова 2') RETURNING id
    `);
    locationId = String(location.rows[0]?.id);
    desk = await staff('desk');
    trainer = await staff('trainer');
  });

  afterAll(async () => {
    await cleanup();
    await getPool().end();
  });

  it('draws an elimination with byes for the top seeds and moves winners on', async () => {
    const { eventId } = await tournament(5, 48);
    expect(await drawTournament(db, trainer, eventId, 'single_elimination', 'arrival')).toEqual({
      ok: false,
      error: 'not_allowed',
    });
    expect(await drawTournament(db, desk, eventId, 'single_elimination', 'arrival')).toEqual({
      ok: false,
      error: 'not_allowed',
    });
    expect(await drawTournament(db, owner, eventId, 'single_elimination', 'arrival')).toEqual({
      ok: true,
      matches: 7,
    });
    const view = await tournamentForStaff(owner, eventId);
    if (!view) throw new Error('no tournament');
    const seed = (n: number) => view.entrants[n - 1]?.registrationId;
    const first = view.matches.filter((m) => m.round === 1);
    // Eight places, five players: seeds 1, 2 and 3 have byes, decided already.
    expect(first.filter((m) => m.status === 'bye').map((m) => m.winner)).toEqual(
      expect.arrayContaining([seed(1), seed(2), seed(3)]),
    );
    const second = view.matches.filter((m) => m.round === 2);
    expect(second.flatMap((m) => [m.a, m.b]).filter(Boolean)).toHaveLength(3);

    // The one real first-round match: seed 4 against seed 5. A trainer records it.
    const real = first.find((m) => m.status === 'pending');
    if (!real) throw new Error('no match');
    expect(
      await recordMatch(db, desk, eventId, real.id, { kind: 'score', scoreA: 6, scoreB: 3 }),
    ).toEqual({ ok: false, error: 'not_allowed' });
    expect(
      await recordMatch(db, trainer, eventId, real.id, { kind: 'score', scoreA: 4, scoreB: 4 }),
    ).toEqual({ ok: false, error: 'draw_not_allowed' });
    expect(
      await recordMatch(db, trainer, eventId, real.id, { kind: 'score', scoreA: 6, scoreB: 3 }),
    ).toEqual({ ok: true });
    const after = await tournamentForStaff(owner, eventId);
    const winnerOfReal = after?.matches.find((m) => m.id === real.id)?.winner;
    expect(after?.matches.filter((m) => m.round === 2).flatMap((m) => [m.a, m.b])).toContain(
      winnerOfReal,
    );
    // A correction stands while the next match has no result: the other wins.
    expect(
      await recordMatch(db, trainer, eventId, real.id, { kind: 'score', scoreA: 2, scoreB: 6 }),
    ).toEqual({ ok: true });
    const corrected = await tournamentForStaff(owner, eventId);
    const newWinner = corrected?.matches.find((m) => m.id === real.id)?.winner;
    expect(newWinner).not.toBe(winnerOfReal);
    // The new winner takes the old one's side of the next match.
    const next = corrected?.matches.find(
      (m) => m.round === 2 && m.slot === Math.floor(real.slot / 2),
    );
    expect(next?.[real.slot % 2 === 0 ? 'a' : 'b']).toBe(newWinner);
    expect([next?.a, next?.b]).not.toContain(winnerOfReal);
    const nextOfReal = corrected?.matches.find(
      (m) => m.round === 2 && (m.a === newWinner || m.b === newWinner),
    );
    expect(nextOfReal).toBeDefined();
    if (!nextOfReal) return;
    // Once the next match is played, the earlier result is fixed.
    expect(
      await recordMatch(db, owner, eventId, nextOfReal.id, { kind: 'walkover', winner: 'a' }),
    ).toEqual({ ok: true });
    expect(
      await recordMatch(db, trainer, eventId, real.id, { kind: 'score', scoreA: 6, scoreB: 0 }),
    ).toEqual({ ok: false, error: 'next_played' });
    // And a re-draw is refused once anything is recorded.
    expect(await drawTournament(db, owner, eventId, 'round_robin', 'arrival')).toEqual({
      ok: false,
      error: 'results_exist',
    });
  });

  it('runs a round robin whose table follows the results, and rates the players', async () => {
    const { eventId, players } = await tournament(3, 72);
    expect(await drawTournament(db, owner, eventId, 'round_robin', 'arrival')).toEqual({
      ok: true,
      matches: 3,
    });
    const view = await tournamentForStaff(owner, eventId);
    if (!view) throw new Error('no tournament');
    const [m1, m2, m3] = view.matches;
    if (!m1 || !m2 || !m3) throw new Error('matches');
    const recordedAt = async (id: string) =>
      String(
        (
          await db.execute(
            sql`SELECT recorded_at::text AS at FROM club_tournament_matches WHERE id = ${id}::uuid`,
          )
        ).rows[0]?.at,
      );
    expect(
      await recordMatch(db, trainer, eventId, m1.id, { kind: 'score', scoreA: 3, scoreB: 1 }),
    ).toEqual({ ok: true });
    expect(
      await recordMatch(db, trainer, eventId, m2.id, { kind: 'score', scoreA: 2, scoreB: 2 }),
    ).toEqual({ ok: true });
    expect(
      await recordMatch(db, trainer, eventId, m3.id, { kind: 'score', scoreA: 0, scoreB: 1 }),
    ).toEqual({ ok: true });
    const table = (await tournamentForStaff(owner, eventId))?.standings ?? [];
    expect(table).toHaveLength(3);
    expect(table.reduce((sum, row) => sum + row.points, 0)).toBe(3 + 1 + 1 + 3);
    // A correction keeps the match's place in the ratings' fold.
    const firstAt = await recordedAt(m1.id);
    expect(
      await recordMatch(db, trainer, eventId, m1.id, { kind: 'score', scoreA: 3, scoreB: 0 }),
    ).toEqual({ ok: true });
    expect(await recordedAt(m1.id)).toBe(firstAt);
    // A played match is won by the higher score; level is a draw.
    expect(
      (await refusal(`UPDATE club_tournament_matches SET winner = NULL WHERE id = $1`, [m1.id]))
        .constraint,
    ).toBe('club_tournament_matches_winner_by_score');

    const ratings = await clubRatings(owner, 'tennis');
    expect(ratings.length).toBeGreaterThanOrEqual(3);
    expect(ratings.every((r) => r.rating > 1400 && r.rating < 1600)).toBe(true);
    // The front of house sees them (members.view); a trainer does not.
    expect((await clubRatings(desk, 'tennis')).length).toBeGreaterThanOrEqual(3);
    expect(await clubRatings(trainer, 'tennis')).toEqual([]);
    // The export carries every match with its result.
    const csv = await clubExportCsv(owner, 'matches');
    expect(csv.split('\n')[0]).toContain('entrant_a');
    expect(csv.split('\n').filter((line) => line.includes('played')).length).toBeGreaterThanOrEqual(
      3,
    );

    // Public results: no name until the entrant consents to it.
    const before = await publicTournament(clubId, eventId);
    expect(before?.entrants.every((e) => e.name === null && e.memberId === null)).toBe(true);
    const own = await db.execute(sql`
      SELECT er.id FROM club_event_registrations er
        JOIN club_member_links l ON l.member_id = er.member_id AND l.user_id = ${players[0]}
       WHERE er.event_id = ${eventId}::uuid
    `);
    const placeId = String(own.rows[0]?.id);
    // Not somebody else's place.
    expect(await setNamePublic(db, String(players[1]), clubId, placeId, true)).toBe(false);
    expect(await setNamePublic(db, String(players[0]), clubId, placeId, true)).toBe(true);
    const after = await publicTournament(clubId, eventId);
    expect(after?.entrants.filter((e) => e.name !== null)).toHaveLength(1);
    expect(after?.entrants.find((e) => e.registrationId === placeId)?.name).toContain('Играч');
    // Hiding twice is no error; the desk hides one on request; nobody shows
    // one but the entrant.
    expect(await setNamePublic(db, String(players[0]), clubId, placeId, false)).toBe(true);
    expect(await setNamePublic(db, String(players[0]), clubId, placeId, false)).toBe(true);
    expect(await setNamePublic(db, String(players[0]), clubId, placeId, true)).toBe(true);
    expect(await hideEntrantName(db, desk, placeId)).toBe(true);
    expect(await hideEntrantName(db, desk, placeId)).toBe(false);
    // A consent goes with the link it was given through.
    expect(await setNamePublic(db, String(players[0]), clubId, placeId, true)).toBe(true);
    const memberId = String(
      (
        await db.execute(
          sql`SELECT member_id FROM club_event_registrations WHERE id = ${placeId}::uuid`,
        )
      ).rows[0]?.member_id,
    );
    expect(await unlinkRecord(db, { kind: 'member', userId: String(players[0]) }, memberId)).toBe(
      true,
    );
    expect((await publicTournament(clubId, eventId))?.entrants.every((e) => e.name === null)).toBe(
      true,
    );
    const left = await db.execute(
      sql`SELECT name_public_at FROM club_event_registrations WHERE id = ${placeId}::uuid`,
    );
    expect(left.rows[0]?.name_public_at).toBeNull();
  });

  it('shows another club nothing', async () => {
    const { eventId } = await tournament(2, 96);
    const otherOwner = await account('owner2');
    const other = await db.execute(sql`
      INSERT INTO clubs (slug, name_bg, tier, status, approved_at, paid_until)
      VALUES (${`e2e-jt-${Math.random().toString(36).slice(2, 8)}`}, 'Друг', 'standard', 'active',
              now(), (now() + interval '1 year')::date)
      RETURNING id
    `);
    const otherClub = String(other.rows[0]?.id);
    await db.execute(sql`
      INSERT INTO club_staff (club_id, user_id, role)
      VALUES (${otherClub}::uuid, ${otherOwner}, 'owner')
    `);
    const stranger: ClubActor = {
      userId: otherOwner,
      clubId: otherClub,
      role: 'owner',
      ngoAdmin: false,
    };
    expect(await tournamentForStaff(stranger, eventId)).toBeNull();
    expect(await drawTournament(db, stranger, eventId, 'round_robin', 'arrival')).toEqual({
      ok: false,
      error: 'not_allowed',
    });
  });

  it('keeps results and formats, and lets a consent always go', async () => {
    const { eventId, players } = await tournament(2, 120);
    expect(await drawTournament(db, owner, eventId, 'single_elimination', 'arrival')).toEqual({
      ok: true,
      matches: 1,
    });
    const final = (await tournamentForStaff(owner, eventId))?.matches[0];
    if (!final?.a) throw new Error('no final');
    const pool = getPool();

    // A bye names its winner; an elimination match is never a draw.
    expect(
      (
        await refusal(
          `INSERT INTO club_tournament_matches (club_id, event_id, round, slot, entrant_a, status)
           VALUES ($1, $2, 9, 0, $3, 'bye')`,
          [clubId, eventId, final.a],
        )
      ).constraint,
    ).toBe('club_tournament_matches_result_shape');
    expect(
      (
        await refusal(
          `UPDATE club_tournament_matches
              SET status = 'played', score_a = 2, score_b = 2, recorded_at = now() WHERE id = $1`,
          [final.id],
        )
      ).constraint,
    ).toBe('club_tournament_matches_decisive');

    // A recorded result stays, and so does the format it was drawn in.
    expect(
      await recordMatch(db, trainer, eventId, final.id, { kind: 'score', scoreA: 6, scoreB: 4 }),
    ).toEqual({ ok: true });
    expect(
      (await refusal(`DELETE FROM club_tournament_matches WHERE id = $1`, [final.id])).constraint,
    ).toBe('club_tournament_matches_kept');
    // Nor withdrawn by turning it back into a pending match.
    expect(
      (
        await refusal(
          `UPDATE club_tournament_matches
              SET status = 'pending', score_a = NULL, score_b = NULL, winner = NULL,
                  recorded_at = NULL, recorded_by = NULL
            WHERE id = $1`,
          [final.id],
        )
      ).constraint,
    ).toBe('club_tournament_matches_kept');
    expect(
      (
        await refusal(`UPDATE club_events SET tournament_format = 'round_robin' WHERE id = $1`, [
          eventId,
        ])
      ).constraint,
    ).toBe('club_events_tournament_format_kept');

    // The consent: given on a live place and listed for withdrawal ...
    const own = await pool.query(
      `SELECT er.id FROM club_event_registrations er
         JOIN club_member_links l ON l.member_id = er.member_id AND l.user_id = $1
        WHERE er.event_id = $2`,
      [players[0], eventId],
    );
    const placeId = String(own.rows[0]?.id);
    const consentOf = async () =>
      (
        await pool.query(`SELECT name_public_at FROM club_event_registrations WHERE id = $1`, [
          placeId,
        ])
      ).rows[0]?.name_public_at;
    expect(await setNamePublic(db, String(players[0]), clubId, placeId, true)).toBe(true);
    expect(await memberNameConsents(String(players[0]), clubId, eventId)).toEqual([
      { registrationId: placeId, memberName: expect.stringContaining('Играч') },
    ]);
    // ... ends with the place, and is never given again there.
    expect(
      await cancelEventPlace(db, { kind: 'member', userId: String(players[0]), clubId }, placeId),
    ).toMatchObject({ ok: true });
    expect(await consentOf()).toBeNull();
    expect(await setNamePublic(db, String(players[0]), clubId, placeId, true)).toBe(false);
    await pool.query(`UPDATE club_event_registrations SET name_public_at = now() WHERE id = $1`, [
      placeId,
    ]);
    expect(await consentOf()).toBeNull();
    expect(await memberNameConsents(String(players[0]), clubId, eventId)).toEqual([]);
    // The withdrawn entrant keeps their number in the draw, unnamed in public.
    const results = await publicTournament(clubId, eventId);
    expect(results?.entrants.find((e) => e.registrationId === placeId)).toMatchObject({
      withdrawn: true,
      name: null,
      memberId: null,
    });

    // A drawn tournament keeps its kind, sport and team format on a save.
    const saved = await saveEvent(
      db,
      owner,
      { ...input(120), kind: 'event', sport: 'football', teamEvent: true, titleBg: 'Преименуван' },
      eventId,
    );
    expect(saved.ok).toBe(true);
    const kept = await db.execute(
      sql`SELECT kind, sport, team_event, title_bg FROM club_events WHERE id = ${eventId}::uuid`,
    );
    expect(kept.rows[0]).toMatchObject({
      kind: 'tournament',
      sport: 'tennis',
      team_event: false,
      title_bg: 'Преименуван',
    });

    // A match of another tournament is not this one's to record.
    const other = await tournament(2, 130);
    expect(await drawTournament(db, owner, other.eventId, 'round_robin', 'arrival')).toMatchObject({
      ok: true,
    });
    expect(
      await recordMatch(db, owner, other.eventId, final.id, {
        kind: 'score',
        scoreA: 1,
        scoreB: 0,
      }),
    ).toEqual({ ok: false, error: 'not_allowed' });
  });

  it('lets a consent go with the guardian and with the account it came from', async () => {
    const { eventId, players } = await tournament(2, 140);
    const [parent, rival] = players.map(String);
    const memberOf = async (userId: string) =>
      String(
        (
          await db.execute(
            sql`SELECT member_id FROM club_member_links WHERE club_id = ${clubId}::uuid
                 AND user_id = ${userId} AND status = 'active'`,
          )
        ).rows[0]?.member_id,
      );
    const parentMember = await memberOf(String(parent));
    const child = await db.execute(sql`
      INSERT INTO club_members (club_id, display_name, is_minor, guardian_member_id)
      VALUES (${clubId}::uuid, 'Дете на играч', true, ${parentMember}::uuid) RETURNING id
    `);
    const childId = String(child.rows[0]?.id);
    const ticket = await db.execute(
      sql`SELECT id FROM club_event_tickets WHERE event_id = ${eventId}::uuid`,
    );
    const placed = await registerForEvent(
      db,
      { kind: 'member', userId: String(parent), clubId },
      eventId,
      { ticketId: String(ticket.rows[0]?.id), memberId: childId, teamName: null },
    );
    expect(placed).toMatchObject({ ok: true, state: 'confirmed' });
    const placeOf = async (memberId: string) =>
      String(
        (
          await db.execute(sql`SELECT id FROM club_event_registrations
                                WHERE event_id = ${eventId}::uuid AND member_id = ${memberId}::uuid`)
        ).rows[0]?.id,
      );
    const consentOf = async (placeId: string) =>
      (
        await db.execute(
          sql`SELECT name_public_at FROM club_event_registrations WHERE id = ${placeId}::uuid`,
        )
      ).rows[0]?.name_public_at ?? null;
    const childPlace = await placeOf(childId);
    const parentPlace = await placeOf(parentMember);

    // The guardian decides for a child without an account of their own ...
    expect(await setNamePublic(db, String(parent), clubId, childPlace, true)).toBe(true);
    expect(await setNamePublic(db, String(rival), clubId, childPlace, true)).toBe(false);
    // ... and the consent goes when the guardian does.
    await db.execute(
      sql`UPDATE club_members SET guardian_member_id = NULL WHERE id = ${childId}::uuid`,
    );
    expect(await consentOf(childPlace)).toBeNull();

    // A link moved to another account takes its consents with it — its
    // client's and the children's.
    await db.execute(
      sql`UPDATE club_members SET guardian_member_id = ${parentMember}::uuid WHERE id = ${childId}::uuid`,
    );
    expect(await setNamePublic(db, String(parent), clubId, childPlace, true)).toBe(true);
    expect(await setNamePublic(db, String(parent), clubId, parentPlace, true)).toBe(true);
    const newcomer = await account('newcomer');
    await db.execute(
      sql`UPDATE club_member_links SET user_id = ${newcomer} WHERE member_id = ${parentMember}::uuid`,
    );
    expect(await consentOf(childPlace)).toBeNull();
    expect(await consentOf(parentPlace)).toBeNull();

    // Erasing the guardian takes a child's consent with it (the guardian key
    // SETs NULL, and that clears it).
    expect(await setNamePublic(db, newcomer, clubId, childPlace, true)).toBe(true);
    expect(await eraseMember(db, owner, parentMember)).toBe('ok');
    expect(await consentOf(childPlace)).toBeNull();
  });
});
