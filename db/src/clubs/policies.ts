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
  /** Memberships whose renewal threw; retried tomorrow, logged by count. */
  failed: number;
}

/**
 * After a gap (the club was suspended, or the job was down) a chain restarts
 * from today rather than back-filling one period per missed day.
 */
export const RENEWAL_CATCH_UP_DAYS = 7;

/**
 * Append the next period to every renewing membership whose period ENDED
 * (before today — so a notice given on the last day still stops the next
 * period; the 05:40 run on the first day puts it in place before the desk
 * opens) or whose visit card is used up. Price and name come from the plan AS
 * IT IS NOW — a price change applies from the next period, which is how a
 * club announces one; the contract TERMS travel with the chain (0047), so a
 * club cannot tighten notice or minimum term under a member. A chain stops
 * (renews = false) when the member's notice has run out, when the plan was
 * archived, when the club cancelled the membership, or when the member was
 * archived. One transaction per membership, each isolated: one bad row never
 * stops the others.
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
       -- A Stripe subscription renews itself; invoice.paid appends its periods.
       AND ms.provider_subscription_ref IS NULL
       AND (mb.effective_ends_on < ${today}::date OR mb.state = 'exhausted')
       AND NOT EXISTS (SELECT 1 FROM club_memberships nx WHERE nx.renewal_of = ms.id)
       AND ${writable(today)}
     ORDER BY mb.effective_ends_on
     LIMIT ${limit}
  `);
  const report: RenewalReport = { renewed: 0, ended: 0, failed: 0 };
  for (const row of due.rows) {
    const membershipId = String(row.membership_id);
    const effectiveEnds = String(row.effective_ends_on);
    // A used-up visit card renews from today; a period renews from the day
    // after it ended, so the contract has no gap — unless the chain lapsed
    // longer than the catch-up window, when it restarts today.
    const dayAfter = addDaysIso(effectiveEnds, 1);
    const nextStart =
      (row.state === 'exhausted' && effectiveEnds >= today) ||
      dayAfter < addDaysIso(today, -RENEWAL_CATCH_UP_DAYS)
        ? today
        : dayAfter;
    const outcome = await db
      .transaction(async (tx) => {
        const found = await tx.execute(sql`
        SELECT ms.club_id, ms.member_id, ms.renewal_ends_on, ms.term_started_on, ms.starts_on,
               ms.notice_days, ms.min_term_months, ms.self_pause_allowed, ms.self_cancel_allowed,
               p.id AS plan_id, p.name_bg, p.kind, p.audience, p.price_cents, p.validity_days,
               p.validity_months, p.visits_count, p.archived_at,
               (mem.archived_at IS NOT NULL) AS member_archived
          FROM club_memberships ms
          JOIN club_plans p ON p.club_id = ms.club_id AND p.id = ms.plan_id
          JOIN club_members mem ON mem.club_id = ms.club_id AND mem.id = ms.member_id
         WHERE ms.id = ${membershipId}::uuid AND ms.renews AND ms.cancelled_at IS NULL
           FOR NO KEY UPDATE OF ms
      `);
        const m = found.rows[0];
        if (!m) return 'skip' as const;
        const renewalEndsOn = text(m.renewal_ends_on);
        const contractOver = !renewsInto(nextStart, renewalEndsOn);
        if (
          contractOver ||
          m.archived_at !== null ||
          m.kind === 'trial' ||
          m.member_archived === true
        ) {
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
                                      renewal_of, term_started_on, renewal_ends_on, notice_days,
                                      min_term_months, self_pause_allowed, self_cancel_allowed)
        VALUES (${String(m.club_id)}::uuid, ${String(m.member_id)}::uuid, ${String(m.plan_id)}::uuid,
                ${String(m.name_bg)}, ${String(m.kind)}, ${String(m.audience)}, ${priceCents},
                ${m.visits_count === null ? null : Number(m.visits_count)},
                ${nextStart}::date, ${endsOn}::date, true, ${membershipId}::uuid,
                coalesce(${text(m.term_started_on)}::date, ${String(m.starts_on)}::date),
                ${renewalEndsOn}::date, ${Number(m.notice_days)},
                ${m.min_term_months === null ? null : Number(m.min_term_months)},
                ${m.self_pause_allowed === true}, ${m.self_cancel_allowed === true})
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
      })
      .catch(() => 'failed' as const);
    if (outcome === 'renewed') report.renewed += 1;
    if (outcome === 'ended') report.ended += 1;
    if (outcome === 'failed') report.failed += 1;
  }
  return report;
}

// ─── No-show and late-cancel fees ──────────────────────────────────────────
//
// ONE definition of what a member owes for (0047, after the wave A review),
// used by the nightly fee job AND by the strike count that stops
// self-booking (apps/web/lib/clubs/bookings.ts), so the two cannot disagree:
//
//   no-show      an active booking that HELD A PLACE (fewer active bookings
//                ahead of it than places — cancellation is refused once a
//                class starts, so this is the place it held at the start),
//                at a scheduled occurrence that ended over an hour ago (the
//                desk's grace to tick a late arrival), with no check-in;
//   late cancel  the MEMBER's own cancellation, after the free-cancel
//                deadline, of a booking that held a place — never a
//                waitlisted withdrawal, never the desk undoing a booking.
// The amounts and whether strikes count are the booking's SNAPSHOT of the
// class's policy when it was booked (0047), so a rule switched on today
// charges nothing for last week. Trials snapshot neither.

/** The booking `alias` held a place in its occurrence (aliases fixed by the caller). */
function heldPlace(b: string, o: string, k: string): SQL {
  const B = sql.raw(b);
  const O = sql.raw(o);
  const K = sql.raw(k);
  return sql`(coalesce(${O}.capacity, ${K}.capacity) IS NULL
    OR (SELECT count(*) FROM club_bookings ahead
         WHERE ahead.occurrence_id = ${B}.occurrence_id AND ahead.state = 'active'
           AND (ahead.seq, ahead.id) < (${B}.seq, ${B}.id)) < coalesce(${O}.capacity, ${K}.capacity))`;
}

