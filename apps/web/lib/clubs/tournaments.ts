import { getDb, lockEvent, sql, type SQL } from '@sportkarta/db';
import {
  drawnSeeds,
  eloRatings,
  nextMatch,
  roundRobinDraw,
  scoreWinner,
  singleEliminationDraw,
  standings,
  TOURNAMENT_ENTRANTS_MAX,
  TOURNAMENT_ENTRANTS_MIN,
  type MatchStatus,
  type PlayedMatch,
  type Standing,
  type TournamentFormat,
} from '@sportkarta/lib/clubs';

import { clubRenderableSql, clubWritableGuard } from './access';
import { recordClubAudit } from './audit';
import { clubScope, clubWriteScope, memberSelfScope, type ClubActor } from './scope';

/**
 * Tournaments (0054, wave D2 — 1club's tournaments and ratings, anolla's
 * tournaments). A tournament is an event of kind `tournament`. Before the
 * draw its entrants are its CONFIRMED places, numbered by arrival; once drawn,
 * they are the places the draw names, numbered by seed (drawnSeeds) — so a
 * withdrawal keeps its number and a place confirmed later is no entrant.
 * Management draws it (single
 * elimination with byes, or a round robin; seeded by arrival or by the club
 * rating), the people running the matches record results (events.results:
 * management and trainers), and a winner moves on through the bracket by
 * itself. Standings and the club's ratings per sport are DERIVED from the
 * matches on every read (lib/src/clubs/tournament.ts) — never stored.
 *
 * PUBLIC NAMES: the public results show an entrant's name only with their own
 * consent (name_public_at, set from their place on the event page) — the
 * passport's opt-in rule; everybody else is «Участник N». Decided IN THE
 * STATEMENT (a public read never selects a name without consent), and only
 * for a confirmed place whose client still has a live link to an account:
 * 0054 also clears the consent when the link goes, when the place ends and
 * when the client is erased.
 *
 * Every draw and result locks the event row first (0053's order), so they
 * never cross. The consent is the exception: one registration row, a column
 * no trigger counts — it takes no event lock (and so is never refused for the
 * want of one).
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TransactionalDb extends SqlRunner {
  transaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function intOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export interface Entrant {
  registrationId: string;
  /** 1-based: the seed once drawn, else the arrival among the confirmed places. */
  number: number;
  /** Null on the public read. */
  memberId: string | null;
  /**
   * The team's name for a team event, else the client's; null once erased —
   * and on the public read, null without the entrant's consent.
   */
  name: string | null;
  /** The entrant's consent stands (confirmed, linked, not erased). */
  namePublic: boolean;
  /** Drawn, then the place ended. */
  withdrawn: boolean;
}

export interface Match {
  id: string;
  round: number;
  slot: number;
  a: string | null;
  b: string | null;
  scoreA: number | null;
  scoreB: number | null;
  winner: string | null;
  status: MatchStatus;
}

export interface Tournament {
  eventId: string;
  format: TournamentFormat | null;
  teamEvent: boolean;
  sport: string | null;
  entrants: Entrant[];
  matches: Match[];
  /** Round robin only. */
  standings: Standing[] | null;
}

/** A consent that stands: a confirmed place of a client with a live link. */
const CONSENTED = sql`(er.name_public_at IS NOT NULL AND er.member_id IS NOT NULL
  AND er.state = 'confirmed'
  AND EXISTS (SELECT 1 FROM club_member_links nl
               WHERE nl.status = 'active'
                 AND (nl.member_id = m.id OR nl.member_id = m.guardian_member_id)))`;

/**
 * The entrants: `seeds` (drawn) names them and their numbers, else the
 * confirmed places by arrival. `publicView` selects no client and no name
 * without consent.
 */
