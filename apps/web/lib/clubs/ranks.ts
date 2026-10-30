import { getDb, sql, type SQL } from '@sportkarta/db';
import type { BeltColour, IsoDate, RankAwardReason } from '@sportkarta/lib/clubs';

import { recordClubAudit } from './audit';
import { violatedConstraint } from './errors';
import type { AwardInput, RankInput } from './input';
import {
  clubActorMay,
  clubScope,
  clubStaffWriteScope,
  clubWriteScope,
  memberSelfScope,
  type ClubActor,
} from './scope';

/**
 * Ranks and belts (0056, wave G2 — 1club's belt tracking): a club's grading
 * ladders, their ranks, the ranks its clients were awarded, and the
 * «Готови за изпит» list. What a client holds and whether they are ready are
 * the view club_member_rank_progress — derived from their check-ins, never
 * stored, and never a refusal: the coach awards whatever rank they decide.
 *
 * Who: management sets up ladders and ranks (ranks.manage); whoever grades —
 * the trainers and management — awards and revokes (ranks.award), as the
 * club's own staff only (clubStaffWriteScope: an NGO admin never grades for a
 * club); every member of staff reads (ranks.view). A trainer reads clients
 * through THE PROJECTION below — a display name, the rank and the attendance
 * count, nothing else (apps/web/tests/club-projections.test.ts). The portal
 * shows the account's own records and its children's (memberSelfScope).
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

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** A ladder's or a rank's name in the page's language (`alias` declared by the statement). */
function nameIn(alias: 'rl' | 'rk' | 'cr' | 'nr', locale: string): SQL {
  const a = sql.raw(alias);
  return sql`CASE WHEN ${locale} = 'en' THEN coalesce(${a}.name_en, ${a}.name_bg) ELSE ${a}.name_bg END`;
}

export interface RankLook {
  colour: BeltColour;
  accent: BeltColour | null;
  stripes: number;
}

export interface RankRef extends RankLook {
  id: string;
  name: string;
}

function rankRef(row: Record<string, unknown>, prefix: string): RankRef | null {
  const id = row[`${prefix}_id`];
  if (id === null || id === undefined) return null;
  return {
    id: String(id),
    name: String(row[`${prefix}_name`]),
    colour: String(row[`${prefix}_colour`]) as BeltColour,
    accent: (text(row[`${prefix}_accent`]) as BeltColour | null) ?? null,
    stripes: Number(row[`${prefix}_stripes`] ?? 0),
  };
}

// ─── Ladders ────────────────────────────────────────────────────────────────

export interface LadderSummary {
  id: string;
  name: string;
  nameBg: string;
  nameEn: string | null;
  sport: string | null;
  archived: boolean;
  ranks: number;
  /** Live clients holding a rank on it. */
  students: number;
  /** Of them, ready for the next rank (club_member_rank_progress). */
  ready: number;
}

function ladderSummaries(actor: ClubActor, locale: string, where: SQL): SQL {
  return sql`
    SELECT rl.id, ${nameIn('rl', locale)} AS name, rl.name_bg, rl.name_en, rl.sport,
           rl.archived_at IS NOT NULL AS archived,
           (SELECT count(*) FROM club_ranks r
             WHERE r.club_id = rl.club_id AND r.ladder_id = rl.id)::int AS ranks,
           (SELECT count(*) FROM club_member_rank_progress p
             WHERE p.club_id = rl.club_id AND p.ladder_id = rl.id)::int AS students,
           (SELECT count(*) FROM club_member_rank_progress p
             WHERE p.club_id = rl.club_id AND p.ladder_id = rl.id AND p.ready)::int AS ready
      FROM club_rank_ladders rl
     WHERE ${clubScope(actor, 'ranks.view', 'rl')} AND ${where}`;
}

function ladderOf(row: Record<string, unknown>): LadderSummary {
  return {
    id: String(row.id),
    name: String(row.name),
    nameBg: String(row.name_bg),
    nameEn: text(row.name_en),
    sport: text(row.sport),
    archived: row.archived === true,
    ranks: Number(row.ranks ?? 0),
    students: Number(row.students ?? 0),
    ready: Number(row.ready ?? 0),
  };
}

/** The club's ladders with their counts (ranks.view). */
export async function listLadders(actor: ClubActor, locale: string): Promise<LadderSummary[]> {
  const result = await getDb().execute(sql`
    ${ladderSummaries(actor, locale, sql`true`)}
     ORDER BY rl.archived_at IS NOT NULL, rl.name_bg
     LIMIT 100
  `);
  return result.rows.map(ladderOf);
}

