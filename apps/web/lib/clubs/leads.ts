import { getDb, sql, type SQL } from '@sportkarta/db';
import {
  LEAD_BOARD_CLOSED_DAYS,
  LEAD_FIRST_CALL_HOURS,
  rolesWith,
  type IsoDate,
  type LeadLostReason,
  type LeadSource,
  type LeadStage,
} from '@sportkarta/lib/clubs';

import { clubWritableGuard } from './access';
import { recordClubAudit, type ClubAuditActor } from './audit';
import { clubScope, clubWriteScope, type ClubActor } from './scope';

/**
 * The prospects pipeline (0052, wave F2 — 1club's leads). A record enters it
 * when the person asked (an inquiry from the club's page), booked a trial,
 * or the desk added them; the STAGE is derived (club_lead_stages): a sale, a
 * visit or a trial booking moves the card by itself. The desk records only
 * what a person decides: that somebody called, the next step and its owner,
 * and why a prospect was lost.
 *
 * Reads are members.view, writes members.manage — the front of house.
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

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

/** Who may own a prospect: the roles that work the members list (members.manage). */
const LEAD_OWNER_ROLES = sql`${sql.param([...rolesWith('members.manage')])}::text[]`;

/**
 * A card is due when it has sat at «new» for LEAD_FIRST_CALL_HOURS (a trial
 * booking or a visit moves it on by itself, and is not a call to make), or
 * its agreed next step is today or late, at any open stage. The worker's
 * daily list (leadsDue) counts the same two.
 */
function uncalledSql(): SQL {
  return sql`(ls.stage = 'new'
    AND m.lead_opened_at < now() - make_interval(hours => ${LEAD_FIRST_CALL_HOURS}::int))`;
}

/** Every pipeline field back to empty — the CHECK wants all of them gone together. */
const CLEARED = sql`lead_contacted_at = NULL, lead_next_action_on = NULL, lead_assigned_to = NULL,
  lead_lost_at = NULL, lead_lost_reason = NULL`;

/**
 * Open (or re-open) the pipeline for a record the person themselves brought
 * in — an inquiry or a trial booking — when they are a prospect: no
 * abonnement ever, only a trial, or none still running, and not already an
 * open lead. A
 * client who still trains is not a prospect; one who won earlier and lapsed
 * is one again. Called inside the inquiry's or the booking's own
 * transaction, after it proved the person and the club.
 */
export async function openLeadIfProspect(
  tx: SqlRunner,
  clubId: string,
  memberId: string,
  source: Extract<LeadSource, 'inquiry' | 'trial'>,
  by: ClubAuditActor,
): Promise<boolean> {
  const opened = await tx.execute(sql`
    UPDATE club_members m
       SET lead_opened_at = now(), lead_source = ${source}, ${CLEARED}, updated_at = now()
     WHERE m.club_id = ${clubId}::uuid AND m.id = ${memberId}::uuid AND m.archived_at IS NULL
       AND ${clubWritableGuard(clubId)}
       AND EXISTS (SELECT 1 FROM club_member_status st
                    WHERE st.member_id = m.id AND st.status IN ('lead', 'trial', 'lapsed'))
       AND (m.lead_opened_at IS NULL
            OR EXISTS (SELECT 1 FROM club_lead_stages ls
                        WHERE ls.member_id = m.id AND ls.stage IN ('won', 'lost')))
    RETURNING id
  `);
  if (opened.rows.length === 0) return false;
  await recordClubAudit(tx, {
    clubId,
    by,
    action: 'lead_opened',
    subjectMemberId: memberId,
    detail: { source },
  });
  return true;
}

export interface LeadCard {
  memberId: string;
  name: string;
  phone: string | null;
  email: string | null;
  linked: boolean;
  source: LeadSource | null;
  stage: LeadStage;
  openedAt: string;
  contactedAt: string | null;
  nextActionOn: IsoDate | null;
  assignedTo: string | null;
  assignedName: string | null;
  lostReason: LeadLostReason | null;
  /** When it reached won or lost — the board keeps those for a while. */
  closedAt: string | null;
  /** At «new» for a day, or the next step is today or late (uncalledSql). */
  due: boolean;
  /** The latest conversation with them, if any — the inquiry, usually. */
  threadId: string | null;
}

const CARD_COLUMNS = sql`
  m.id, m.display_name, m.phone, m.email, m.lead_source, ls.stage, m.lead_opened_at,
  m.lead_contacted_at, to_char(m.lead_next_action_on, 'YYYY-MM-DD') AS next_action_on,
  m.lead_assigned_to, a.display_name AS assigned_name, m.lead_lost_reason,
  CASE ls.stage WHEN 'won' THEN ls.won_at WHEN 'lost' THEN m.lead_lost_at END AS closed_at,
  ${uncalledSql()} AS uncalled,
  (EXISTS (SELECT 1 FROM club_member_links ml WHERE ml.member_id = m.id AND ml.status = 'active'))
    AS linked,
  (SELECT th.id FROM club_threads th WHERE th.club_id = m.club_id AND th.member_id = m.id
    ORDER BY th.created_at DESC LIMIT 1) AS thread_id`;