async function entrantsOf(
  db: SqlRunner,
  clubId: string,
  eventId: string,
  seeds: Map<string, number> | null,
  publicView: boolean,
): Promise<Entrant[]> {
  const name = publicView
    ? sql`CASE WHEN ${CONSENTED} THEN coalesce(er.team_name, m.display_name) END`
    : sql`CASE WHEN er.member_id IS NOT NULL THEN coalesce(er.team_name, m.display_name) END`;
  const result = await db.execute(sql`
    SELECT er.id, er.state, ${publicView ? sql`NULL::uuid` : sql`er.member_id`} AS member_id,
           ${name} AS name, ${CONSENTED} AS name_public
      FROM club_event_registrations er
      LEFT JOIN club_members m ON m.club_id = er.club_id AND m.id = er.member_id
     WHERE er.club_id = ${clubId}::uuid AND er.event_id = ${eventId}::uuid
       AND ${
         seeds === null
           ? sql`er.state = 'confirmed'`
           : sql`er.id = ANY(${sql.param([...seeds.keys()])}::uuid[])`
       }
     ORDER BY er.seq
  `);
  const entrants = result.rows.map((row, i) => ({
    registrationId: String(row.id),
    number: seeds?.get(String(row.id)) ?? i + 1,
    memberId: text(row.member_id),
    name: text(row.name),
    namePublic: row.name_public === true,
    withdrawn: seeds !== null && row.state !== 'confirmed',
  }));
  return entrants.sort((x, y) => x.number - y.number);
}