export interface LadderRank extends RankRef {
  position: number;
  nameBg: string;
  nameEn: string | null;
  minAttendances: number | null;
  minMonths: number | null;
  /** Live clients whose current rank it is. */
  holders: number;
  /** Ever awarded (a revoked award too) — then it cannot be removed. */
  awarded: boolean;
}

export interface LadderDetail extends LadderSummary {
  /** Lowest first. */
  rankList: LadderRank[];
}

/** One ladder with its ranks (ranks.view). */
export async function ladderForStaff(
  actor: ClubActor,
  ladderId: string,
  locale: string,
): Promise<LadderDetail | null> {
  const db = getDb();
  const found = (await db.execute(ladderSummaries(actor, locale, sql`rl.id = ${ladderId}::uuid`)))
    .rows[0];
  if (!found) return null;
  const ranks = await db.execute(sql`
    SELECT rk.id, rk.position, ${nameIn('rk', locale)} AS name, rk.name_bg, rk.name_en,
           rk.colour, rk.accent, rk.stripes, rk.min_attendances, rk.min_months,
           (SELECT count(*) FROM club_member_rank_progress p
             WHERE p.club_id = rk.club_id AND p.rank_id = rk.id)::int AS holders,
           EXISTS (SELECT 1 FROM club_member_ranks a
                    WHERE a.club_id = rk.club_id AND a.ladder_id = rk.ladder_id
                      AND a.rank_id = rk.id) AS awarded
      FROM club_ranks rk
     WHERE rk.ladder_id = ${ladderId}::uuid AND ${clubScope(actor, 'ranks.view', 'rk')}
     ORDER BY rk.position
  `);
  return {
    ...ladderOf(found),
    rankList: ranks.rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      colour: String(row.colour) as BeltColour,
      accent: (text(row.accent) as BeltColour | null) ?? null,
      stripes: Number(row.stripes ?? 0),
      position: Number(row.position),
      nameBg: String(row.name_bg),
      nameEn: text(row.name_en),
      minAttendances: row.min_attendances === null ? null : Number(row.min_attendances),
      minMonths: row.min_months === null ? null : Number(row.min_months),
      holders: Number(row.holders ?? 0),
      awarded: row.awarded === true,
    })),
  };
}

export interface LadderWithRanks {
  id: string;
  name: string;
  ranks: RankRef[];
}

/** Every live ladder with its ranks, lowest first — the award forms' choices (ranks.view). */
export async function liveLadderRanks(
  actor: ClubActor,
  locale: string,
): Promise<LadderWithRanks[]> {
  const result = await getDb().execute(sql`
    SELECT rl.id AS ladder_id, ${nameIn('rl', locale)} AS ladder_name,
           rk.id AS rank_id, ${nameIn('rk', locale)} AS rank_name, rk.colour AS rank_colour,
           rk.accent AS rank_accent, rk.stripes AS rank_stripes
      FROM club_rank_ladders rl
      JOIN club_ranks rk ON rk.club_id = rl.club_id AND rk.ladder_id = rl.id
     WHERE rl.archived_at IS NULL AND ${clubScope(actor, 'ranks.view', 'rl')}
     ORDER BY rl.name_bg, rl.id, rk.position
     LIMIT 1000
  `);
  const ladders = new Map<string, LadderWithRanks>();
  for (const row of result.rows) {
    const id = String(row.ladder_id);
    let ladder = ladders.get(id);
    if (!ladder) {
      ladder = { id, name: String(row.ladder_name), ranks: [] };
      ladders.set(id, ladder);
    }
    const rank = rankRef(row, 'rank');
    if (rank) ladder.ranks.push(rank);
  }
  return [...ladders.values()];
}

export interface LadderFields {
  nameBg: string;
  nameEn: string | null;
  sport: string | null;
}

export type SaveLadderResult = { ok: true; ladderId: string } | { ok: false; error: 'not_allowed' };

/**
 * A new ladder, with its starting ranks (a template's, named by the caller in
 * both languages), or a ladder's edited names and sport — ranks.manage.
 */
