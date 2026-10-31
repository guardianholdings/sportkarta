import { getDb, sql, type SQL } from '@sportkarta/db';
import {
  CLUB_IMPORT_ASCII_ALIASES,
  CLUB_IMPORT_FIELDS,
  MAX_CLUB_IMPORT_ROWS,
  classifyImportRows,
  daysBetween,
  membershipEndsOn,
  normalizeImportRow,
  sofiaToday,
  type ClubImportField,
  type ClubImportRow,
  type ExistingMember,
  type ImportClass,
  type IsoDate,
  type NormalizedImportRow,
} from '@sportkarta/lib/clubs';
import { detectDelimiter, guessColumn, parseCsv } from '@sportkarta/lib/csv';

import columns from '../csv-columns.json';
import { recordClubAudit } from './audit';
import { clubActorMay, clubScope, type ClubActor } from './scope';

/**
 * The club member import — the web adapter around the pure core in
 * lib/src/clubs/import.ts (what a row means, and new/match/conflict), in the
 * shape of the municipal inbox: parse → map → preview → commit, every step
 * re-derived from the CSV the form carries, the commit re-classifying from
 * scratch (a posted preview is a rendering, never an authorisation).
 *
 * WHAT A COMMIT WRITES, in ONE transaction, all scoped to the importing
 * staff member's `data.import` on a writable club:
 *   - new records (source 'import'); for a matched record only what is
 *     missing — an e-mail or phone it has none of, and the union of tags;
 *   - a membership per row that names a known plan: dates from the file (or
 *     the plan's validity from the start), a visit card's used visits as
 *     `visits_used_offset` (0041's seam for exactly this), the plan's terms
 *     snapshotted as a desk sale does — but never renewing and sold by nobody
 *     (an import is not a sale, so it earns no one a commission). A plan whose
 *     audience the row contradicts, or a window the table would refuse, makes
 *     the row an error in the preview; a membership of the same plan already
 *     overlapping the window is not sold twice, so a file imported again
 *     writes no second abonnement;
 *   - money only when the file has a «paid» column: the plan price as a charge
 *     and what was paid as an 'other' payment received on the start date. With
 *     no such column the abonnement arrives as settled history, so a migration
 *     never invents revenue;
 *   - minors under the guardian whose e-mail the row names (an adult already
 *     in the club, or one created earlier in the same file).
 * The community tier's member cap is checked after the writes and refuses the
 * whole file, so a half-imported list is impossible.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TransactionalDb extends SqlRunner {
  transaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

export class ClubImportFileError extends Error {
  constructor(readonly code: 'csv_truncated' | 'no_rows' | 'too_many_rows' | 'name_unmapped') {
    super(code);
  }
}

export type ClubImportMapping = Partial<Record<ClubImportField, number>>;

const BG_ALIASES = (
  columns as unknown as { clubMembers: Partial<Record<ClubImportField, string[]>> }
).clubMembers;

function aliases(): Record<ClubImportField, readonly string[]> {
  return Object.fromEntries(
    CLUB_IMPORT_FIELDS.map((field) => [
      field,
      [...(BG_ALIASES[field] ?? []), ...CLUB_IMPORT_ASCII_ALIASES[field]],
    ]),
  ) as unknown as Record<ClubImportField, readonly string[]>;
}

export function guessClubMapping(headers: string[]): ClubImportMapping {
  const mapping: ClubImportMapping = {};
  const table = aliases();
  headers.forEach((header, index) => {
    const field = guessColumn(header, table) as ClubImportField | undefined;
    if (field && mapping[field] === undefined) mapping[field] = index;
  });
  return mapping;
}

export function parseClubCsv(csv: string): { headers: string[]; rows: string[][] } {
  const parsed = parseCsv(csv, detectDelimiter(csv));
  if (parsed.truncated) throw new ClubImportFileError('csv_truncated');
  if (parsed.rows.length === 0) throw new ClubImportFileError('no_rows');
  if (parsed.rows.length > MAX_CLUB_IMPORT_ROWS) throw new ClubImportFileError('too_many_rows');
  return { headers: parsed.headers, rows: parsed.rows };
}

export function rowsFromClubCsv(csv: string, mapping: ClubImportMapping): NormalizedImportRow[] {
  if (mapping.name === undefined) throw new ClubImportFileError('name_unmapped');
  const { rows } = parseClubCsv(csv);
  return rows.map((cells, index) => {
    const raw: Partial<Record<ClubImportField, string>> = {};
    for (const field of CLUB_IMPORT_FIELDS) {
      const column = mapping[field];
      if (column !== undefined) raw[field] = cells[column] ?? '';
    }
    return normalizeImportRow(index + 2, raw);
  });
}

interface PlanRow {
  id: string;
  names: string[];
  kind: string;
  audience: string;
  nameBg: string;
  priceCents: number;
  validityDays: number | null;
  validityMonths: number | null;
  visitsCount: number | null;
  noticeDays: number;
  minTermMonths: number | null;
  selfPauseAllowed: boolean;
  selfCancelAllowed: boolean;
}

async function clubPlans(db: SqlRunner, actor: ClubActor): Promise<PlanRow[]> {
  const result = await db.execute(sql`
    SELECT p.id, p.name_bg, p.name_en, p.kind, p.audience, p.price_cents, p.validity_days,
           p.validity_months, p.visits_count, p.notice_days, p.min_term_months,
           p.self_pause_allowed, p.self_cancel_allowed
      FROM club_plans p
     WHERE ${clubScope(actor, 'data.import', 'p')} AND p.archived_at IS NULL
  `);
  return result.rows.map((row) => ({
    id: String(row.id),
    names: [row.name_bg, row.name_en]
      .filter((name): name is string => typeof name === 'string')
      .map((name) => name.trim().toLowerCase()),
    kind: String(row.kind),
    audience: String(row.audience),
    nameBg: String(row.name_bg),
    priceCents: Number(row.price_cents),
    validityDays: row.validity_days === null ? null : Number(row.validity_days),
    validityMonths: row.validity_months === null ? null : Number(row.validity_months),
    visitsCount: row.visits_count === null ? null : Number(row.visits_count),
    noticeDays: Number(row.notice_days),
    minTermMonths: row.min_term_months === null ? null : Number(row.min_term_months),
    selfPauseAllowed: row.self_pause_allowed === true,
    selfCancelAllowed: row.self_cancel_allowed === true,
  }));
}

function findPlan(plans: PlanRow[], name: string | null): PlanRow | null {
  if (name === null) return null;
  const needle = name.trim().toLowerCase();
  return plans.find((plan) => plan.names.includes(needle)) ?? null;
}

async function existingMembers(db: SqlRunner, actor: ClubActor): Promise<ExistingMember[]> {
  const result = await db.execute(sql`
    SELECT m.id, m.display_name, m.email, m.phone, m.is_minor, g.email AS guardian_email
      FROM club_members m
      LEFT JOIN club_members g ON g.club_id = m.club_id AND g.id = m.guardian_member_id
     WHERE ${clubScope(actor, 'data.import', 'm')} AND m.archived_at IS NULL
  `);
  return result.rows.map((row) => ({
    id: String(row.id),
    displayName: String(row.display_name),
    email: row.email === null ? null : String(row.email),
    phone: row.phone === null ? null : String(row.phone),
    isMinor: row.is_minor === true,
    guardianEmail: row.guardian_email === null ? null : String(row.guardian_email),
  }));
}

/** 0041's club_memberships_window_sane, checked before the insert would be. */
const MAX_WINDOW_DAYS = 800;

