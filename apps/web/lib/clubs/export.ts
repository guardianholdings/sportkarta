import { getDb, sql, type SQL } from '@sportkarta/db';
import type { ClubPermission } from '@sportkarta/lib/clubs';
import { toCsv } from '@sportkarta/lib/csv';

import { recordClubAudit } from './audit';
import { clubScope, type ClubActor, type ScopeAlias } from './scope';

/**
 * The club's data, as CSV — the club is the controller and may take its data
 * at any time (no lock-in, plan §5.7). One file per dataset, each a fixed
 * SELECT list with the club scope in the statement, returned as ONE text[]
 * per row so a column can never land under another column's header.
 *
 * NEVER IN AN EXPORT: a token or a hash (card, invite, unsubscribe), a POPS
 * account id, anything from the member's passport, or who at the NGO looked.
 * Staff appear by display name. Every download is written to club_audit.
 */

export const CLUB_EXPORT_DATASETS = [
  'members',
  'memberships',
  'charges',
  'payments',
  'checkins',
  'bookings',
  'classes',
  'plans',
  'reservations',
  'sales',
  'invoices',
  'audit',
] as const;
export type ClubExportDataset = (typeof CLUB_EXPORT_DATASETS)[number];

export function isClubExportDataset(value: string): value is ClubExportDataset {
  return (CLUB_EXPORT_DATASETS as readonly string[]).includes(value);
}

interface Dataset {
  /** Who may download it — the payments ledger is front of house, the rest management. */
  permission: ClubPermission;
  alias: ScopeAlias;
  header: string[];
  query: (scope: SQL) => SQL;
}

const DAY = (column: SQL) => sql`to_char(${column}, 'YYYY-MM-DD')`;
const STAMP = (column: SQL) =>
  sql`to_char(${column} AT TIME ZONE 'Europe/Sofia', 'YYYY-MM-DD HH24:MI')`;
const EUR = (cents: SQL) => sql`to_char(${cents} / 100.0, 'FM999999990.00')`;