export async function saveLadder(
  db: TransactionalDb,
  actor: ClubActor,
  input: LadderFields,
  ladderId: string | null,
  startingRanks: readonly RankInput[] = [],
): Promise<SaveLadderResult> {
  return db.transaction(async (tx): Promise<SaveLadderResult> => {
    if (ladderId === null) {
      const created = await tx.execute(sql`
        INSERT INTO club_rank_ladders (club_id, name_bg, name_en, sport, created_by)
        SELECT ${actor.clubId}::uuid, ${input.nameBg}, ${input.nameEn}, ${input.sport},
               ${actor.userId}
         WHERE ${clubActorMay(actor, 'ranks.manage', { write: true })}
        RETURNING id
      `);
      const id = text(created.rows[0]?.id);
      if (!id) return { ok: false, error: 'not_allowed' };
      for (const rank of startingRanks) {
        // A template's rank the new ladder refused could only be a bug.
        if (!(await insertRank(tx, actor, id, rank))) {
          throw new Error('club ladder: a starting rank was refused');
        }
      }
      await recordClubAudit(tx, {
        clubId: actor.clubId,
        by: { kind: 'staff', actor },
        action: 'ladder_saved',
        detail: { ladderId: id, created: true, ranks: startingRanks.length },
      });
      return { ok: true, ladderId: id };
    }
    const updated = await tx.execute(sql`
      UPDATE club_rank_ladders rl
         SET name_bg = ${input.nameBg}, name_en = ${input.nameEn}, sport = ${input.sport}
       WHERE rl.id = ${ladderId}::uuid AND ${clubWriteScope(actor, 'ranks.manage', 'rl')}
      RETURNING rl.id
    `);
    if (updated.rows.length === 0) return { ok: false, error: 'not_allowed' };
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'ladder_saved',
      detail: { ladderId },
    });
    return { ok: true, ladderId };
  });
}

/** Archive (it leaves the award forms and the exam list; its history stays) or restore. */
export async function setLadderArchived(
  db: TransactionalDb,
  actor: ClubActor,
  ladderId: string,
  archived: boolean,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const changed = await tx.execute(sql`
      UPDATE club_rank_ladders rl
         SET archived_at = ${archived ? sql`now()` : sql`NULL`}
       WHERE rl.id = ${ladderId}::uuid
         AND ${archived ? sql`rl.archived_at IS NULL` : sql`rl.archived_at IS NOT NULL`}
         AND ${clubWriteScope(actor, 'ranks.manage', 'rl')}
      RETURNING rl.id
    `);
    if (changed.rows.length === 0) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: archived ? 'ladder_archived' : 'ladder_restored',
      detail: { ladderId },
    });
    return true;
  });
}

// ─── Ranks ──────────────────────────────────────────────────────────────────

/** A placeholder the numbering stamp overwrites (0056: the place is the database's). */
const STAMPED_POSITION = sql`0`;

async function insertRank(
  tx: SqlRunner,
  actor: ClubActor,
  ladderId: string,
  input: RankInput,
): Promise<string | null> {
  const created = await tx.execute(sql`
    INSERT INTO club_ranks (club_id, ladder_id, position, name_bg, name_en, colour, accent,
                            stripes, min_attendances, min_months)
    SELECT rl.club_id, rl.id, ${STAMPED_POSITION}, ${input.nameBg}, ${input.nameEn},
           ${input.colour}, ${input.accent}, ${input.stripes}, ${input.minAttendances},
           ${input.minMonths}
      FROM club_rank_ladders rl
     WHERE rl.id = ${ladderId}::uuid AND rl.archived_at IS NULL
       AND ${clubWriteScope(actor, 'ranks.manage', 'rl')}
    RETURNING id
  `);
  return text(created.rows[0]?.id);
}

export type SaveRankResult =
  { ok: true; rankId: string } | { ok: false; error: 'not_allowed' | 'too_many_ranks' };

/** A new rank at the end of a live ladder, or a rank's edited name, belt and asks (ranks.manage). */
export async function saveRank(
  db: TransactionalDb,
  actor: ClubActor,
  ladderId: string,
  input: RankInput,
  rankId: string | null,
): Promise<SaveRankResult> {
  try {
    return await db.transaction(async (tx): Promise<SaveRankResult> => {
      let id: string | null;
      if (rankId === null) {
        id = await insertRank(tx, actor, ladderId, input);
      } else {
        const updated = await tx.execute(sql`
          UPDATE club_ranks rk
             SET name_bg = ${input.nameBg}, name_en = ${input.nameEn}, colour = ${input.colour},
                 accent = ${input.accent}, stripes = ${input.stripes},
                 min_attendances = ${input.minAttendances}, min_months = ${input.minMonths}
           WHERE rk.id = ${rankId}::uuid AND rk.ladder_id = ${ladderId}::uuid
             AND ${clubWriteScope(actor, 'ranks.manage', 'rk')}
          RETURNING rk.id
        `);
        id = text(updated.rows[0]?.id);
      }
      if (!id) return { ok: false, error: 'not_allowed' };
      await recordClubAudit(tx, {
        clubId: actor.clubId,
        by: { kind: 'staff', actor },
        action: 'rank_saved',
        detail: { ladderId, rankId: id, created: rankId === null },
      });
      return { ok: true, rankId: id };
    });
  } catch (error: unknown) {
    const constraint = violatedConstraint(error);
    if (constraint === 'club_ranks_too_many') return { ok: false, error: 'too_many_ranks' };
    if (constraint === 'club_ranks_live_ladder') return { ok: false, error: 'not_allowed' };
    throw error;
  }
}