function card(row: Record<string, unknown>, today: IsoDate): LeadCard {
  const stage = String(row.stage) as LeadStage;
  const contactedAt = iso(row.lead_contacted_at);
  const openedAt = iso(row.lead_opened_at) ?? new Date(0).toISOString();
  const nextActionOn = text(row.next_action_on) as IsoDate | null;
  const open = stage !== 'won' && stage !== 'lost';
  const uncalled = row.uncalled === true;
  return {
    memberId: String(row.id),
    name: String(row.display_name),
    phone: text(row.phone),
    email: text(row.email),
    linked: row.linked === true,
    source: text(row.lead_source) as LeadSource | null,
    stage,
    openedAt,
    contactedAt,
    nextActionOn,
    assignedTo: text(row.lead_assigned_to),
    assignedName: text(row.assigned_name),
    lostReason: text(row.lead_lost_reason) as LeadLostReason | null,
    closedAt: iso(row.closed_at),
    due: open && (uncalled || (nextActionOn !== null && nextActionOn <= today)),
    threadId: text(row.thread_id),
  };
}

/**
 * The board: every open prospect, and those won or lost in the last
 * LEAD_BOARD_CLOSED_DAYS. Due cards first, then the oldest.
 */
export async function leadBoard(actor: ClubActor, today: IsoDate): Promise<LeadCard[]> {
  const result = await getDb().execute(sql`
    SELECT ${CARD_COLUMNS}
      FROM club_members m
      JOIN club_lead_stages ls ON ls.member_id = m.id
      LEFT JOIN club_staff a ON a.club_id = m.club_id AND a.user_id = m.lead_assigned_to
     WHERE ${clubScope(actor, 'members.view', 'm')} AND m.archived_at IS NULL
       AND (ls.stage NOT IN ('won', 'lost')
            OR coalesce(ls.won_at, m.lead_lost_at)
               > now() - make_interval(days => ${LEAD_BOARD_CLOSED_DAYS}::int))
     ORDER BY m.lead_next_action_on NULLS LAST, m.lead_opened_at
     LIMIT 500
  `);
  const cards = result.rows.map((row) => card(row, today));
  return [...cards.filter((c) => c.due), ...cards.filter((c) => !c.due)];
}

/** One record's place in the pipeline, for its member page; null when not in it. */
export async function memberLead(
  actor: ClubActor,
  memberId: string,
  today: IsoDate,
): Promise<LeadCard | null> {
  const result = await getDb().execute(sql`
    SELECT ${CARD_COLUMNS}
      FROM club_members m
      JOIN club_lead_stages ls ON ls.member_id = m.id
      LEFT JOIN club_staff a ON a.club_id = m.club_id AND a.user_id = m.lead_assigned_to
     WHERE m.id = ${memberId}::uuid AND ${clubScope(actor, 'members.view', 'm')}
  `);
  const row = result.rows[0];
  return row ? card(row, today) : null;
}

/**
 * For the dashboard: open prospects at «new» for a day, next steps due, and
 * the cards due for either — each card once.
 */
export async function leadsSummary(
  actor: ClubActor,
  today: IsoDate,
): Promise<{ uncalled: number; planned: number; due: number; open: number }> {
  const planned = sql`m.lead_next_action_on <= ${today}::date`;
  const result = await getDb().execute(sql`
    SELECT count(*) FILTER (WHERE ${uncalledSql()})::int AS uncalled,
           count(*) FILTER (WHERE ${planned})::int AS planned,
           count(*) FILTER (WHERE ${uncalledSql()} OR ${planned})::int AS due,
           count(*)::int AS open
      FROM club_members m
      JOIN club_lead_stages ls ON ls.member_id = m.id
     WHERE ${clubScope(actor, 'members.view', 'm')} AND m.archived_at IS NULL
       AND ls.stage NOT IN ('won', 'lost')
  `);
  const row = result.rows[0] ?? {};
  return {
    uncalled: Number(row.uncalled ?? 0),
    planned: Number(row.planned ?? 0),
    due: Number(row.due ?? 0),
    open: Number(row.open ?? 0),
  };
}

/** The staff who may own a prospect: everybody who works the members list. */
export async function leadOwners(actor: ClubActor): Promise<{ userId: string; name: string }[]> {
  const result = await getDb().execute(sql`
    SELECT s.user_id, coalesce(s.display_name, u.display_name, '') AS name
      FROM club_staff s JOIN users u ON u.id = s.user_id
     WHERE ${clubScope(actor, 'members.view', 's')} AND s.role = ANY(${LEAD_OWNER_ROLES})
     ORDER BY lower(coalesce(s.display_name, u.display_name, ''))
  `);
  return result.rows.map((row) => ({ userId: String(row.user_id), name: String(row.name) }));
}