type RowPlan =
  | { kind: 'none' }
  | { kind: 'unknown' }
  | { kind: 'error'; error: 'plan_audience' | 'window_invalid' }
  | { kind: 'ok'; plan: PlanRow; startsOn: IsoDate; endsOn: IsoDate };

/**
 * The membership a row would create: the plan it names, and the window from
 * the file or from the plan's validity. The preview and the commit both use
 * this, so a row the preview shows as an error is never written.
 */
function rowPlan(row: ClubImportRow, plans: PlanRow[], today: IsoDate): RowPlan {
  if (row.plan === null) return { kind: 'none' };
  const plan = findPlan(plans, row.plan);
  if (!plan) return { kind: 'unknown' };
  if ((plan.audience === 'adults' && row.isMinor) || (plan.audience === 'minors' && !row.isMinor)) {
    return { kind: 'error', error: 'plan_audience' };
  }
  const startsOn = row.startsOn ?? today;
  const endsOn =
    row.endsOn ??
    membershipEndsOn(
      startsOn,
      plan.validityDays !== null
        ? { days: plan.validityDays }
        : { months: plan.validityMonths ?? 1 },
    );
  const span = daysBetween(startsOn, endsOn);
  if (span < 0 || span > MAX_WINDOW_DAYS) return { kind: 'error', error: 'window_invalid' };
  return { kind: 'ok', plan, startsOn, endsOn };
}