/**
 * Swap a rank with its neighbour (`up` — towards the first rank). Under the
 * ladder's row lock, the numbering stamp's, so a rank added meanwhile never
 * takes a place being swapped; the place key is checked at the statement's
 * end (DEFERRABLE INITIALLY IMMEDIATE), so one UPDATE swaps both.
 */
export async function moveRank(
  db: TransactionalDb,
  actor: ClubActor,
  rankId: string,
  direction: 'up' | 'down',
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const locked = await tx.execute(sql`
      SELECT rl.id FROM club_rank_ladders rl
       WHERE rl.id = (SELECT r.ladder_id FROM club_ranks r WHERE r.id = ${rankId}::uuid)
         AND ${clubWriteScope(actor, 'ranks.manage', 'rl')}
       FOR NO KEY UPDATE
    `);
    if (locked.rows.length === 0) return false;
    const neighbour = (
      await tx.execute(sql`
        SELECT rk.position AS here, nb.id AS other_id, nb.position AS there
          FROM club_ranks rk
          JOIN LATERAL (SELECT n.id, n.position FROM club_ranks n
                         WHERE n.club_id = rk.club_id AND n.ladder_id = rk.ladder_id
                           AND ${direction === 'up' ? sql`n.position < rk.position` : sql`n.position > rk.position`}
                         ORDER BY ${direction === 'up' ? sql`n.position DESC` : sql`n.position`}
                         LIMIT 1) nb ON true
         WHERE rk.id = ${rankId}::uuid AND ${clubScope(actor, 'ranks.manage', 'rk')}
      `)
    ).rows[0];
    if (!neighbour) return false;
    const otherId = String(neighbour.other_id);
    const swapped = await tx.execute(sql`
      UPDATE club_ranks rk
         SET position = CASE WHEN rk.id = ${rankId}::uuid THEN ${Number(neighbour.there)}::int
                             ELSE ${Number(neighbour.here)}::int END
       WHERE rk.id IN (${rankId}::uuid, ${otherId}::uuid)
         AND ${clubWriteScope(actor, 'ranks.manage', 'rk')}
      RETURNING rk.id
    `);
    if (swapped.rows.length !== 2) throw new Error('club rank: a swap moved one rank');
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'rank_moved',
      detail: { rankId, direction },
    });
    return true;
  });
}

export type RemoveRankResult = { ok: true } | { ok: false; error: 'not_allowed' | 'rank_in_use' };

/** Remove a rank nobody was ever awarded (ranks.manage); one in the history stays. */
export async function removeRank(
  db: TransactionalDb,
  actor: ClubActor,
  rankId: string,
): Promise<RemoveRankResult> {
  try {
    return await db.transaction(async (tx): Promise<RemoveRankResult> => {
      // The ladder's row lock — moveRank's and the numbering stamp's — so a
      // swap never loses the neighbour it read.
      const locked = await tx.execute(sql`
        SELECT rl.id FROM club_rank_ladders rl
         WHERE rl.id = (SELECT r.ladder_id FROM club_ranks r WHERE r.id = ${rankId}::uuid)
           AND ${clubWriteScope(actor, 'ranks.manage', 'rl')}
         FOR NO KEY UPDATE
      `);
      if (locked.rows.length === 0) return { ok: false, error: 'not_allowed' };
      const removed = await tx.execute(sql`
        DELETE FROM club_ranks rk
         WHERE rk.id = ${rankId}::uuid AND ${clubWriteScope(actor, 'ranks.manage', 'rk')}
        RETURNING rk.ladder_id
      `);
      const ladderId = text(removed.rows[0]?.ladder_id);
      if (!ladderId) return { ok: false, error: 'not_allowed' };
      await recordClubAudit(tx, {
        clubId: actor.clubId,
        by: { kind: 'staff', actor },
        action: 'rank_removed',
        detail: { ladderId, rankId },
      });
      return { ok: true };
    });
  } catch (error: unknown) {
    if (violatedConstraint(error) === 'club_member_ranks_rank_fk') {
      return { ok: false, error: 'rank_in_use' };
    }
    throw error;
  }
}

