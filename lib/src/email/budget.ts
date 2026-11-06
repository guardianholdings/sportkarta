/**
 * The daily mail budget (launch-readiness audit 2026-10-31, B-05) — the pure
 * half: the vocabulary, the arithmetic and the error. The counter itself is
 * db/src/mail-budget.ts.
 *
 * The relay allows a fixed number of sends per calendar day — Migadu Mini,
 * the production relay, 100 — shared by everything the site mails: sign-in
 * codes, session and club notices, club broadcasts. Spent by an address
 * flood or one big broadcast, it would stop everyone's sign-in until
 * midnight. So the day's quota is split into three SHARES, one per kind of
 * mail, and every sender takes a slot from its own share before it hands a
 * message to the relay. A kind cannot borrow from another: codes keep a
 * reserve no notice or broadcast can touch, and the bulk share is the most a
 * club's marketing can spend in a day.
 *
 *   MAIL_DAILY_QUOTA    the relay's daily allowance                  default 100
 *   MAIL_OTP_SHARE      per cent kept for sign-in codes               default 40
 *   MAIL_NOTICE_SHARE   per cent for notices (every other worker mail) default 40
 *   bulk                the rest; CLUB_BULK_MAIL_DAILY_LIMIT may lower it,
 *                       never raise it above its share
 *
 * Defaults: 40 codes, 40 notices, 20 bulk a day. The in-memory per-IP,
 * per-address and hourly limiters (apps/web/lib/auth-rate-limit.ts) stay in
 * front of the code share; this is the durable line behind them, and it is
 * the same line in the web process and in the worker.
 */

export const MAIL_BUDGET_KINDS = ['otp', 'notice', 'bulk'] as const;
export type MailBudgetKind = (typeof MAIL_BUDGET_KINDS)[number];

export function isMailBudgetKind(value: unknown): value is MailBudgetKind {
  return typeof value === 'string' && (MAIL_BUDGET_KINDS as readonly string[]).includes(value);
}

/** Migadu Mini: 100 outgoing messages a day. */
export const DEFAULT_MAIL_DAILY_QUOTA = 100;
export const DEFAULT_MAIL_OTP_SHARE = 40;
export const DEFAULT_MAIL_NOTICE_SHARE = 40;
/** The fraction of a share at which ONE warning line is written. */
export const MAIL_BUDGET_WARN_AT = 0.8;

export interface MailBudgetEnv {
  MAIL_DAILY_QUOTA?: string | undefined;
  MAIL_OTP_SHARE?: string | undefined;
  MAIL_NOTICE_SHARE?: string | undefined;
  CLUB_BULK_MAIL_DAILY_LIMIT?: string | undefined;
  /** Everything else: `process.env` is passed whole. */
  [key: string]: string | undefined;
}

/** The day's limits, in messages: `otp + notice + bulk <= quota`. */
export interface MailBudgetLimits {
  quota: number;
  otp: number;
  notice: number;
  bulk: number;
}

function integerFrom(raw: string | undefined, min: number, max: number): number | null {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d{1,7}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= min && value <= max ? value : null;
}

/**
 * The limits from the environment. Every unusable value falls back to its
 * DEFAULT, never to "no limit": a typo must not switch the budget off. The
 * shares are whole per cents and may not sum past 100 (then both revert to
 * their defaults); the bulk share is what they leave, lowered further by
 * CLUB_BULK_MAIL_DAILY_LIMIT when that is smaller — the club cap keeps
 * working, but it can no longer exceed its share.
 */
export function resolveMailBudget(env: MailBudgetEnv = process.env): MailBudgetLimits {
  const quota = integerFrom(env.MAIL_DAILY_QUOTA, 1, 1_000_000) ?? DEFAULT_MAIL_DAILY_QUOTA;
  let otpShare = integerFrom(env.MAIL_OTP_SHARE, 0, 100) ?? DEFAULT_MAIL_OTP_SHARE;
  let noticeShare = integerFrom(env.MAIL_NOTICE_SHARE, 0, 100) ?? DEFAULT_MAIL_NOTICE_SHARE;
  if (otpShare + noticeShare > 100) {
    otpShare = DEFAULT_MAIL_OTP_SHARE;
    noticeShare = DEFAULT_MAIL_NOTICE_SHARE;
  }
  const otp = Math.floor((quota * otpShare) / 100);
  const notice = Math.floor((quota * noticeShare) / 100);
  const rest = quota - otp - notice;
  const bulkCap = integerFrom(env.CLUB_BULK_MAIL_DAILY_LIMIT, 0, 1_000_000);
  const bulk = bulkCap === null ? rest : Math.min(rest, bulkCap);
  return { quota, otp, notice, bulk };
}

/** The count at which a kind's one warning line is written: 80 % of its share, rounded up. */
export function mailBudgetWarnAt(limit: number): number {
  return Math.ceil(limit * MAIL_BUDGET_WARN_AT);
}

/**
 * Thrown by a budgeted mailer (db/src/mail-budget.ts) INSTEAD of sending when
 * the day's share is spent. It carries the kind, the limit and the day and
 * never the message, so it is safe to log whole; `code` lets
 * mailFailureCategory classify it like a transport error.
 */
export class MailBudgetExhaustedError extends Error {
  readonly code = 'EMAILBUDGET';

  constructor(
    readonly kind: MailBudgetKind,
    readonly limit: number,
    readonly day: string,
  ) {
    super(`The day's mail budget for ${kind} is spent (${String(limit)} on ${day})`);
    this.name = 'MailBudgetExhaustedError';
  }
}

export function isMailBudgetExhausted(error: unknown): error is MailBudgetExhaustedError {
  return error instanceof MailBudgetExhaustedError;
}

const SOFIA_WALL = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Sofia',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function sofiaWall(instant: Date): Wall {
  const parts = new Map(SOFIA_WALL.formatToParts(instant).map((part) => [part.type, part.value]));
  const n = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.get(type) ?? '0');
  return {
    year: n('year'),
    month: n('month'),
    day: n('day'),
    hour: n('hour'),
    minute: n('minute'),
    second: n('second'),
  };
}

/**
 * The instant the next civil Sofia day begins — when every share resets, and
 * so when a notice the budget held is due to be tried again. Tomorrow's date
 * comes from UTC calendar arithmetic (no DST at UTC midnight); its Sofia
 * midnight is a UTC-midnight guess corrected by the offset Sofia has at that
 * moment. Midnight is never inside the clock-change hour (03:00), so one
 * correction is exact.
 */
export function nextMailBudgetDay(now: Date = new Date()): Date {
  const today = sofiaWall(now);
  const guess = Date.UTC(today.year, today.month - 1, today.day + 1);
  const wall = sofiaWall(new Date(guess));
  const wallAsUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  return new Date(guess - (wallAsUtc - guess));
}
