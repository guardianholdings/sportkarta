/**
 * The per-recipient send loop every worker mail job shares (Stage 4.2 session
 * mail, Stage 4.4 digest), and the three rules it exists to hold in one place.
 *
 *  1. ONE RECIPIENT'S FAILURE DOES NOT ABANDON THE REST. A bounced address is a
 *     fact about that address; everyone after it is still owed their mail.
 *
 *  2. A DOWN TRANSPORT STOPS THE RUN AT ONCE. When the relay refuses to log us
 *     in (EAUTH), is throttling logins (454 4.7.0) or has hit the account's
 *     daily quota (550 5.4.5), every later send fails identically — and each
 *     attempt is another login against an account that is already refusing us,
 *     which is how a quota problem becomes a suspended account. So the loop
 *     stops, says so on one structured line, and leaves the rest unclaimed for
 *     the retry.
 *
 *  3. NO ADDRESS IN ANY LOG LINE. An SMTP rejection reads "550 5.1.1
 *     <ivan@example.org>: Recipient address rejected", so `error.message` is
 *     never logged — only a category built from the error's code and the reply's
 *     numeric status, both of which are digits and letters by construction.
 *
 * Retrying is the CALLER'S job and the ledger's: each job claims before it
 * sends, in one transaction, so a failed send rolls its claim back and a re-run
 * mails exactly the people who were not reached. `assertDelivered` turns a
 * report with failures into a throw so pg-boss schedules that re-run.
 */

import { MailNotConfiguredError } from './mailer.js';

const SAFE_TOKEN = /^[A-Za-z0-9_]{1,32}$/;
/** `550 5.4.5 …` / `454-4.7.0 …` — the reply code and the enhanced status. */
const SMTP_STATUS = /^(\d{3})[ -](\d\.\d{1,3}\.\d{1,3})\b/;

interface ErrorFields {
  code?: unknown;
  responseCode?: unknown;
  response?: unknown;
  name?: unknown;
}

function fields(error: unknown): ErrorFields {
  return error && typeof error === 'object' ? (error as ErrorFields) : {};
}

function smtpStatus(error: unknown): { reply: number | null; enhanced: string | null } {
  const { responseCode, response } = fields(error);
  const match = typeof response === 'string' ? SMTP_STATUS.exec(response.trim()) : null;
  const reply =
    typeof responseCode === 'number' && Number.isInteger(responseCode)
      ? responseCode
      : match
        ? Number(match[1])
        : null;
  return { reply, enhanced: match ? (match[2] ?? null) : null };
}

/**
 * A coarse, address-free classification: the error code (nodemailer's EAUTH,
 * EENVELOPE…, or a Postgres SQLSTATE), plus the SMTP reply and enhanced status
 * when the relay sent one — `EENVELOPE 550 5.4.5`. Nothing here is copied from
 * free text: the status is re-built from a digits-only match.
 */
export function mailFailureCategory(error: unknown): string {
  if (error instanceof MailNotConfiguredError) return 'mail_not_configured';
  const { code } = fields(error);
  const base = typeof code === 'string' && SAFE_TOKEN.test(code) ? code : 'send_failed';
  const { reply, enhanced } = smtpStatus(error);
  return [base, reply === null ? null : String(reply), enhanced].filter(Boolean).join(' ');
}

/** nodemailer codes that mean "no send will succeed until something changes". */
const TRANSPORT_DOWN_CODES = new Set([
  'EAUTH',
  'ENOAUTH',
  'EOAUTH2',
  // The relay is unreachable. Every later recipient would wait out the same
  // connection timeout (two minutes each by default), and a 500-recipient run
  // would outlive the job's own expiry before failing anyway.
  'ECONNECTION',
  'ETIMEDOUT',
  'EDNS',
  'ETLS',
  'ESOCKET',
]);

/** Enhanced statuses that are about the SENDER, not about one recipient. */
const TRANSPORT_DOWN_STATUSES = new Set([
  // Gmail: "Too many login attempts" / temporary auth refusal.
  '4.7.0',
  // Gmail: "Daily user sending limit exceeded".
  '5.4.5',
]);

/**
 * True when the failure is the transport's, not the recipient's — so the run
 * must stop rather than try everybody else against the same wall.
 */
export function isMailTransportDown(error: unknown): boolean {
  if (error instanceof MailNotConfiguredError) return true;
  const { code } = fields(error);
  if (typeof code === 'string' && TRANSPORT_DOWN_CODES.has(code)) return true;
  const { reply, enhanced } = smtpStatus(error);
  // 421: the server is closing the channel on us — throttling, not an address.
  if (reply === 421) return true;
  return enhanced !== null && TRANSPORT_DOWN_STATUSES.has(enhanced);
}

export type DeliveryOutcome = 'sent' | 'skipped';

export interface DeliveryReport {
  candidates: number;
  sent: number;
  /** Already told (the ledger refused the claim), or nothing to say. */
  skipped: number;
  failed: number;
  /** Never attempted, because the transport went down first. */
  unattempted: number;
  /** The run stopped early on a transport-level failure. */
  transportDown: boolean;
}

export function emptyDeliveryReport(candidates = 0): DeliveryReport {
  return { candidates, sent: 0, skipped: 0, failed: 0, unattempted: 0, transportDown: false };
}

export interface DeliverOptions {
  /** The job name as it appears in the logs, e.g. `session.notify`. */
  job: string;
  /** Injected for tests; the worker logs to stderr. */
  logError?: (line: string) => void;
}

/**
 * Send to each item in order; count, categorise, and stop on a down transport.
 * `send` claims, renders and hands off one message, returning whether it went
 * or was skipped; a throw is a failure.
 */
export async function deliverEach<T>(
  items: readonly T[],
  send: (item: T) => Promise<DeliveryOutcome>,
  options: DeliverOptions,
): Promise<DeliveryReport> {
  const logError = options.logError ?? ((line: string) => console.error(line));
  const report = emptyDeliveryReport(items.length);

  for (const [index, item] of items.entries()) {
    try {
      if ((await send(item)) === 'sent') report.sent += 1;
      else report.skipped += 1;
    } catch (error: unknown) {
      report.failed += 1;
      const category = mailFailureCategory(error);
      logError(`[worker] ${options.job} recipient failed: ${category}`);
      if (isMailTransportDown(error)) {
        report.transportDown = true;
        report.unattempted = items.length - index - 1;
        // One structured line an operator (or a log alert) can key on. Counts
        // and the category only — never an address.
        logError(
          `[mail] transport_down job=${options.job} category="${category}" ` +
            `sent=${String(report.sent)} unattempted=${String(report.unattempted)}`,
        );
        break;
      }
    }
  }
  return report;
}

/** Thrown to make pg-boss retry a run that left somebody unreached. */
export class MailRunIncompleteError extends Error {
  constructor(job: string, report: DeliveryReport) {
    super(
      `${job}: ${String(report.failed)} failed, ${String(report.unattempted)} unattempted ` +
        `of ${String(report.candidates)}${report.transportDown ? ' (transport down)' : ''}`,
    );
    this.name = 'MailRunIncompleteError';
  }
}

/**
 * Throw when anybody was left unreached, so the queue retries the job. The
 * message is counts only — pg-boss stores it in the job row.
 */
export function assertDelivered(job: string, report: DeliveryReport): void {
  if (report.failed > 0 || report.unattempted > 0) {
    throw new MailRunIncompleteError(job, report);
  }
}