// ─── Who holds what ─────────────────────────────────────────────────────────

export interface RankProgress {
  memberId: string;
  memberName: string;
  ladderId: string;
  ladderName: string;
  /** The award that is their current rank. */
  awardId: string;
  current: RankRef;
  awardedOn: IsoDate;
  /** Null: the ladder's top rank. */
  next: RankRef | null;
  minAttendances: number | null;
  minMonths: number | null;
  /** Check-ins since awardedOn (in the ladder's sport, when it has one). */
  attended: number;
  /** The day the months ask is met; null when the next rank asks no months. */
  monthsMetOn: IsoDate | null;
  ready: boolean;
}

/**
 * THE PROJECTION a trainer reads (club-projections.test.ts): a display name,
 * the ladder, the ranks and the attendance figures — nothing else of the
 * client. `scope` binds the `rp` (progress) or `m` (client) alias.
 */
function progressRows(locale: string, scope: SQL, where: SQL, limit: number): SQL {
  return sql`
    SELECT rp.member_id, m.display_name, rp.ladder_id, ${nameIn('rl', locale)} AS ladder_name,
           rp.award_id, rp.awarded_on::text AS awarded_on, rp.attended,
           rp.months_met_on::text AS months_met_on, rp.ready, rp.min_attendances, rp.min_months,
           cr.id AS cur_id, ${nameIn('cr', locale)} AS cur_name, cr.colour AS cur_colour,
           cr.accent AS cur_accent, cr.stripes AS cur_stripes,
           nr.id AS next_id, ${nameIn('nr', locale)} AS next_name, nr.colour AS next_colour,
           nr.accent AS next_accent, nr.stripes AS next_stripes
      FROM club_member_rank_progress rp
      JOIN club_members m ON m.club_id = rp.club_id AND m.id = rp.member_id
      JOIN club_rank_ladders rl ON rl.club_id = rp.club_id AND rl.id = rp.ladder_id
      JOIN club_ranks cr ON cr.club_id = rp.club_id AND cr.id = rp.rank_id
      LEFT JOIN club_ranks nr ON nr.club_id = rp.club_id AND nr.id = rp.next_rank_id
     WHERE ${scope} AND ${where}
     ORDER BY rp.ready DESC, rl.name_bg, rp.ladder_id, m.display_name, rp.member_id
     LIMIT ${limit}`;
}

function progressOf(row: Record<string, unknown>): RankProgress {
  return {
    memberId: String(row.member_id),
    memberName: String(row.display_name),
    ladderId: String(row.ladder_id),
    ladderName: String(row.ladder_name),
    awardId: String(row.award_id),
    current: rankRef(row, 'cur') as RankRef,
    awardedOn: String(row.awarded_on) as IsoDate,
    next: rankRef(row, 'next'),
    minAttendances: row.min_attendances === null ? null : Number(row.min_attendances),
    minMonths: row.min_months === null ? null : Number(row.min_months),
    attended: Number(row.attended ?? 0),
    monthsMetOn: (text(row.months_met_on) as IsoDate | null) ?? null,
    ready: row.ready === true,
  };
}

/** The clients on one ladder, ready ones first (ranks.view). */
export async function ladderStudents(
  actor: ClubActor,
  ladderId: string,
  locale: string,
): Promise<RankProgress[]> {
  const result = await getDb().execute(
    progressRows(
      locale,
      clubScope(actor, 'ranks.view', 'rp'),
      sql`rp.ladder_id = ${ladderId}::uuid`,
      500,
    ),
  );
  return result.rows.map(progressOf);
}

/** «Готови за изпит»: every client ready for their next rank, on every live ladder (ranks.view). */
export async function examReady(actor: ClubActor, locale: string): Promise<RankProgress[]> {
  const result = await getDb().execute(
    progressRows(locale, clubScope(actor, 'ranks.view', 'rp'), sql`rp.ready`, 500),
  );
  return result.rows.map(progressOf);
}

export interface LadderCandidate {
  memberId: string;
  memberName: string;
  /** Check-ins in the last 90 days (in the ladder's sport, when it has one). */
  visits: number;
  lastSeen: IsoDate;
}

/**
 * Clients who trained in the ladder's sport in the last 90 days and hold no
 * rank on it — who a coach starts on the first rank (ranks.view). The same
 * projection: a display name and counts.
 */