const DATASETS: Record<ClubExportDataset, Dataset> = {
  members: {
    permission: 'data.export',
    alias: 'm',
    header: [
      'id',
      'name',
      'email',
      'phone',
      'is_minor',
      'guardian',
      'tags',
      'status',
      'linked_to_pops',
      'source',
      'note',
      'created',
      'archived',
    ],
    query: (scope) => sql`
      SELECT ARRAY[m.id::text, m.display_name, coalesce(m.email, ''), coalesce(m.phone, ''),
             m.is_minor::text, coalesce(g.display_name, ''), array_to_string(m.tags, ';'),
             st.status, (l.status = 'active')::text, m.source, coalesce(m.staff_note, ''),
             ${STAMP(sql`m.created_at`)}, coalesce(${STAMP(sql`m.archived_at`)}, '')]::text[] AS r
        FROM club_members m
        JOIN club_member_status st ON st.member_id = m.id
        LEFT JOIN club_members g ON g.club_id = m.club_id AND g.id = m.guardian_member_id
        LEFT JOIN club_member_links l ON l.member_id = m.id
       WHERE ${scope}
       ORDER BY lower(m.display_name), m.id`,
  },
  memberships: {
    permission: 'data.export',
    alias: 'mb',
    header: [
      'member',
      'plan',
      'kind',
      'price_eur',
      'starts_on',
      'ends_on',
      'effective_ends_on',
      'visits_total',
      'visits_remaining',
      'state',
      'cancel_reason',
    ],
    query: (scope) => sql`
      SELECT ARRAY[m.display_name, mb.plan_name, mb.kind, ${EUR(sql`mb.price_cents`)},
             ${DAY(sql`mb.starts_on`)}, ${DAY(sql`mb.ends_on`)}, ${DAY(sql`mb.effective_ends_on`)},
             coalesce(mb.visits_total::text, ''), coalesce(mb.visits_remaining::text, ''),
             mb.state, coalesce(mb.cancel_reason, '')]::text[] AS r
        FROM club_membership_balances mb
        JOIN club_members m ON m.club_id = mb.club_id AND m.id = mb.member_id
       WHERE ${scope}
       ORDER BY mb.starts_on, lower(m.display_name)`,
  },
  charges: {
    permission: 'data.export',
    alias: 'cb',
    header: [
      'member',
      'label',
      'kind',
      'amount_eur',
      'paid_eur',
      'due_eur',
      'issued_on',
      'due_on',
      'status',
    ],
    query: (scope) => sql`
      SELECT ARRAY[coalesce(m.display_name, ''), cb.label, cb.kind, ${EUR(sql`cb.amount_cents`)},
             ${EUR(sql`cb.paid_cents`)}, ${EUR(sql`cb.due_cents`)}, ${DAY(sql`cb.issued_on`)},
             ${DAY(sql`cb.due_on`)}, cb.status]::text[] AS r
        FROM club_charge_balances cb
        LEFT JOIN club_members m ON m.club_id = cb.club_id AND m.id = cb.member_id
       WHERE ${scope}
       ORDER BY cb.issued_on, cb.charge_id`,
  },
  payments: {
    permission: 'payments.view',
    alias: 'p',
    header: ['received_on', 'member', 'for', 'kind', 'method', 'amount_eur', 'recorded_by'],
    query: (scope) => sql`
      SELECT ARRAY[${DAY(sql`p.received_on`)}, coalesce(m.display_name, ''), ch.label, p.kind, p.method,
             ${EUR(sql`p.amount_cents`)}, coalesce(nullif(btrim(st.display_name), ''), nullif(btrim(u.display_name), ''), split_part(u.email, '@', 1), '')]::text[] AS r
        FROM club_payments p
        JOIN club_charges ch ON ch.club_id = p.club_id AND ch.id = p.charge_id
        LEFT JOIN club_members m ON m.club_id = p.club_id AND m.id = p.member_id
        LEFT JOIN club_staff st ON st.club_id = p.club_id AND st.user_id = p.recorded_by
        LEFT JOIN users u ON u.id = p.recorded_by
       WHERE ${scope}
       ORDER BY p.received_on, p.id`,
  },
  checkins: {
    permission: 'data.export',
    alias: 'ci',
    header: ['day', 'time', 'member', 'class', 'location', 'method', 'covered'],
    query: (scope) => sql`
      SELECT ARRAY[${DAY(sql`ci.sofia_day`)}, to_char(ci.checked_in_at AT TIME ZONE 'Europe/Sofia', 'HH24:MI'),
             m.display_name, coalesce(k.title, ''), l.name, ci.method, ci.covered::text]::text[] AS r
        FROM club_checkins ci
        JOIN club_members m ON m.club_id = ci.club_id AND m.id = ci.member_id
        JOIN club_locations l ON l.club_id = ci.club_id AND l.id = ci.location_id
        LEFT JOIN club_class_occurrences o ON o.club_id = ci.club_id AND o.id = ci.occurrence_id
        LEFT JOIN club_classes k ON k.id = o.class_id
       WHERE ${scope}
       ORDER BY ci.checked_in_at, ci.id`,
  },
  bookings: {
    permission: 'data.export',
    alias: 'b',
    header: ['class', 'starts', 'member', 'state', 'booked_at', 'trial'],
    query: (scope) => sql`
      SELECT ARRAY[k.title, to_char(o.starts_at_local, 'YYYY-MM-DD HH24:MI'), m.display_name, b.state,
             ${STAMP(sql`b.created_at`)}, b.is_trial::text]::text[] AS r
        FROM club_bookings b
        JOIN club_class_occurrences o ON o.club_id = b.club_id AND o.id = b.occurrence_id
        JOIN club_classes k ON k.id = o.class_id
        JOIN club_members m ON m.club_id = b.club_id AND m.id = b.member_id
       WHERE ${scope}
       ORDER BY o.starts_at, b.seq`,
  },
  // Courts, rooms and trainer appointments (0048).
  reservations: {
    permission: 'data.export',
    alias: 'rv',
    header: ['service', 'starts', 'ends', 'member', 'resource', 'state', 'price_eur', 'booked_at'],
    query: (scope) => sql`
      SELECT ARRAY[sv.name_bg, ${STAMP(sql`rv.starts_at`)}, ${STAMP(sql`rv.ends_at`)},
             coalesce(m.display_name, ''), coalesce(rs.name, ''), rv.state,
             ${EUR(sql`rv.price_cents`)}, ${STAMP(sql`rv.created_at`)}]::text[] AS r
        FROM club_reservations rv
        JOIN club_services sv ON sv.club_id = rv.club_id AND sv.id = rv.service_id
        LEFT JOIN club_members m ON m.club_id = rv.club_id AND m.id = rv.member_id
        LEFT JOIN club_resources rs ON rs.club_id = rv.club_id AND rs.id = rv.resource_id
       WHERE ${scope}
       ORDER BY rv.starts_at, rv.id`,
  },
  // Till sales, line by line (0049) — not a fiscal record.
  sales: {
    permission: 'data.export',
    alias: 'sa',
    header: [
      'number',
      'sold_at',
      'member',
      'product',
      'quantity',
      'unit_eur',
      'discount_eur',
      'line_eur',
      'vat_bp',
      'reversed',
    ],
    query: (scope) => sql`
      SELECT ARRAY[sa.number::text, ${STAMP(sql`sa.sold_at`)}, coalesce(m.display_name, ''),
             sl.name, sl.quantity::text, ${EUR(sql`sl.unit_price_cents`)},
             ${EUR(sql`sl.discount_cents`)}, ${EUR(sql`sl.total_cents`)}, sl.vat_rate_bp::text,
             (sa.reversed_at IS NOT NULL)::text]::text[] AS r
        FROM club_sales sa
        JOIN club_sale_lines sl ON sl.club_id = sa.club_id AND sl.sale_id = sa.id
        LEFT JOIN club_members m ON m.club_id = sa.club_id AND m.id = sa.member_id
       WHERE ${scope}
       ORDER BY sa.number, sl.line_no`,
  },
  // Invoices and credit notes (0050), one row per line; a credit note's
  // amounts are as printed (positive), its kind says it corrects.
  invoices: {
    permission: 'data.export',
    alias: 'i',
    header: [
      'number',
      'kind',
      'issued_on',
      'tax_event_on',
      'corrects_number',
      'buyer',
      'buyer_eik',
      'buyer_vat_number',
      'payment_method',
      'line',
      'quantity',
      'unit_eur',
      'discount_eur',
      'vat_bp',
      'base_eur',
      'vat_eur',
      'line_eur',
    ],
    query: (scope) => sql`
      SELECT ARRAY[lpad(i.number::text, 10, '0'), i.kind, i.issued_on::text, i.tax_event_on::text,
             coalesce((SELECT lpad(c.number::text, 10, '0') FROM club_invoices c
                        WHERE c.club_id = i.club_id AND c.id = i.corrects_id), ''),
             i.buyer_name, coalesce(i.buyer_eik, ''), coalesce(i.buyer_vat_number, ''),
             i.payment_method, il.description, il.quantity::text, ${EUR(sql`il.unit_price_cents`)},
             ${EUR(sql`il.discount_cents`)}, coalesce(il.vat_rate_bp::text, ''),
             ${EUR(sql`il.base_cents`)}, ${EUR(sql`il.vat_cents`)},
             ${EUR(sql`il.total_cents`)}]::text[] AS r
        FROM club_invoices i
        JOIN club_invoice_lines il ON il.club_id = i.club_id AND il.invoice_id = i.id
       WHERE ${scope}
       ORDER BY i.number, il.line_no`,
  },
  classes: {
    permission: 'data.export',
    alias: 'k',
    header: [
      'title',
      'sport',
      'location',
      'first',
      'rule',
      'minutes',
      'capacity',
      'status',
      'public',
    ],
    query: (scope) => sql`
      SELECT ARRAY[k.title, k.sport, l.name, to_char(k.starts_at_local, 'YYYY-MM-DD HH24:MI'),
             coalesce(k.rrule, ''), k.duration_minutes::text, coalesce(k.capacity::text, ''),
             k.status, k.public::text]::text[] AS r
        FROM club_classes k
        JOIN club_locations l ON l.club_id = k.club_id AND l.id = k.location_id
       WHERE ${scope}
       ORDER BY k.starts_at_local, k.title`,
  },
  plans: {
    permission: 'data.export',
    alias: 'pl',
    header: [
      'name',
      'kind',
      'audience',
      'price_eur',
      'validity_days',
      'validity_months',
      'visits',
      'visibility',
      'archived',
    ],
    query: (scope) => sql`
      SELECT ARRAY[pl.name_bg, pl.kind, pl.audience, ${EUR(sql`pl.price_cents`)},
             coalesce(pl.validity_days::text, ''), coalesce(pl.validity_months::text, ''),
             coalesce(pl.visits_count::text, ''), pl.visibility, (pl.archived_at IS NOT NULL)::text]::text[] AS r
        FROM club_plans pl
       WHERE ${scope}
       ORDER BY pl.name_bg`,
  },
  audit: {
    permission: 'audit.view',
    alias: 'a',
    header: ['at', 'by', 'actor_kind', 'action', 'member'],
    query: (scope) => sql`
      SELECT ARRAY[${STAMP(sql`a.acted_at`)},
             CASE WHEN a.actor_kind = 'ngo_admin' THEN 'POPS'
                  ELSE coalesce(nullif(btrim(st.display_name), ''), nullif(btrim(u.display_name), ''), split_part(u.email, '@', 1), '') END,
             a.actor_kind, a.action, coalesce(m.display_name, '')]::text[] AS r
        FROM club_audit a
        LEFT JOIN club_staff st ON st.club_id = a.club_id AND st.user_id = a.actor_id
        LEFT JOIN users u ON u.id = a.actor_id AND a.actor_kind = 'staff'
        LEFT JOIN club_members m ON m.club_id = a.club_id AND m.id = a.subject_member_id
       WHERE ${scope}
       ORDER BY a.acted_at, a.id`,
  },
};

