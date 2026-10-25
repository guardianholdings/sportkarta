import {
  addDaysIso,
  membershipEndsOn,
  renewsInto,
  sofiaToday,
  type IsoDate,
} from '@sportkarta/lib/clubs';
import { sql, type SQL } from 'drizzle-orm';

/**
 * The daily club.policies job's writes (0045): renewing abonnements and the
 * no-show / late-cancel fees. Mail about them is sent afterwards by the worker
 * from the sweeps at the bottom, through the club_notifications ledger — so a
 * failed send is retried tomorrow, and a renewal is never undone by a mail
 * failure.
 *
 * BOTH WRITES ARE IDEMPOTENT BY CONSTRAINT, not by bookkeeping:
 *   - a period has at most one successor (club_memberships_one_successor);
 *   - a booking has at most one fee (club_charges_one_fee_per_booking).
 * A second run the same day, or two workers, insert nothing new.
 *
 * Only a club that may WRITE is touched — the SQL twin of canWrite in
 * lib/src/clubs/access.ts (apps/web/lib/clubs/access.ts clubWritableSql): a
 * suspended or lapsed club neither renews nor charges.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TransactionalDb extends SqlRunner {
  transaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

function writable(today: IsoDate): SQL {
  return sql`c.status = 'active' AND (c.tier = 'community'
    OR greatest(c.paid_until, c.trial_ends_on) + 14 >= ${today}::date)`;
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

// ─── Renewals ──────────────────────────────────────────────────────────────

export interface RenewalReport {
  renewed: number;
  ended: number;
}

/**
 * Append the next period to every renewing membership whose period ends
 * today or earlier (or whose visit card is used up), price and name from the
 * plan AS IT IS NOW — a price change applies from the next period, which is
 * how a club announces one. A chain stops (renews = false) when the member's
 * notice has run out, when the plan was archived, or when the club cancelled
 * the membership. One transaction per membership.
 */
export async function renewClubMemberships(
  db: TransactionalDb,
  today: IsoDate,
  limit = 500,
): Promise<RenewalReport> {
  const due = await db.execute(sql`
    SELECT mb.membership_id, mb.club_id, mb.member_id, mb.plan_id, mb.state,
           to_char(mb.effective_ends_on, 'YYYY-MM-DD') AS effective_ends_on
      FROM club_membership_balances mb
      JOIN club_memberships ms ON ms.id = mb.membership_id
      JOIN clubs c ON c.id = mb.club_id
     WHERE ms.renews AND ms.cancelled_at IS NULL
       AND (mb.effective_ends_on <= ${today}::date OR mb.state = 'exhausted')
       AND NOT EXISTS (SELECT 1 FROM club_memberships nx WHERE nx.renewal_of = ms.id)
       AND ${writable(today)}
     ORDER BY mb.effective_ends_on
     LIMIT ${limit}
  `);
  const report: RenewalReport = { renewed: 0, ended: 0 };
  for (const row of due.rows) {
    const membershipId = String(row.membership_id);
    const effectiveEnds = String(row.effective_ends_on);
    // A used-up visit card renews from today; a period renews from the day
    // after it ends, even when the job runs late, so the contract has no gap.
    const nextStart =
      row.state === 'exhausted' && effectiveEnds > today ? today : addDaysIso(effectiveEnds, 1);
    const outcome = await db.transaction(async (tx) => {
      const found = await tx.execute(sql`
        SELECT ms.club_id, ms.member_id, ms.renewal_ends_on, ms.term_started_on, ms.starts_on,
               p.id AS plan_id, p.name_bg, p.kind, p.audience, p.price_cents, p.validity_days,
               p.validity_months, p.visits_count, p.archived_at, p.auto_renew
          FROM club_memberships ms
          JOIN club_plans p ON p.club_id = ms.club_id AND p.id = ms.plan_id
         WHERE ms.id = ${membershipId}::uuid AND ms.renews AND ms.cancelled_at IS NULL
           FOR NO KEY UPDATE OF ms
      `);
      const m = found.rows[0];
      if (!m) return 'skip' as const;
      const renewalEndsOn = text(m.renewal_ends_on);
      const contractOver = !renewsInto(nextStart, renewalEndsOn);
      if (contractOver || m.archived_at !== null || m.kind === 'trial') {
        await tx.execute(
          sql`UPDATE club_memberships SET renews = false WHERE id = ${membershipId}::uuid`,
        );
        return 'ended' as const;
      }
      const endsOn = membershipEndsOn(
        nextStart,
        m.validity_days !== null
          ? { days: Number(m.validity_days) }
          : { months: Number(m.validity_months) },
      );
      const priceCents = Number(m.price_cents);
      const inserted = await tx.execute(sql`
        INSERT INTO club_memberships (club_id, member_id, plan_id, plan_name, kind, audience,
                                      price_cents, visits_total, starts_on, ends_on, renews,
                                      renewal_of, term_started_on, renewal_ends_on)
        VALUES (${String(m.club_id)}::uuid, ${String(m.member_id)}::uuid, ${String(m.plan_id)}::uuid,
                ${String(m.name_bg)}, ${String(m.kind)}, ${String(m.audience)}, ${priceCents},
                ${m.visits_count === null ? null : Number(m.visits_count)},
                ${nextStart}::date, ${endsOn}::date, true, ${membershipId}::uuid,
                coalesce(${text(m.term_started_on)}::date, ${String(m.starts_on)}::date),
                ${renewalEndsOn}::date)
        ON CONFLICT DO NOTHING
        RETURNING id
      `);
      const successor = text(inserted.rows[0]?.id);
      if (!successor) return 'skip' as const;
      if (priceCents > 0) {
        await tx.execute(sql`
          INSERT INTO club_charges (club_id, member_id, membership_id, kind, label, amount_cents,
                                    issued_on, due_on)
          VALUES (${String(m.club_id)}::uuid, ${String(m.member_id)}::uuid, ${successor}::uuid,
                  'membership', ${String(m.name_bg)}, ${priceCents},
                  least(${today}::date, ${nextStart}::date),
                  greatest(${today}::date, ${nextStart}::date))
        `);
      }
      await tx.execute(sql`
        INSERT INTO club_audit (club_id, actor_kind, actor_id, action, subject_member_id, detail)
        VALUES (${String(m.club_id)}::uuid, 'system', NULL, 'membership_renewed',
                ${String(m.member_id)}::uuid,
                jsonb_build_object('membershipId', ${successor}::text,
                                   'renewalOf', ${membershipId}::text,
                                   'priceCents', ${priceCents}::int))
      `);
      return 'renewed' as const;
    });
    if (outcome === 'renewed') report.renewed += 1;
    if (outcome === 'ended') report.ended += 1;
  }
  return report;
}