export async function ladderCandidates(
  actor: ClubActor,
  ladderId: string,
): Promise<LadderCandidate[]> {
  const result = await getDb().execute(sql`
    SELECT m.id, m.display_name, count(*)::int AS visits, max(ci.sofia_day)::text AS last_seen
      FROM club_rank_ladders rl
      JOIN club_checkins ci ON ci.club_id = rl.club_id
      JOIN club_members m ON m.club_id = ci.club_id AND m.id = ci.member_id
                         AND m.archived_at IS NULL
     WHERE rl.id = ${ladderId}::uuid AND rl.archived_at IS NULL
       AND ${clubScope(actor, 'ranks.view', 'rl')}
       AND ci.sofia_day >= (now() AT TIME ZONE 'Europe/Sofia')::date - 90
       AND (rl.sport IS NULL OR EXISTS (
             SELECT 1 FROM club_class_occurrences o
               JOIN club_classes k ON k.club_id = o.club_id AND k.id = o.class_id
              WHERE o.club_id = ci.club_id AND o.id = ci.occurrence_id AND k.sport = rl.sport))
       AND NOT EXISTS (SELECT 1 FROM club_member_ranks a
                        WHERE a.club_id = rl.club_id AND a.ladder_id = rl.id
                          AND a.member_id = m.id AND a.revoked_at IS NULL)
     GROUP BY m.id, m.display_name
     ORDER BY max(ci.sofia_day) DESC, m.display_name, m.id
     LIMIT 50
  `);
  return result.rows.map((row) => ({
    memberId: String(row.id),
    memberName: String(row.display_name),
    visits: Number(row.visits ?? 0),
    lastSeen: String(row.last_seen) as IsoDate,
  }));
}

export interface RankAward {
  id: string;
  memberId: string;
  memberName: string;
  ladderId: string;
  ladderName: string;
  ladderArchived: boolean;
  rank: RankRef;
  awardedOn: IsoDate;
  reason: RankAwardReason;
  /** The recording member of staff, while they are on the staff. */
  recordedByName: string | null;
  revokedAt: string | null;
}

function awardOf(row: Record<string, unknown>): RankAward {
  return {
    id: String(row.id),
    memberId: String(row.member_id),
    memberName: String(row.display_name),
    ladderId: String(row.ladder_id),
    ladderName: String(row.ladder_name),
    ladderArchived: row.ladder_archived === true,
    rank: rankRef(row, 'rank') as RankRef,
    awardedOn: String(row.awarded_on) as IsoDate,
    reason: String(row.reason) as RankAwardReason,
    recordedByName: text(row.recorded_by_name),
    revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : iso(row.revoked_at),
  };
}

function awardRows(locale: string, scope: SQL, where: SQL): SQL {
  return sql`
    SELECT ra.id, ra.member_id, m.display_name, ra.ladder_id,
           ${nameIn('rl', locale)} AS ladder_name,
           rl.archived_at IS NOT NULL AS ladder_archived,
           rk.id AS rank_id, ${nameIn('rk', locale)} AS rank_name, rk.colour AS rank_colour,
           rk.accent AS rank_accent, rk.stripes AS rank_stripes,
           ra.awarded_on::text AS awarded_on, ra.reason, st.display_name AS recorded_by_name,
           ra.revoked_at
      FROM club_member_ranks ra
      JOIN club_members m ON m.club_id = ra.club_id AND m.id = ra.member_id
      JOIN club_rank_ladders rl ON rl.club_id = ra.club_id AND rl.id = ra.ladder_id
      JOIN club_ranks rk ON rk.club_id = ra.club_id AND rk.id = ra.rank_id
      LEFT JOIN club_staff st ON st.club_id = ra.club_id AND st.user_id = ra.awarded_by
     WHERE ${scope} AND ${where}
     ORDER BY ra.awarded_on DESC, ra.created_at DESC
     LIMIT 200`;
}

export interface MemberRanks {
  progress: RankProgress[];
  /** Newest first, revoked ones included. */
  history: RankAward[];
}

/** One client's ranks — the member card (ranks.view). */
export async function memberRanks(
  actor: ClubActor,
  memberId: string,
  locale: string,
): Promise<MemberRanks> {
  const db = getDb();
  const [progress, history] = await Promise.all([
    db.execute(
      progressRows(
        locale,
        clubScope(actor, 'ranks.view', 'rp'),
        sql`rp.member_id = ${memberId}::uuid`,
        50,
      ),
    ),
    db.execute(
      awardRows(
        locale,
        clubScope(actor, 'ranks.view', 'ra'),
        sql`ra.member_id = ${memberId}::uuid`,
      ),
    ),
  ]);
  return { progress: progress.rows.map(progressOf), history: history.rows.map(awardOf) };
}

