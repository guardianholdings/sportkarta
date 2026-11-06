import {
  MAIL_BUDGET_KINDS,
  MailBudgetExhaustedError,
  mailBudgetWarnAt,
  type MailBudgetKind,
  type MailBudgetLimits,
  type Mailer,
  type MailMessage,
} from '@sportkarta/lib/email';
import { sql, type SQL } from 'drizzle-orm';

/**
 * The daily mail budget's COUNTER (migration 0063). The shares, the
 * environment and the error live in lib/src/email/budget.ts; this file is
 * the one place a slot is taken, given back or read.
 *
 * ONE STATEMENT DECIDES. `takeMailBudget` is
 *
 *   INSERT … ON CONFLICT (sofia_day, kind) DO UPDATE
 *     SET sent = sent + 1 WHERE sent < limit RETURNING sent
 *
 * so the check and the increment are the same row-locked write: of two
 * senders racing for the last slot, the second waits on the first's lock
 * and re-evaluates the WHERE against the row the first committed — it gets
 * the slot only if the first rolled back (mail-budget.test.ts). A refusal
 * returns no row; it is then counted in `refused` by a plain increment
 * nothing races on.
 *
 * THE DAY IS THE DATABASE'S: `(now() AT TIME ZONE 'Europe/Sofia')::date`,
 * so the web process and the worker, whatever their own TZ, count into the
 * same row and reset at the same midnight.
 *
 * OUTSIDE THE CALLER'S TRANSACTION, on purpose. `budgetedMailer` takes its
 * slot in its own statement before it hands the message to the relay and
 * gives it back if the relay refuses — so a slot counts even when the
 * caller's commit later fails (conservative: over-counting by one can only
 * send less), and a relay outage cannot burn a share on sends that never
 * left. The caller's claim-then-send transaction still rolls back on the
 * hold, which is what keeps the recipient "not yet told".
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

/** The civil Sofia day, on the DATABASE clock, so every process agrees. */
const SOFIA_TODAY = sql`(now() AT TIME ZONE 'Europe/Sofia')::date`;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function dayExpr(day: string | undefined): SQL {
  if (day === undefined) return SOFIA_TODAY;
  if (!ISO_DAY.test(day)) throw new Error('a mail budget day is YYYY-MM-DD');
  return sql`${day}::date`;
}

export interface MailBudgetSlot {
  kind: MailBudgetKind;
  /** The Sofia day the slot came from, YYYY-MM-DD: a release finds the same row across midnight. */
  day: string;
  /** This kind's count after the take. */
  sent: number;
  limit: number;
}

export type MailBudgetOutcome =
  | { granted: true; slot: MailBudgetSlot }
  | { granted: false; kind: MailBudgetKind; day: string; sent: number; limit: number };

export interface MailBudgetOptions {
  /** A fixed Sofia day (tests); the database clock otherwise. */
  day?: string;
  /** Where the structured one-liners go; stderr by default. */
  warn?: (line: string) => void;
}

/** The last day each kind was reported spent, so that line is written once a day per process. */
const spentReported = new Map<MailBudgetKind, string>();

/**
 * Take one slot of `kind` from today's share, or learn that it is spent.
 * Writes ONE warning line when the kind's count reaches 80 % of its share
 * (the one take that lands on that number) and one when it is first
 * refused — kind, counts and the day; never a message or an address.
 */
export async function takeMailBudget(
  db: SqlRunner,
  kind: MailBudgetKind,
  limits: MailBudgetLimits,
  options: MailBudgetOptions = {},
): Promise<MailBudgetOutcome> {
  const warn = options.warn ?? ((line: string) => console.warn(line));
  const limit = limits[kind];
  const day = dayExpr(options.day);
  if (limit >= 1) {
    const granted = await db.execute(sql`
      INSERT INTO mail_budget (sofia_day, kind, sent) VALUES (${day}, ${kind}, 1)
      ON CONFLICT (sofia_day, kind) DO UPDATE SET sent = mail_budget.sent + 1
        WHERE mail_budget.sent < ${limit}
      RETURNING sofia_day::text AS day, sent
    `);
    const row = granted.rows[0];
    if (row) {
      const slot: MailBudgetSlot = { kind, day: String(row.day), sent: Number(row.sent), limit };
      if (slot.sent === mailBudgetWarnAt(limit)) {
        warn(
          `[mail] budget_warning kind=${kind} sent=${String(slot.sent)} limit=${String(limit)} day=${slot.day}`,
        );
      }
      return { granted: true, slot };
    }
  }
  const refused = await db.execute(sql`
    INSERT INTO mail_budget (sofia_day, kind, refused) VALUES (${day}, ${kind}, 1)
    ON CONFLICT (sofia_day, kind) DO UPDATE SET refused = mail_budget.refused + 1
    RETURNING sofia_day::text AS day, sent
  `);
  const row = refused.rows[0];
  const outcome = {
    granted: false as const,
    kind,
    day: String(row?.day ?? ''),
    sent: Number(row?.sent ?? 0),
    limit,
  };
  if (spentReported.get(kind) !== outcome.day) {
    spentReported.set(kind, outcome.day);
    warn(`[mail] budget_spent kind=${kind} limit=${String(limit)} day=${outcome.day}`);
  }
  return outcome;
}