// ─── No-show and late-cancel fees ──────────────────────────────────────────

export interface FeeLabels {
  noShow: string;
  lateCancel: string;
}

/**
 * Raise a fee for each booking that earned one in the last seven days:
 *   no-show      a booking that was GOING (inside capacity) at an occurrence
 *                that ended over an hour ago, with no check-in — the desk has
 *                had the hour to tick a late arrival;
 *   late cancel  a booking cancelled after the class's free-cancel deadline.
 * Trials never pay a fee. The label is `<word> — <class title>` in the
 * club's language, ≤ 120 characters (club_charges_label_sane).
 */
export async function chargeClubBookingFees(
  db: TransactionalDb,
  now: Date,
  labelsFor: (locale: 'bg' | 'en') => FeeLabels,
  limit = 1000,
): Promise<number> {
  const today = sofiaToday(now);
  const due = await db.execute(sql`
    SELECT q.booking_id, q.club_id, q.member_id, q.fee_cents, q.kind, q.title, q.locale,
           to_char(q.day, 'YYYY-MM-DD') AS day
      FROM (
        SELECT p.booking_id, p.club_id, p.member_id, k.no_show_fee_cents AS fee_cents,
               'no_show' AS kind, k.title, c.locale, (o.starts_at AT TIME ZONE 'Europe/Sofia')::date AS day
          FROM club_booking_positions p
          JOIN club_class_occurrences o ON o.id = p.occurrence_id
          JOIN club_classes k ON k.id = o.class_id
          JOIN clubs c ON c.id = p.club_id
         WHERE p.booking_status = 'going' AND NOT p.is_trial AND o.status = 'scheduled'
           AND k.no_show_fee_cents IS NOT NULL
           AND o.ends_at < ${now.toISOString()}::timestamptz - interval '1 hour'
           AND o.ends_at > ${now.toISOString()}::timestamptz - interval '7 days'
           AND NOT EXISTS (SELECT 1 FROM club_checkins ci
                            WHERE ci.occurrence_id = p.occurrence_id AND ci.member_id = p.member_id)
           AND ${writable(today)}
        UNION ALL
        SELECT b.id, b.club_id, b.member_id, k.late_cancel_fee_cents, 'late_cancel', k.title,
               c.locale, (o.starts_at AT TIME ZONE 'Europe/Sofia')::date
          FROM club_bookings b
          JOIN club_class_occurrences o ON o.id = b.occurrence_id
          JOIN club_classes k ON k.id = o.class_id
          JOIN clubs c ON c.id = b.club_id
         WHERE b.state = 'late_cancelled' AND NOT b.is_trial AND o.status = 'scheduled'
           AND k.late_cancel_fee_cents IS NOT NULL
           AND b.cancelled_at > ${now.toISOString()}::timestamptz - interval '7 days'
           AND ${writable(today)}
      ) q
     WHERE NOT EXISTS (SELECT 1 FROM club_charges ch WHERE ch.booking_id = q.booking_id)
     LIMIT ${limit}
  `);
  let charged = 0;
  for (const row of due.rows) {
    const locale = row.locale === 'en' ? 'en' : 'bg';
    const labels = labelsFor(locale);
    const word = row.kind === 'no_show' ? labels.noShow : labels.lateCancel;
    const label = `${word} — ${String(row.title)}`.slice(0, 120);
    const created = await db.transaction(async (tx) => {
      const inserted = await tx.execute(sql`
        INSERT INTO club_charges (club_id, member_id, kind, label, amount_cents, issued_on, due_on,
                                  booking_id)
        VALUES (${String(row.club_id)}::uuid, ${String(row.member_id)}::uuid, 'fee', ${label},
                ${Number(row.fee_cents)}, ${today}::date, ${today}::date + 7,
                ${String(row.booking_id)}::uuid)
        ON CONFLICT DO NOTHING
        RETURNING id
      `);
      const chargeId = text(inserted.rows[0]?.id);
      if (!chargeId) return false;
      await tx.execute(sql`
        INSERT INTO club_audit (club_id, actor_kind, actor_id, action, subject_member_id, detail)
        VALUES (${String(row.club_id)}::uuid, 'system', NULL, 'fee_charged',
                ${String(row.member_id)}::uuid,
                jsonb_build_object('chargeId', ${chargeId}::text, 'kind', ${String(row.kind)}::text,
                                   'amountCents', ${Number(row.fee_cents)}::int))
      `);
      return true;
    });
    if (created) charged += 1;
  }
  return charged;
}