// ─── Awards ─────────────────────────────────────────────────────────────────

export interface AwardRefusal {
  ok: false;
  error: 'not_allowed' | 'already_awarded' | 'award_date_future';
}
export type AwardResult = { ok: true } | AwardRefusal;

function awardRefusal(error: unknown): AwardRefusal | null {
  const constraint = violatedConstraint(error);
  if (constraint === 'club_member_ranks_once') return { ok: false, error: 'already_awarded' };
  if (constraint === 'club_member_ranks_not_future') {
    return { ok: false, error: 'award_date_future' };
  }
  if (constraint === 'club_member_ranks_live') return { ok: false, error: 'not_allowed' };
  return null;
}

/**
 * Any rank of a live ladder to one client (ranks.award) — the coach's choice,
 * whatever the exam list says. The club's own staff only.
 */
export async function awardRank(
  db: TransactionalDb,
  actor: ClubActor,
  memberId: string,
  rankId: string,
  input: AwardInput,
): Promise<AwardResult> {
  try {
    return await db.transaction(async (tx): Promise<AwardResult> => {
      const created = await tx.execute(sql`
        INSERT INTO club_member_ranks (club_id, ladder_id, rank_id, member_id, awarded_on,
                                       reason, awarded_by)
        SELECT rk.club_id, rk.ladder_id, rk.id, m.id, ${input.awardedOn}::date, ${input.reason},
               ${actor.userId}
          FROM club_ranks rk
          JOIN club_rank_ladders rl ON rl.club_id = rk.club_id AND rl.id = rk.ladder_id
                                   AND rl.archived_at IS NULL
          JOIN club_members m ON m.club_id = rk.club_id AND m.id = ${memberId}::uuid
                             AND m.archived_at IS NULL
         WHERE rk.id = ${rankId}::uuid AND ${clubStaffWriteScope(actor, 'ranks.award', 'rk')}
        RETURNING id, ladder_id
      `);
      const row = created.rows[0];
      if (!row) return { ok: false, error: 'not_allowed' };
      await recordClubAudit(tx, {
        clubId: actor.clubId,
        by: { kind: 'staff', actor },
        action: 'rank_awarded',
        subjectMemberId: memberId,
        detail: {
          awardId: String(row.id),
          ladderId: String(row.ladder_id),
          rankId,
          reason: input.reason,
        },
      });
      return { ok: true };
    });
  } catch (error: unknown) {
    const refused = awardRefusal(error);
    if (refused) return refused;
    throw error;
  }
}

export type NextAwardsResult = { ok: true; awarded: number; skipped: number } | AwardRefusal;

/**
 * An exam day: each picked client gets the rank the page showed them — their
 * NEXT rank (club_member_rank_progress), or the ladder's FIRST for a client
 * who holds none on it. A client whose rank changed meanwhile, or who was
 * already given it that day, is skipped, never given the rank after; so is
 * a day before their current rank's (the award would never become current).
 * Two exam days on one ladder run one after the other (the ladder's row
 * lock), so the second reads what the first awarded.
 */