export type ClubImportRowView =
  | {
      line: number;
      status: 'invalid';
      errors: string[];
    }
  | {
      line: number;
      status: 'new' | 'match' | 'conflict';
      name: string;
      reason: string | null;
      plan: string | null;
      /** A plan named in the file that the club does not sell. */
      planUnknown: boolean;
      /** The abonnement's window as it will be written. */
      startsOn: IsoDate | null;
      endsOn: IsoDate | null;
      isMinor: boolean;
    };

export interface ClubImportPreview {
  rows: ClubImportRowView[];
  counts: { new: number; match: number; conflict: number; invalid: number };
}

export async function previewClubImport(
  actor: ClubActor,
  normalized: NormalizedImportRow[],
): Promise<ClubImportPreview> {
  const db = getDb();
  const [existing, plans] = await Promise.all([existingMembers(db, actor), clubPlans(db, actor)]);
  const today = sofiaToday();
  const checked = withPlanErrors(normalized, plans, today);
  const valid = checked.filter((r): r is { ok: true; row: ClubImportRow } => r.ok);
  const classes = classifyImportRows(
    valid.map((r) => r.row),
    existing,
  );
  const byLine = new Map<number, ImportClass>();
  valid.forEach((r, i) => byLine.set(r.row.line, classes[i] as ImportClass));
  const counts = { new: 0, match: 0, conflict: 0, invalid: 0 };
  const rows = checked.map((r): ClubImportRowView => {
    if (!r.ok) {
      counts.invalid += 1;
      return { line: r.line, status: 'invalid', errors: r.errors };
    }
    const c = byLine.get(r.row.line) as ImportClass;
    counts[c.kind] += 1;
    const target = rowPlan(r.row, plans, today);
    return {
      line: r.row.line,
      status: c.kind,
      name: r.row.displayName,
      reason: c.kind === 'conflict' ? c.reason : null,
      plan: r.row.plan,
      planUnknown: target.kind === 'unknown',
      startsOn: target.kind === 'ok' ? target.startsOn : null,
      endsOn: target.kind === 'ok' ? target.endsOn : null,
      isMinor: r.row.isMinor,
    };
  });
  return { rows, counts };
}

/** Rows whose abonnement would be refused become row errors, in both steps. */
function withPlanErrors(
  normalized: NormalizedImportRow[],
  plans: PlanRow[],
  today: IsoDate,
): NormalizedImportRow[] {
  return normalized.map((r) => {
    if (!r.ok) return r;
    const target = rowPlan(r.row, plans, today);
    return target.kind === 'error' ? { ok: false, line: r.row.line, errors: [target.error] } : r;
  });
}

export interface ClubImportResult {
  created: number;
  updated: number;
  memberships: number;
  skipped: number;
  invalid: number;
}

export type ClubImportOutcome =
  | { ok: true; result: ClubImportResult }
  | { ok: false; error: 'member_cap_reached' | 'not_allowed' };

/**
 * Commit. `asNew` lists the conflict lines the person chose to create as new
 * records; every other conflict is skipped.
 */