// ─── Mail sweeps ───────────────────────────────────────────────────────────

export interface RenewalMailCandidate {
  clubId: string;
  memberId: string;
  membershipId: string;
  planName: string;
  startsOn: IsoDate;
  endsOn: IsoDate;
  priceCents: number;
}

/** Renewals of the last three days that nobody was told about yet. */
export async function renewalMailCandidates(db: SqlRunner): Promise<RenewalMailCandidate[]> {
  const result = await db.execute(sql`
    SELECT ms.club_id, ms.member_id, ms.id, ms.plan_name, ms.price_cents,
           to_char(ms.starts_on, 'YYYY-MM-DD') AS starts_on,
           to_char(ms.ends_on, 'YYYY-MM-DD') AS ends_on
      FROM club_memberships ms
      JOIN clubs c ON c.id = ms.club_id AND c.status = 'active'
     WHERE ms.renewal_of IS NOT NULL AND ms.cancelled_at IS NULL
       AND ms.created_at > now() - interval '3 days'
       AND NOT EXISTS (SELECT 1 FROM club_notifications n
                        WHERE n.club_id = ms.club_id
                          AND n.dedupe_key = 'membership_renewed:' || ms.id::text)
     LIMIT 1000
  `);
  return result.rows.map((row) => ({
    clubId: String(row.club_id),
    memberId: String(row.member_id),
    membershipId: String(row.id),
    planName: String(row.plan_name),
    startsOn: String(row.starts_on),
    endsOn: String(row.ends_on),
    priceCents: Number(row.price_cents),
  }));
}

export interface FeeMailCandidate {
  clubId: string;
  memberId: string;
  chargeId: string;
  label: string;
  amountCents: number;
  dueOn: IsoDate;
}

/** Fees of the last three days, still owed, that nobody was told about yet. */
export async function feeMailCandidates(db: SqlRunner): Promise<FeeMailCandidate[]> {
  const result = await db.execute(sql`
    SELECT ch.club_id, ch.member_id, ch.id, ch.label, ch.amount_cents,
           to_char(ch.due_on, 'YYYY-MM-DD') AS due_on
      FROM club_charges ch
      JOIN clubs c ON c.id = ch.club_id AND c.status = 'active'
     WHERE ch.booking_id IS NOT NULL AND ch.voided_at IS NULL AND ch.member_id IS NOT NULL
       AND ch.created_at > now() - interval '3 days'
       AND NOT EXISTS (SELECT 1 FROM club_notifications n
                        WHERE n.club_id = ch.club_id
                          AND n.dedupe_key = 'fee_charged:' || ch.id::text)
     LIMIT 1000
  `);
  return result.rows.map((row) => ({
    clubId: String(row.club_id),
    memberId: String(row.member_id),
    chargeId: String(row.id),
    label: String(row.label),
    amountCents: Number(row.amount_cents),
    dueOn: String(row.due_on),
  }));
}