export function exportPermission(dataset: ClubExportDataset): ClubPermission {
  return DATASETS[dataset].permission;
}

/** The CSV of one dataset, and the audit row saying it left. */
export async function clubExportCsv(actor: ClubActor, dataset: ClubExportDataset): Promise<string> {
  const spec = DATASETS[dataset];
  const db = getDb();
  const result = await db.execute(spec.query(clubScope(actor, spec.permission, spec.alias)));
  // One text[] per row (`AS r`), never an object: unaliased expressions share
  // a name (`coalesce`, `to_char`) and pg keeps one key per name, which shifted
  // columns under the wrong headers.
  const rows = result.rows.map((row) => {
    const cells = Array.isArray(row.r) ? row.r : [];
    return spec.header.map((_, i) => {
      const value: unknown = cells[i];
      return value === null || value === undefined ? '' : String(value);
    });
  });
  await recordClubAudit(db, {
    clubId: actor.clubId,
    // An NGO admin without a staff role is recorded as `ngo_admin` (audit.ts).
    by: { kind: 'staff', actor },
    action: 'export_downloaded',
    detail: { dataset, rows: rows.length },
  });
  // A BOM so Excel opens Cyrillic as UTF-8 rather than as mojibake.
  return `\uFEFF${toCsv([spec.header, ...rows])}`;
}