export async function commitClubImport(
  db: TransactionalDb,
  actor: ClubActor,
  normalized: NormalizedImportRow[],
  asNew: ReadonlySet<number>,
): Promise<ClubImportOutcome> {
  const cap = new Error('member_cap_reached');
  try {
    const result = await db.transaction(async (tx) => {
      const allowed = await tx.execute(sql`
        SELECT 1 WHERE ${clubActorMay(actor, 'data.import', { write: true })}
      `);
      if (allowed.rows.length === 0) return null;
      // Serialise with the desk's sales under the cap (sellMembership's lock).
      await tx.execute(sql`SELECT 1 FROM clubs WHERE id = ${actor.clubId}::uuid FOR NO KEY UPDATE`);
      const [existing, plans] = await Promise.all([
        existingMembers(tx, actor),
        clubPlans(tx, actor),
      ]);
      const today = sofiaToday();
      const valid = withPlanErrors(normalized, plans, today).flatMap((r) => (r.ok ? [r.row] : []));
      const classes = classifyImportRows(valid, existing);
      const out: ClubImportResult = {
        created: 0,
        updated: 0,
        memberships: 0,
        skipped: 0,
        invalid: normalized.length - valid.length,
      };
      // Adults first, so a child's guardian created by this file exists.
      const order = valid
        .map((row, i) => ({ row, cls: classes[i] as ImportClass }))
        .sort((a, b) => Number(a.row.isMinor) - Number(b.row.isMinor));
      // A guardian is linked only when the e-mail names ONE adult; null marks
      // an e-mail several adults share, and the child is then left unlinked.
      const adultsByEmail = new Map<string, string | null>();
      const noteAdult = (email: string, id: string) =>
        adultsByEmail.set(email, adultsByEmail.has(email) ? null : id);
      for (const member of existing) {
        if (member.email && !member.isMinor) noteAdult(member.email, member.id);
      }

      for (const { row, cls } of order) {
        let memberId: string | null = null;
        if (cls.kind === 'match') {
          memberId = cls.memberId;
          await tx.execute(sql`
            UPDATE club_members m
               SET email = coalesce(m.email, ${row.email}),
                   phone = coalesce(m.phone, ${row.phone}),
                   -- The union of tags, first spelling wins case-insensitively
                   -- (club_tags_valid), at most 20.
                   tags = (SELECT coalesce((array_agg(d.t ORDER BY d.ord))[1:20], '{}')
                             FROM (SELECT DISTINCT ON (lower(u.t)) u.t, u.ord
                                     FROM unnest(m.tags || ${sql.param(row.tags)}::text[])
                                          WITH ORDINALITY AS u(t, ord)
                                    ORDER BY lower(u.t), u.ord) d)
             WHERE m.id = ${memberId}::uuid AND m.club_id = ${actor.clubId}::uuid
               AND ${clubActorMay(actor, 'data.import', { write: true })}
          `);
          out.updated += 1;
        } else if (cls.kind === 'new' || asNew.has(row.line)) {
          const guardianId = row.guardianEmail
            ? (adultsByEmail.get(row.guardianEmail) ?? null)
            : null;
          const created = await tx.execute(sql`
            INSERT INTO club_members (club_id, display_name, email, phone, is_minor,
                                      guardian_member_id, tags, source)
            SELECT ${actor.clubId}::uuid, ${row.displayName}, ${row.email}, ${row.phone},
                   ${row.isMinor}, ${guardianId}::uuid, ${sql.param(row.tags)}::text[], 'import'
             WHERE ${clubActorMay(actor, 'data.import', { write: true })}
            RETURNING id
          `);
          memberId = created.rows[0] ? String(created.rows[0].id) : null;
          if (memberId && !row.isMinor && row.email) noteAdult(row.email, memberId);
          if (memberId) out.created += 1;
        } else {
          out.skipped += 1;
          continue;
        }
        if (!memberId) continue;

        const target = rowPlan(row, plans, today);
        if (target.kind !== 'ok') continue;
        const { plan, startsOn, endsOn } = target;
        // The plan's own count, as a desk sale writes it (a trial may have none).
        const visitsTotal = plan.visitsCount;
        const offset =
          visitsTotal !== null && row.visitsLeft !== null
            ? Math.max(0, visitsTotal - Math.min(row.visitsLeft, visitsTotal))
            : 0;
        const sold = await tx.execute(sql`
          INSERT INTO club_memberships (club_id, member_id, plan_id, plan_name, kind, audience,
                                        price_cents, visits_total, starts_on, ends_on,
                                        visits_used_offset, sold_by, notice_days, min_term_months,
                                        self_pause_allowed, self_cancel_allowed)
          SELECT ${actor.clubId}::uuid, ${memberId}::uuid, ${plan.id}::uuid, ${plan.nameBg},
                 ${plan.kind}, ${plan.audience}, ${plan.priceCents}, ${visitsTotal},
                 ${startsOn}::date, ${endsOn}::date, ${offset}, NULL, ${plan.noticeDays},
                 ${plan.minTermMonths}, ${plan.selfPauseAllowed}, ${plan.selfCancelAllowed}
           WHERE ${clubActorMay(actor, 'data.import', { write: true })}
             AND NOT EXISTS (SELECT 1 FROM club_memberships x
                              WHERE x.club_id = ${actor.clubId}::uuid
                                AND x.member_id = ${memberId}::uuid
                                AND x.plan_id = ${plan.id}::uuid AND x.cancelled_at IS NULL
                                AND x.starts_on <= ${endsOn}::date AND x.ends_on >= ${startsOn}::date)
          ON CONFLICT DO NOTHING
          RETURNING id
        `);
        const membershipId = sold.rows[0] ? String(sold.rows[0].id) : null;
        if (!membershipId) continue;
        out.memberships += 1;
        if (row.paidCents !== null && plan.priceCents > 0) {
          const charge = await tx.execute(sql`
            INSERT INTO club_charges (club_id, member_id, membership_id, kind, label, amount_cents,
                                      issued_on, due_on, created_by)
            SELECT ${actor.clubId}::uuid, ${memberId}::uuid, ${membershipId}::uuid, 'membership',
                   ${plan.nameBg}, ${plan.priceCents}, ${startsOn}::date, ${startsOn}::date,
                   ${actor.userId}
             WHERE ${clubActorMay(actor, 'data.import', { write: true })}
            RETURNING id
          `);
          const chargeId = charge.rows[0] ? String(charge.rows[0].id) : null;
          const paid = Math.min(row.paidCents, plan.priceCents);
          if (chargeId && paid > 0) {
            await tx.execute(sql`
              INSERT INTO club_payments (club_id, charge_id, member_id, kind, amount_cents, method,
                                         received_on, recorded_by)
              SELECT ${actor.clubId}::uuid, ${chargeId}::uuid, ${memberId}::uuid, 'payment',
                     ${paid}, 'other', least(${startsOn}::date, ${today}::date), ${actor.userId}
               WHERE ${clubActorMay(actor, 'data.import', { write: true })}
            `);
          }
        }
      }

      const capped = await tx.execute(sql`
        SELECT c.member_cap,
               (SELECT count(DISTINCT b.member_id)::int FROM club_membership_balances b
                 WHERE b.club_id = c.id AND b.state IN ('active', 'paused', 'upcoming')) AS live
          FROM clubs c WHERE c.id = ${actor.clubId}::uuid
      `);
      const capRow = capped.rows[0];
      if (capRow && capRow.member_cap !== null && Number(capRow.live) > Number(capRow.member_cap)) {
        throw cap;
      }
      await recordClubAudit(tx, {
        clubId: actor.clubId,
        by: { kind: 'staff', actor },
        action: 'import_committed',
        detail: { ...out },
      });
      return out;
    });
    return result ? { ok: true, result } : { ok: false, error: 'not_allowed' };
  } catch (error: unknown) {
    if (error === cap) return { ok: false, error: 'member_cap_reached' };
    throw error;
  }
}