/**
 * A member's strikes inside `days` (an SQL expression — the class's
 * strike_days), as one integer subquery. Its own aliases (sb, socc, skls)
 * cannot shadow the caller's.
 */
export function clubStrikesSql(clubId: SQL, memberId: SQL, days: SQL): SQL {
  return sql`(SELECT count(*)::int FROM club_bookings sb
      JOIN club_class_occurrences socc ON socc.id = sb.occurrence_id
      JOIN club_classes skls ON skls.id = socc.class_id
     WHERE sb.club_id = ${clubId} AND sb.member_id = ${memberId} AND sb.counts_strikes
       AND socc.status = 'scheduled'
       AND ((sb.state = 'active'
             AND socc.ends_at < now() - interval '1 hour'
             AND socc.ends_at > now() - make_interval(days => ${days})
             AND NOT EXISTS (SELECT 1 FROM club_checkins ci
                              WHERE ci.occurrence_id = sb.occurrence_id AND ci.member_id = sb.member_id)
             AND ${heldPlace('sb', 'socc', 'skls')})
         OR (sb.state = 'late_cancelled' AND sb.cancel_kind = 'member' AND sb.was_going
             AND sb.cancelled_at > now() - make_interval(days => ${days}))))`;
}

export interface FeeLabels {
  noShow: string;
  lateCancel: string;
}

/**
 * Raise a fee for each booking that earned one in the last seven days (the
 * definitions above). The label is `<word> — <class title>` in the club's
 * language, ≤ 120 characters (club_charges_label_sane).
 */
export async function chargeClubBookingFees(
  db: TransactionalDb,
  now: Date,
  labelsFor: (locale: 'bg' | 'en') => FeeLabels,
  limit = 1000,
): Promise<number> {
  const today = sofiaToday(now);
  const at = now.toISOString();
  const due = await db.execute(sql`
    SELECT q.booking_id, q.club_id, q.member_id, q.fee_cents, q.kind, q.title, q.locale
      FROM (
        SELECT b.id AS booking_id, b.club_id, b.member_id, b.no_show_fee_cents AS fee_cents,
               'no_show' AS kind, k.title, c.locale
          FROM club_bookings b
          JOIN club_class_occurrences o ON o.id = b.occurrence_id
          JOIN club_classes k ON k.id = o.class_id
          JOIN clubs c ON c.id = b.club_id
         WHERE b.state = 'active' AND b.no_show_fee_cents IS NOT NULL AND o.status = 'scheduled'
           AND o.ends_at < ${at}::timestamptz - interval '1 hour'
           AND o.ends_at > ${at}::timestamptz - interval '7 days'
           AND NOT EXISTS (SELECT 1 FROM club_checkins ci
                            WHERE ci.occurrence_id = b.occurrence_id AND ci.member_id = b.member_id)
           AND ${heldPlace('b', 'o', 'k')}
           AND ${writable(today)}
        UNION ALL
        SELECT b.id, b.club_id, b.member_id, b.late_cancel_fee_cents, 'late_cancel', k.title,
               c.locale
          FROM club_bookings b
          JOIN club_class_occurrences o ON o.id = b.occurrence_id
          JOIN club_classes k ON k.id = o.class_id
          JOIN clubs c ON c.id = b.club_id
         WHERE b.state = 'late_cancelled' AND b.cancel_kind = 'member' AND b.was_going
           AND b.late_cancel_fee_cents IS NOT NULL AND o.status = 'scheduled'
           AND b.cancelled_at > ${at}::timestamptz - interval '7 days'
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
    const created = await db
      .transaction(async (tx) => {
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
      })
      .catch(() => false);
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

/** Renewals of the last two weeks that nobody was told about yet (a mail outage heals). */
export async function renewalMailCandidates(db: SqlRunner): Promise<RenewalMailCandidate[]> {
  const result = await db.execute(sql`
    SELECT ms.club_id, ms.member_id, ms.id, ms.plan_name, ms.price_cents,
           to_char(ms.starts_on, 'YYYY-MM-DD') AS starts_on,
           to_char(ms.ends_on, 'YYYY-MM-DD') AS ends_on
      FROM club_memberships ms
      JOIN clubs c ON c.id = ms.club_id AND c.status = 'active'
     WHERE ms.renewal_of IS NOT NULL AND ms.cancelled_at IS NULL
       AND ms.created_at > now() - interval '14 days'
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

/** Fees of the last two weeks, still owed, that nobody was told about yet. */
export async function feeMailCandidates(db: SqlRunner): Promise<FeeMailCandidate[]> {
  const result = await db.execute(sql`
    SELECT ch.club_id, ch.member_id, ch.id, ch.label, ch.amount_cents,
           to_char(ch.due_on, 'YYYY-MM-DD') AS due_on
      FROM club_charges ch
      JOIN clubs c ON c.id = ch.club_id AND c.status = 'active'
     WHERE ch.booking_id IS NOT NULL AND ch.voided_at IS NULL AND ch.member_id IS NOT NULL
       AND ch.created_at > now() - interval '14 days'
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