type LeadChange =
  | { kind: 'open'; source: LeadSource }
  | { kind: 'contacted' }
  | { kind: 'plan'; nextActionOn: IsoDate | null; assignedTo: string | null }
  | { kind: 'lost'; reason: LeadLostReason }
  | { kind: 'reopen' }
  | { kind: 'remove' };

/**
 * One change to a record's place in the pipeline, by the desk. Returns false
 * when the record is not this club's, not in the state the change needs, or
 * the club may not write — the scope decides, the page only asks.
 */
export async function changeLead(
  db: TransactionalDb,
  actor: ClubActor,
  memberId: string,
  change: LeadChange,
): Promise<boolean> {
  const scope = clubWriteScope(actor, 'members.manage', 'm');
  const target = sql`m.id = ${memberId}::uuid AND ${scope} AND m.archived_at IS NULL`;
  const inPipeline = sql`m.lead_opened_at IS NOT NULL`;
  let statement: SQL;
  switch (change.kind) {
    case 'open':
      // Any live record may be added — an old client asked about a camp is a
      // prospect for the camp. One already open stays as it is.
      statement = sql`
        UPDATE club_members m
           SET lead_opened_at = now(), lead_source = ${change.source}, ${CLEARED}, updated_at = now()
         WHERE ${target}
           AND (m.lead_opened_at IS NULL
                OR EXISTS (SELECT 1 FROM club_lead_stages ls
                            WHERE ls.member_id = m.id AND ls.stage IN ('won', 'lost')))
        RETURNING id`;
      break;
    case 'contacted':
      statement = sql`
        UPDATE club_members m
           SET lead_contacted_at = coalesce(m.lead_contacted_at, now()), updated_at = now()
         WHERE ${target} AND ${inPipeline} AND m.lead_lost_at IS NULL
        RETURNING id`;
      break;
    case 'plan':
      // The owner must work at this club and hold the members list.
      statement = sql`
        UPDATE club_members m
           SET lead_next_action_on = ${change.nextActionOn}::date,
               lead_assigned_to = ${change.assignedTo}, updated_at = now()
         WHERE ${target} AND ${inPipeline} AND m.lead_lost_at IS NULL
           AND (${change.assignedTo}::text IS NULL OR EXISTS (
                 SELECT 1 FROM club_staff s
                  WHERE s.club_id = m.club_id AND s.user_id = ${change.assignedTo}
                    AND s.role = ANY(${LEAD_OWNER_ROLES})))
        RETURNING id`;
      break;
    case 'lost':
      statement = sql`
        UPDATE club_members m
           SET lead_lost_at = now(), lead_lost_reason = ${change.reason},
               lead_next_action_on = NULL, updated_at = now()
         WHERE ${target} AND ${inPipeline} AND m.lead_lost_at IS NULL
        RETURNING id`;
      break;
    case 'reopen':
      statement = sql`
        UPDATE club_members m
           SET lead_lost_at = NULL, lead_lost_reason = NULL, updated_at = now()
         WHERE ${target} AND ${inPipeline} AND m.lead_lost_at IS NOT NULL
        RETURNING id`;
      break;
    case 'remove':
      // Off the board altogether (added by mistake): every pipeline fact goes.
      statement = sql`
        UPDATE club_members m
           SET lead_opened_at = NULL, lead_source = NULL, ${CLEARED}, updated_at = now()
         WHERE ${target} AND ${inPipeline}
        RETURNING id`;
      break;
  }
  return db.transaction(async (tx) => {
    const changed = await tx.execute(statement);
    if (changed.rows.length === 0) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action:
        change.kind === 'open'
          ? 'lead_opened'
          : change.kind === 'lost'
            ? 'lead_lost'
            : change.kind === 'reopen'
              ? 'lead_reopened'
              : 'lead_updated',
      subjectMemberId: memberId,
      detail:
        change.kind === 'open'
          ? { source: change.source }
          : change.kind === 'lost'
            ? { reason: change.reason }
            : change.kind === 'plan'
              ? { nextActionOn: change.nextActionOn, assigned: change.assignedTo !== null }
              : { change: change.kind },
    });
    return true;
  });
}

/**
 * Answering a prospect's inquiry IS calling them: the club's first reply
 * marks the open lead contacted. Inside the reply's own scoped transaction.
 */
export async function noteLeadContacted(
  tx: SqlRunner,
  actor: ClubActor,
  memberId: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE club_members m
       SET lead_contacted_at = now(), updated_at = now()
     WHERE m.id = ${memberId}::uuid AND ${clubWriteScope(actor, 'inbox.reply', 'm')}
       AND m.lead_opened_at IS NOT NULL AND m.lead_contacted_at IS NULL AND m.lead_lost_at IS NULL
  `);
}