/** The confirmed places by arrival — the field a draw is made from. */
async function confirmedPlaces(db: SqlRunner, clubId: string, eventId: string): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT er.id FROM club_event_registrations er
     WHERE er.club_id = ${clubId}::uuid AND er.event_id = ${eventId}::uuid
       AND er.state = 'confirmed'
     ORDER BY er.seq
  `);
  return result.rows.map((row) => String(row.id));
}

async function matchesOf(db: SqlRunner, clubId: string, eventId: string): Promise<Match[]> {
  const result = await db.execute(sql`
    SELECT tm.id, tm.round, tm.slot, tm.entrant_a, tm.entrant_b, tm.score_a, tm.score_b,
           tm.winner, tm.status
      FROM club_tournament_matches tm
     WHERE tm.club_id = ${clubId}::uuid AND tm.event_id = ${eventId}::uuid
     ORDER BY tm.round, tm.slot
  `);
  return result.rows.map((row) => ({
    id: String(row.id),
    round: Number(row.round),
    slot: Number(row.slot),
    a: text(row.entrant_a),
    b: text(row.entrant_b),
    scoreA: intOrNull(row.score_a),
    scoreB: intOrNull(row.score_b),
    winner: text(row.winner),
    status: String(row.status) as MatchStatus,
  }));
}

function played(match: Match): PlayedMatch {
  return {
    a: match.a,
    b: match.b,
    scoreA: match.scoreA,
    scoreB: match.scoreB,
    status: match.status,
    winner: match.winner,
  };
}

async function assemble(
  db: SqlRunner,
  clubId: string,
  event: Record<string, unknown>,
  publicView: boolean,
): Promise<Tournament> {
  const eventId = String(event.id);
  const format = text(event.tournament_format) as TournamentFormat | null;
  const matches = await matchesOf(db, clubId, eventId);
  const seeds = format !== null && matches.length > 0 ? drawnSeeds(format, matches) : null;
  const entrants = await entrantsOf(db, clubId, eventId, seeds, publicView);
  return {
    eventId,
    format,
    teamEvent: event.team_event === true,
    sport: text(event.sport),
    entrants,
    matches,
    standings:
      format === 'round_robin'
        ? standings(
            entrants.map((e) => e.registrationId),
            matches.map(played),
          )
        : null,
  };
}

/**
 * The office's view, every entrant named — for every staff role
 * (schedule.view): the trainers who record results need to know who plays
 * whom, and a draw names nobody beyond the event's own entrants.
 */
export async function tournamentForStaff(
  actor: ClubActor,
  eventId: string,
): Promise<Tournament | null> {
  const db = getDb();
  const event = (
    await db.execute(sql`
      SELECT ev.id, ev.tournament_format, ev.team_event, ev.sport
        FROM club_events ev
       WHERE ev.id = ${eventId}::uuid AND ev.kind = 'tournament'
         AND ${clubScope(actor, 'schedule.view', 'ev')}
    `)
  ).rows[0];
  return event ? assemble(db, actor.clubId, event, false) : null;
}

/**
 * The public results of a published tournament of a shown club. Names only
 * for entrants who consented — the rest are «Участник N», by the page; this
 * never returns a name or a client without consent.
 */
export async function publicTournament(
  clubId: string,
  eventId: string,
): Promise<Tournament | null> {
  const db = getDb();
  const event = (
    await db.execute(sql`
      SELECT ev.id, ev.tournament_format, ev.team_event, ev.sport
        FROM club_events ev JOIN clubs c ON c.id = ev.club_id
       WHERE ev.club_id = ${clubId}::uuid AND ev.id = ${eventId}::uuid
         AND ev.kind = 'tournament' AND ev.public AND ev.status = 'published'
         AND ${clubRenderableSql('c')}
    `)
  ).rows[0];
  return event ? assemble(db, clubId, event, true) : null;
}

/**
 * Ratings per club and sport: an Elo fold over every result of the club's
 * individual tournaments in that sport, in the order they were first
 * recorded — a correction keeps its match's place (team events rate nobody). Derived on every read; by client record, names
 * for members.view only — decided in the statement.
 */
export async function clubRatings(
  actor: ClubActor,
  sport: string,
): Promise<{ memberId: string; name: string; rating: number; played: number }[]> {
  const db = getDb();
  const rows = await db.execute(sql`
    SELECT ra.member_id AS a, rb.member_id AS b, tm.score_a, tm.score_b
      FROM club_tournament_matches tm
      JOIN club_events ev ON ev.club_id = tm.club_id AND ev.id = tm.event_id
      JOIN club_event_registrations ra ON ra.club_id = tm.club_id AND ra.id = tm.entrant_a
      JOIN club_event_registrations rb ON rb.club_id = tm.club_id AND rb.id = tm.entrant_b
     WHERE ${clubScope(actor, 'members.view', 'tm')} AND ev.sport = ${sport}
       AND NOT ev.team_event AND tm.status = 'played'
       AND ra.member_id IS NOT NULL AND rb.member_id IS NOT NULL
     ORDER BY tm.recorded_at, tm.id
  `);
  const matches: PlayedMatch[] = rows.rows.map((row) => ({
    a: String(row.a),
    b: String(row.b),
    scoreA: intOrNull(row.score_a),
    scoreB: intOrNull(row.score_b),
    status: 'played',
    winner: null,
  }));
  const ratings = eloRatings(matches);
  if (ratings.size === 0) return [];
  const playedCount = new Map<string, number>();
  for (const match of matches) {
    for (const id of [match.a, match.b]) {
      if (id) playedCount.set(id, (playedCount.get(id) ?? 0) + 1);
    }
  }
  const names = await db.execute(sql`
    SELECT m.id, m.display_name FROM club_members m
     WHERE ${clubScope(actor, 'members.view', 'm')}
       AND m.id = ANY(${sql.param([...ratings.keys()])}::uuid[])
  `);
  const nameOf = new Map(names.rows.map((row) => [String(row.id), String(row.display_name)]));
  return [...ratings.entries()]
    .filter(([id]) => nameOf.has(id))
    .map(([memberId, rating]) => ({
      memberId,
      name: nameOf.get(memberId) ?? '',
      rating,
      played: playedCount.get(memberId) ?? 0,
    }))
    .sort((x, y) => y.rating - x.rating || x.name.localeCompare(y.name));
}

/** The sports the club has drawn individual tournaments in (the ratings page's picker). */
export async function ratedSports(actor: ClubActor): Promise<string[]> {
  const result = await getDb().execute(sql`
    SELECT DISTINCT ev.sport FROM club_events ev
     WHERE ${clubScope(actor, 'members.view', 'ev')} AND ev.kind = 'tournament'
       AND ev.sport IS NOT NULL AND NOT ev.team_event AND ev.tournament_format IS NOT NULL
     ORDER BY ev.sport
  `);
  return result.rows.map((row) => String(row.sport));
}

export type DrawResult =
  | { ok: true; matches: number }
  | { ok: false; error: 'not_allowed' | 'too_few' | 'too_many' | 'results_exist' };

/** The event's confirmed places by the club rating in its sport, best first; null: by arrival. */
async function ratingOrder(actor: ClubActor, eventId: string): Promise<string[] | null> {
  const event = (
    await getDb().execute(sql`
      SELECT ev.sport, ev.team_event FROM club_events ev
       WHERE ev.id = ${eventId}::uuid AND ${clubScope(actor, 'events.manage', 'ev')}
    `)
  ).rows[0];
  if (!event || !event.sport || event.team_event === true) return null;
  const ratings = new Map(
    (await clubRatings(actor, String(event.sport))).map((r) => [r.memberId, r.rating]),
  );
  const places = await getDb().execute(sql`
    SELECT er.id, er.member_id FROM club_event_registrations er
     WHERE ${clubScope(actor, 'events.manage', 'er')} AND er.event_id = ${eventId}::uuid
       AND er.state = 'confirmed'
     ORDER BY er.seq
  `);
  return places.rows
    .map((row, i) => ({
      id: String(row.id),
      rating: ratings.get(String(row.member_id)) ?? 0,
      arrival: i,
    }))
    .sort((x, y) => y.rating - x.rating || x.arrival - y.arrival)
    .map((row) => row.id);
}

/**
 * Draw a tournament (events.manage): the confirmed places, seeded by arrival
 * or by the club rating in the event's sport (individual events only; an
 * unrated entrant is seeded last, by arrival). A fresh draw replaces the old
 * one only while no result is recorded. In single elimination a first-round
 * bye is decided at once and its entrant moved into round two.
 */
export async function drawTournament(
  db: TransactionalDb,
  actor: ClubActor,
  eventId: string,
  format: TournamentFormat,
  seeding: 'arrival' | 'rating',
): Promise<DrawResult> {
  const ranked = seeding === 'rating' ? await ratingOrder(actor, eventId) : null;
  return db.transaction(async (tx): Promise<DrawResult> => {
    if (!(await lockEvent(tx, actor.clubId, eventId))) return { ok: false, error: 'not_allowed' };
    const event = (
      await tx.execute(sql`
        SELECT ev.id FROM club_events ev
         WHERE ev.id = ${eventId}::uuid AND ev.kind = 'tournament' AND ev.status <> 'cancelled'
           AND ${clubWriteScope(actor, 'events.manage', 'ev')}
      `)
    ).rows[0];
    if (!event) return { ok: false, error: 'not_allowed' };
    const recorded = await tx.execute(sql`
      SELECT 1 FROM club_tournament_matches tm
       WHERE tm.club_id = ${actor.clubId}::uuid AND tm.event_id = ${eventId}::uuid
         AND tm.status IN ('played', 'walkover')
       LIMIT 1
    `);
    if (recorded.rows.length > 0) return { ok: false, error: 'results_exist' };
    let entrants = await confirmedPlaces(tx, actor.clubId, eventId);
    if (entrants.length < TOURNAMENT_ENTRANTS_MIN) return { ok: false, error: 'too_few' };
    if (entrants.length > TOURNAMENT_ENTRANTS_MAX) return { ok: false, error: 'too_many' };
    if (ranked) {
      const rank = new Map(ranked.map((id, i) => [id, i]));
      entrants = [...entrants].sort(
        (x, y) =>
          (rank.get(x) ?? Number.MAX_SAFE_INTEGER) - (rank.get(y) ?? Number.MAX_SAFE_INTEGER),
      );
    }
    await tx.execute(sql`
      DELETE FROM club_tournament_matches tm
       WHERE tm.club_id = ${actor.clubId}::uuid AND tm.event_id = ${eventId}::uuid
         AND tm.status IN ('pending', 'bye')
    `);
    await tx.execute(sql`
      UPDATE club_events ev SET tournament_format = ${format}
       WHERE ev.id = ${eventId}::uuid AND ${clubWriteScope(actor, 'events.manage', 'ev')}
    `);
    const draw =
      format === 'single_elimination'
        ? singleEliminationDraw(entrants.length)
        : roundRobinDraw(entrants.length);
    const at = (index: number | null) => (index === null ? null : (entrants[index] ?? null));
    // Byes of the first round are decided now; their entrants wait in round two.
    const advanced = new Map<string, string>();
    if (format === 'single_elimination') {
      for (const match of draw.filter((m) => m.round === 1)) {
        const a = at(match.a);
        const b = at(match.b);
        const lone = a === null ? b : b === null ? a : null;
        if (lone) {
          const next = nextMatch(match.round, match.slot);
          advanced.set(`${String(next.round)}:${String(next.slot)}:${next.side}`, lone);
        }
      }
    }
    const rows = draw.map((match) => {
      const later = format === 'single_elimination' && match.round > 1;
      const a = later
        ? (advanced.get(`${String(match.round)}:${String(match.slot)}:a`) ?? null)
        : at(match.a);
      const b = later
        ? (advanced.get(`${String(match.round)}:${String(match.slot)}:b`) ?? null)
        : at(match.b);
      const bye =
        format === 'single_elimination' && match.round === 1 && (a === null) !== (b === null);
      return { ...match, a, b, winner: bye ? (a ?? b) : null, status: bye ? 'bye' : 'pending' };
    });
    // One statement for the whole draw (a round robin of 128 is 8,128 matches).
    await tx.execute(sql`
      INSERT INTO club_tournament_matches (club_id, event_id, round, slot, entrant_a, entrant_b,
                                           winner, status)
      SELECT ${actor.clubId}::uuid, ${eventId}::uuid, d.round, d.slot, d.a, d.b, d.winner, d.status
        FROM unnest(${sql.param(rows.map((r) => r.round))}::smallint[],
                    ${sql.param(rows.map((r) => r.slot))}::smallint[],
                    ${sql.param(rows.map((r) => r.a))}::uuid[],
                    ${sql.param(rows.map((r) => r.b))}::uuid[],
                    ${sql.param(rows.map((r) => r.winner))}::uuid[],
                    ${sql.param(rows.map((r) => r.status))}::text[])
             AS d(round, slot, a, b, winner, status)
    `);
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'tournament_drawn',
      detail: { eventId, format, seeding, entrants: entrants.length },
    });
    return { ok: true, matches: draw.length };
  });
}

export type MatchResult =
  { kind: 'score'; scoreA: number; scoreB: number } | { kind: 'walkover'; winner: 'a' | 'b' };

export type RecordResult =
  | { ok: true }
  | { ok: false; error: 'not_allowed' | 'not_ready' | 'draw_not_allowed' | 'next_played' };

/**
 * Record (or correct) a match's result (events.results). In single
 * elimination there is no draw, and the winner moves into the next match at
 * once; a correction is accepted only while that next match has no result
 * (a later round must never rest on a result that no longer stands).
 */
export async function recordMatch(
  db: TransactionalDb,
  actor: ClubActor,
  eventId: string,
  matchId: string,
  result: MatchResult,
): Promise<RecordResult> {
  return db.transaction(async (tx): Promise<RecordResult> => {
    if (!(await lockEvent(tx, actor.clubId, eventId))) return { ok: false, error: 'not_allowed' };
    const row = (
      await tx.execute(sql`
        SELECT tm.id, tm.round, tm.slot, tm.entrant_a, tm.entrant_b, tm.status,
               ev.tournament_format
          FROM club_tournament_matches tm
          JOIN club_events ev ON ev.club_id = tm.club_id AND ev.id = tm.event_id
         WHERE tm.id = ${matchId}::uuid AND tm.event_id = ${eventId}::uuid
           AND ev.status <> 'cancelled'
           AND ${clubWriteScope(actor, 'events.results', 'tm')}
           FOR UPDATE OF tm
      `)
    ).rows[0];
    if (!row) return { ok: false, error: 'not_allowed' };
    const a = text(row.entrant_a);
    const b = text(row.entrant_b);
    if (a === null || b === null || row.status === 'bye') return { ok: false, error: 'not_ready' };
    const elimination = row.tournament_format === 'single_elimination';
    let winner: string | null;
    if (result.kind === 'walkover') {
      winner = result.winner === 'a' ? a : b;
    } else {
      winner = scoreWinner({ a, b, scoreA: result.scoreA, scoreB: result.scoreB });
      if (elimination && winner === null) return { ok: false, error: 'draw_not_allowed' };
    }
    if (elimination) {
      const next = nextMatch(Number(row.round), Number(row.slot));
      const following = (
        await tx.execute(sql`
          SELECT tm.id, tm.status FROM club_tournament_matches tm
           WHERE tm.club_id = ${actor.clubId}::uuid AND tm.event_id = ${eventId}::uuid
             AND tm.round = ${next.round} AND tm.slot = ${next.slot}
             FOR UPDATE
        `)
      ).rows[0];
      if (following && following.status !== 'pending') return { ok: false, error: 'next_played' };
      if (following) {
        await tx.execute(sql`
          UPDATE club_tournament_matches tm
             SET ${next.side === 'a' ? sql`entrant_a` : sql`entrant_b`} = ${winner}::uuid
           WHERE tm.id = ${String(following.id)}::uuid
             AND ${clubWriteScope(actor, 'events.results', 'tm')}
        `);
      }
    }
    await tx.execute(sql`
      UPDATE club_tournament_matches tm
         SET status = ${result.kind === 'walkover' ? 'walkover' : 'played'},
             score_a = ${result.kind === 'score' ? result.scoreA : null},
             score_b = ${result.kind === 'score' ? result.scoreB : null},
             winner = ${winner}::uuid, recorded_by = ${actor.userId},
             -- A correction keeps the match's place in the ratings' fold.
             recorded_at = coalesce(tm.recorded_at, now())
       WHERE tm.id = ${matchId}::uuid AND ${clubWriteScope(actor, 'events.results', 'tm')}
    `);
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'match_recorded',
      detail: { eventId, matchId, kind: result.kind },
    });
    return { ok: true };
  });
}

/**
 * The entrant's own consent to a name in the public results — for their own
 * place or a child's. Given only on a confirmed place at a tournament, and
 * only by the client's own account when the client has one (a guardian
 * decides for a child without one). Withdrawn by either, from any place, at
 * any time, the tournament over or the club closed (GDPR Art. 7(3)); hiding
 * a name already hidden is no error. 0054 also clears it when the place
 * ends, the client is erased or the link goes.
 */
export async function setNamePublic(
  db: TransactionalDb,
  userId: string,
  clubId: string,
  registrationId: string,
  on: boolean,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const own = sql`EXISTS (SELECT 1 FROM club_members m
                             WHERE m.club_id = er.club_id AND m.id = er.member_id
                               AND ${memberSelfScope(userId, clubId, 'm')})`;
    const grant = sql`er.state = 'confirmed' AND er.name_public_at IS NULL
      AND ${clubWritableGuard(clubId)}
      AND EXISTS (SELECT 1 FROM club_events ev
                   WHERE ev.club_id = er.club_id AND ev.id = er.event_id AND ev.kind = 'tournament')
      AND (EXISTS (SELECT 1 FROM club_member_links sl
                    WHERE sl.member_id = er.member_id AND sl.user_id = ${userId}
                      AND sl.status = 'active')
           OR NOT EXISTS (SELECT 1 FROM club_member_links ol
                           WHERE ol.member_id = er.member_id AND ol.status = 'active'))`;
    const changed = await tx.execute(sql`
      UPDATE club_event_registrations er
         SET name_public_at = ${on ? sql`now()` : sql`NULL`}
       WHERE er.id = ${registrationId}::uuid AND er.club_id = ${clubId}::uuid
         AND ${on ? grant : sql`er.name_public_at IS NOT NULL`}
         AND ${own}
      RETURNING er.member_id
    `);
    const row = changed.rows[0];
    if (!row) {
      if (on) return false;
      // Already hidden: fine, if it is theirs to hide.
      const mine = await tx.execute(sql`
        SELECT 1 FROM club_event_registrations er
         WHERE er.id = ${registrationId}::uuid AND er.club_id = ${clubId}::uuid AND ${own}
      `);
      return mine.rows.length > 0;
    }
    await recordClubAudit(tx, {
      clubId,
      by: { kind: 'member', userId },
      action: 'name_visibility_changed',
      subjectMemberId: text(row.member_id),
      detail: { registrationId, on },
    });
    return true;
  });
}

/**
 * The desk hides an entrant's name on their request (bookings.manage) — by
 * telephone, at the counter. Never shows one: only the entrant consents. Not
 * gated on a writable club, like the entrant's own withdrawal.
 */
export async function hideEntrantName(
  db: TransactionalDb,
  actor: ClubActor,
  registrationId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const changed = await tx.execute(sql`
      UPDATE club_event_registrations er SET name_public_at = NULL
       WHERE er.id = ${registrationId}::uuid AND er.name_public_at IS NOT NULL
         AND ${clubScope(actor, 'bookings.manage', 'er')}
      RETURNING er.member_id
    `);
    const row = changed.rows[0];
    if (!row) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'name_visibility_changed',
      subjectMemberId: text(row.member_id),
      detail: { registrationId, on: false },
    });
    return true;
  });
}

export interface NameConsent {
  registrationId: string;
  memberName: string;
}

/**
 * The account's own (and its children's) places at this tournament whose name
 * is public — every one, the tournament over or not, so the consent can always
 * be withdrawn from the event page.
 */
export async function memberNameConsents(
  userId: string,
  clubId: string,
  eventId: string,
): Promise<NameConsent[]> {
  const result = await getDb().execute(sql`
    SELECT er.id, m.display_name
      FROM club_event_registrations er
      JOIN club_members m ON m.club_id = er.club_id AND m.id = er.member_id
     WHERE er.club_id = ${clubId}::uuid AND er.event_id = ${eventId}::uuid
       AND er.name_public_at IS NOT NULL
       AND ${memberSelfScope(userId, clubId, 'm')}
     ORDER BY er.seq
     LIMIT 20
  `);
  return result.rows.map((row) => ({
    registrationId: String(row.id),
    memberName: String(row.display_name),
  }));
}
