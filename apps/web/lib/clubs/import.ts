import { getDb, sql, type SQL } from '@sportkarta/db';
import {
  CLUB_IMPORT_ASCII_ALIASES,
  CLUB_IMPORT_FIELDS,
  MAX_CLUB_IMPORT_ROWS,
  classifyImportRows,
  membershipEndsOn,
  normalizeImportRow,
  sofiaToday,
  type ClubImportField,
  type ClubImportRow,
  type ImportClass,
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
 *     `visits_used_offset` (0041's seam for exactly this);
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
}

async function clubPlans(db: SqlRunner, actor: ClubActor): Promise<PlanRow[]> {
  const result = await db.execute(sql`
    SELECT p.id, p.name_bg, p.name_en, p.kind, p.audience, p.price_cents, p.validity_days,
           p.validity_months, p.visits_count
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
  }));
}

function findPlan(plans: PlanRow[], name: string | null): PlanRow | null {
  if (name === null) return null;
  const needle = name.trim().toLowerCase();
  return plans.find((plan) => plan.names.includes(needle)) ?? null;
}

async function existingMembers(db: SqlRunner, actor: ClubActor) {
  const result = await db.execute(sql`
    SELECT m.id, m.email, m.phone FROM club_members m
     WHERE ${clubScope(actor, 'data.import', 'm')} AND m.archived_at IS NULL AND NOT m.is_minor
  `);
  return result.rows.map((row) => ({
    id: String(row.id),
    email: row.email === null ? null : String(row.email),
    phone: row.phone === null ? null : String(row.phone),
  }));
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
  const valid = normalized.filter((r): r is { ok: true; row: ClubImportRow } => r.ok);
  const classes = classifyImportRows(
    valid.map((r) => r.row),
    existing,
  );
  const byLine = new Map<number, ImportClass>();
  valid.forEach((r, i) => byLine.set(r.row.line, classes[i] as ImportClass));
  const counts = { new: 0, match: 0, conflict: 0, invalid: 0 };
  const rows = normalized.map((r): ClubImportRowView => {
    if (!r.ok) {
      counts.invalid += 1;
      return { line: r.line, status: 'invalid', errors: r.errors };
    }
    const c = byLine.get(r.row.line) as ImportClass;
    counts[c.kind] += 1;
    return {
      line: r.row.line,
      status: c.kind,
      name: r.row.displayName,
      reason: c.kind === 'conflict' ? c.reason : null,
      plan: r.row.plan,
      planUnknown: r.row.plan !== null && findPlan(plans, r.row.plan) === null,
      isMinor: r.row.isMinor,
    };
  });
  return { rows, counts };
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
      const valid = normalized.flatMap((r) => (r.ok ? [r.row] : []));
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
      const adultsByEmail = new Map<string, string>();
      for (const member of existing) {
        if (member.email && !adultsByEmail.has(member.email))
          adultsByEmail.set(member.email, member.id);
      }
      const today = sofiaToday();

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
             WHERE m.id = ${memberId}::uuid AND ${clubActorMay(actor, 'data.import', { write: true })}
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
          if (memberId && !row.isMinor && row.email && !adultsByEmail.has(row.email)) {
            adultsByEmail.set(row.email, memberId);
          }
          if (memberId) out.created += 1;
        } else {
          out.skipped += 1;
          continue;
        }
        if (!memberId) continue;

        const plan = findPlan(plans, row.plan);
        if (!plan) continue;
        const startsOn = row.startsOn ?? today;
        const endsOn =
          row.endsOn ??
          membershipEndsOn(
            startsOn,
            plan.validityDays !== null
              ? { days: plan.validityDays }
              : { months: plan.validityMonths ?? 1 },
          );
        const visitsTotal = plan.kind === 'unlimited' ? null : (plan.visitsCount ?? 1);
        const offset =
          visitsTotal !== null && row.visitsLeft !== null
            ? Math.max(0, visitsTotal - Math.min(row.visitsLeft, visitsTotal))
            : 0;
        const sold = await tx.execute(sql`
          INSERT INTO club_memberships (club_id, member_id, plan_id, plan_name, kind, audience,
                                        price_cents, visits_total, starts_on, ends_on,
                                        visits_used_offset, sold_by)
          SELECT ${actor.clubId}::uuid, ${memberId}::uuid, ${plan.id}::uuid, ${plan.nameBg},
                 ${plan.kind}, ${plan.audience}, ${plan.priceCents}, ${visitsTotal},
                 ${startsOn}::date, ${endsOn}::date, ${offset}, ${actor.userId}
           WHERE ${clubActorMay(actor, 'data.import', { write: true })}
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