export async function awardNextRanks(
  db: TransactionalDb,
  actor: ClubActor,
  ladderId: string,
  picks: readonly { memberId: string; rankId: string }[],
  input: AwardInput,
): Promise<NextAwardsResult> {
  if (picks.length === 0) return { ok: true, awarded: 0, skipped: 0 };
  try {
    return await db.transaction(async (tx): Promise<NextAwardsResult> => {
      const locked = await tx.execute(sql`
        SELECT rl.id FROM club_rank_ladders rl
         WHERE rl.id = ${ladderId}::uuid AND rl.archived_at IS NULL
           AND ${clubStaffWriteScope(actor, 'ranks.award', 'rl')}
         FOR NO KEY UPDATE
      `);
      if (locked.rows.length === 0) return { ok: false, error: 'not_allowed' };
      const created = await tx.execute(sql`
        INSERT INTO club_member_ranks (club_id, ladder_id, rank_id, member_id, awarded_on,
                                       reason, awarded_by)
        SELECT rk.club_id, rk.ladder_id, rk.id, m.id, ${input.awardedOn}::date, ${input.reason},
               ${actor.userId}
          FROM unnest(${sql.param(picks.map((pick) => pick.memberId))}::uuid[],
                      ${sql.param(picks.map((pick) => pick.rankId))}::uuid[]) AS p(member_id, rank_id)
          JOIN club_ranks rk ON rk.id = p.rank_id AND rk.ladder_id = ${ladderId}::uuid
          JOIN club_rank_ladders rl ON rl.club_id = rk.club_id AND rl.id = rk.ladder_id
                                   AND rl.archived_at IS NULL
          JOIN club_members m ON m.club_id = rk.club_id AND m.id = p.member_id
                             AND m.archived_at IS NULL
         WHERE ${clubStaffWriteScope(actor, 'ranks.award', 'rk')}
           AND (EXISTS (SELECT 1 FROM club_member_rank_progress pr
                         WHERE pr.club_id = rk.club_id AND pr.ladder_id = rk.ladder_id
                           AND pr.member_id = m.id AND pr.next_rank_id = rk.id
                           AND pr.awarded_on <= ${input.awardedOn}::date)
                OR (NOT EXISTS (SELECT 1 FROM club_member_ranks a
                                 WHERE a.club_id = rk.club_id AND a.ladder_id = rk.ladder_id
                                   AND a.member_id = m.id AND a.revoked_at IS NULL)
                    AND rk.id = (SELECT f.id FROM club_ranks f
                                  WHERE f.club_id = rk.club_id AND f.ladder_id = rk.ladder_id
                                  ORDER BY f.position LIMIT 1)))
        ON CONFLICT (club_id, member_id, rank_id, awarded_on) WHERE revoked_at IS NULL DO NOTHING
        RETURNING id, member_id, rank_id
      `);
      for (const row of created.rows) {
        await recordClubAudit(tx, {
          clubId: actor.clubId,
          by: { kind: 'staff', actor },
          action: 'rank_awarded',
          subjectMemberId: String(row.member_id),
          detail: {
            awardId: String(row.id),
            ladderId,
            rankId: String(row.rank_id),
            reason: input.reason,
          },
        });
      }
      return {
        ok: true,
        awarded: created.rows.length,
        skipped: picks.length - created.rows.length,
      };
    });
  } catch (error: unknown) {
    const refused = awardRefusal(error);
    if (refused) return refused;
    throw error;
  }
}

/** Revoke a mistaken award (ranks.award): it stays in the history and stops counting. */
export async function revokeAward(
  db: TransactionalDb,
  actor: ClubActor,
  awardId: string,
): Promise<string | null> {
  return db.transaction(async (tx) => {
    const revoked = await tx.execute(sql`
      UPDATE club_member_ranks ra
         SET revoked_at = now(), revoked_by = ${actor.userId}
       WHERE ra.id = ${awardId}::uuid AND ra.revoked_at IS NULL
         AND ${clubStaffWriteScope(actor, 'ranks.award', 'ra')}
      RETURNING ra.member_id, ra.ladder_id, ra.rank_id
    `);
    const row = revoked.rows[0];
    if (!row) return null;
    const memberId = String(row.member_id);
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'rank_revoked',
      subjectMemberId: memberId,
      detail: { awardId, ladderId: String(row.ladder_id), rankId: String(row.rank_id) },
    });
    return memberId;
  });
}

// ─── The portal ─────────────────────────────────────────────────────────────

export interface PortalRanks {
  progress: RankProgress[];
  /** Live awards only, newest first. */
  history: RankAward[];
}

/** The account's own records' ranks and its children's — the portal (memberSelfScope). */
export async function portalRanks(
  userId: string,
  clubId: string,
  locale: string,
): Promise<PortalRanks> {
  const db = getDb();
  const [progress, history] = await Promise.all([
    db.execute(progressRows(locale, memberSelfScope(userId, clubId, 'm'), sql`true`, 100)),
    db.execute(
      awardRows(
        locale,
        memberSelfScope(userId, clubId, 'm'),
        sql`ra.revoked_at IS NULL AND m.archived_at IS NULL`,
      ),
    ),
  ]);
  return { progress: progress.rows.map(progressOf), history: history.rows.map(awardOf) };
}

/** How many live awards the account's records hold — the portal home's link. */
export async function portalRankCount(userId: string, clubId: string): Promise<number> {
  const row = (
    await getDb().execute(sql`
      SELECT count(*)::int AS n
        FROM club_member_ranks ra
        JOIN club_members m ON m.club_id = ra.club_id AND m.id = ra.member_id
       WHERE ${memberSelfScope(userId, clubId, 'm')} AND m.archived_at IS NULL
         AND ra.revoked_at IS NULL
    `)
  ).rows[0];
  return Number(row?.n ?? 0);
}