/** Give a slot back: the message never left (the relay refused it, or nothing was sent). */
export async function releaseMailBudget(db: SqlRunner, slot: MailBudgetSlot): Promise<void> {
  await db.execute(sql`
    UPDATE mail_budget SET sent = mail_budget.sent - 1
     WHERE sofia_day = ${slot.day}::date AND kind = ${slot.kind} AND mail_budget.sent > 0
  `);
}

export interface MailBudgetKindToday {
  kind: MailBudgetKind;
  sent: number;
  refused: number;
  limit: number;
}

export interface MailBudgetToday {
  /** The Sofia day the counts are for, YYYY-MM-DD. */
  day: string;
  quota: number;
  kinds: MailBudgetKindToday[];
}

/** Today's counts beside their limits, every kind present — for «Здраве» (/admin/zdrave). */
export async function mailBudgetToday(
  db: SqlRunner,
  limits: MailBudgetLimits,
  day?: string,
): Promise<MailBudgetToday> {
  const result = await db.execute(sql`
    SELECT t.d::text AS day, b.kind, b.sent, b.refused
      FROM (SELECT ${dayExpr(day)} AS d) t
      LEFT JOIN mail_budget b ON b.sofia_day = t.d
  `);
  const byKind = new Map(result.rows.map((row) => [String(row.kind), row]));
  return {
    day: String(result.rows[0]?.day ?? ''),
    quota: limits.quota,
    kinds: MAIL_BUDGET_KINDS.map((kind) => ({
      kind,
      sent: Number(byKind.get(kind)?.sent ?? 0),
      refused: Number(byKind.get(kind)?.refused ?? 0),
      limit: limits[kind],
    })),
  };
}

/** Days of counters kept; the worker's nightly auth.cleanup prunes the rest. */
export const MAIL_BUDGET_RETENTION_DAYS = 90;

/** Forget the counters older than the retention. Returns how many rows went. */
export async function pruneMailBudget(
  db: SqlRunner,
  keepDays: number = MAIL_BUDGET_RETENTION_DAYS,
): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM mail_budget WHERE sofia_day < ${SOFIA_TODAY} - ${Math.trunc(keepDays)}::int
    RETURNING kind
  `);
  return result.rows.length;
}

export interface BudgetedMailerOptions {
  /** The shared pool (getDb()), NOT a transaction: the take must commit on its own. */
  db: SqlRunner;
  kind: MailBudgetKind;
  limits: MailBudgetLimits;
  warn?: (line: string) => void;
}

/**
 * A mailer that spends a slot of `kind` on every message, and throws
 * MailBudgetExhaustedError INSTEAD of sending once the day's share is spent.
 * The worker wraps the relay mailer once per kind (apps/worker/src/index.ts):
 * every job then keeps its claim-then-send transaction exactly as it was, and
 * the throw rolls the claim back — the hold deliverEach counts.
 */
export function budgetedMailer(inner: Mailer, options: BudgetedMailerOptions): Mailer {
  const send = async (message: MailMessage): Promise<void> => {
    const outcome = await takeMailBudget(options.db, options.kind, options.limits, {
      warn: options.warn,
    });
    if (!outcome.granted) {
      throw new MailBudgetExhaustedError(outcome.kind, outcome.limit, outcome.day);
    }
    try {
      await inner.send(message);
    } catch (error: unknown) {
      // Nothing left the building: give the slot back. A failure to do so
      // leaves the slot taken (conservative) and must not hide the relay's error.
      try {
        await releaseMailBudget(options.db, outcome.slot);
      } catch {
        // see above
      }
      throw error;
    }
  };
  const close = inner.close?.bind(inner);
  return close ? { send, close } : { send };
}
