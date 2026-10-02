import { brandEmailHtml, MailNotConfiguredError, type Mailer } from '@sportkarta/lib/email';

import { OTP_TTL_SECONDS } from './auth-surface';

/**
 * Mailing a sign-in code, with the outcome REPORTED instead of swallowed.
 *
 * This used to be better-auth's `sendVerificationOTP` callback. better-auth
 * awaits that callback inside a try/catch that logs the error (recipient
 * included — nodemailer puts it on `err.rejected`) and then answers
 * `{ success: true }` regardless, so a relay outage, a revoked app password or
 * a spent daily quota all showed the member «Изпратихме код» for a code that
 * never left the building. Now the action mints the code through better-auth
 * (`createVerificationOTP`, server-only) and sends it here, where a failure
 * becomes an error the form can show.
 *
 * Pure: everything with a side effect is injected, so tests/sign-in-code.test.ts
 * runs it against a real translator and a failing mailer.
 */

export type SignInCodeOutcome = 'sent' | 'mail_unavailable' | 'unknown';

/** The two AuthEmail messages, from a translator already bound to the member's locale. */
export type AuthEmailTranslate = (
  key: 'otpSubject' | 'otpBody',
  values?: Record<string, string | number>,
) => string;

/**
 * Long enough for any healthy relay (Gmail answers in one to three seconds),
 * short enough that a stuck one cannot hold the sign-in form for nodemailer's
 * two-minute connection default.
 */
export const MAIL_SEND_TIMEOUT_MS = 15_000;

export class MailSendTimeoutError extends Error {
  constructor(ms: number) {
    super(`Mail transport did not answer within ${String(ms)} ms`);
    this.name = 'MailSendTimeoutError';
  }
}

export interface SignInCodeDelivery {
  email: string;
  /** Mint and store a fresh code; resolves to the plain code, which only this mail ever carries. */
  issueCode: () => Promise<string>;
  translate: AuthEmailTranslate;
  mailer: Mailer;
  /** Receives a log line plus, in production, only a redacted detail. */
  log: (line: string, detail?: unknown) => void;
  /** Development wants the whole error; production must not have it (it can name the address). */
  verboseErrors: boolean;
  timeoutMs?: number;
}

const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,31}$/;

/**
 * An error reduced to what is safe in a production log: its type, plus the
 * transport's error code and SMTP status when they look like codes. Never the
 * message — nodemailer's carries the relay's response, which quotes the
 * recipient.
 */
export function describeErrorForLog(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const { code, responseCode } = error as { code?: unknown; responseCode?: unknown };
  const parts = [error.name];
  if (typeof code === 'string' && ERROR_CODE.test(code)) parts.push(code);
  if (typeof responseCode === 'number' && Number.isInteger(responseCode)) {
    parts.push(String(responseCode));
  }
  return parts.join(' ');
}

/**
 * better-auth's own log arguments, reduced the same way. Its messages are fixed
 * strings; its arguments are raw errors and objects that can carry an address,
 * so in production only an error's type and code survive.
 */
export function redactLogArgs(args: readonly unknown[]): unknown[] {
  return args.map((arg) => {
    if (arg instanceof Error) return describeErrorForLog(arg);
    if (typeof arg === 'number' || typeof arg === 'boolean') return arg;
    return '[redacted]';
  });
}

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new MailSendTimeoutError(ms));
    }, ms);
  });
  // Promise.race subscribes to `promise`, so a late rejection is still handled.
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

export async function deliverSignInCode(delivery: SignInCodeDelivery): Promise<SignInCodeOutcome> {
  const detail = (error: unknown) => (delivery.verboseErrors ? error : describeErrorForLog(error));

  let code: string;
  try {
    code = await delivery.issueCode();
  } catch (error) {
    delivery.log('[auth] issuing a sign-in code failed:', detail(error));
    return 'unknown';
  }

  const text = delivery.translate('otpBody', { code, minutes: OTP_TTL_SECONDS / 60 });
  try {
    await withTimeout(
      delivery.mailer.send({
        to: delivery.email,
        subject: delivery.translate('otpSubject'),
        text,
        html: brandEmailHtml(text),
      }),
      delivery.timeoutMs ?? MAIL_SEND_TIMEOUT_MS,
    );
    return 'sent';
  } catch (error) {
    // Every failure to hand the mail over is the same thing to the member: no
    // code is coming, so try later. The log keeps the distinction.
    if (error instanceof MailNotConfiguredError) {
      delivery.log('[auth] sign-in code requested but no mail transport is configured');
    } else {
      delivery.log('[auth] sending a sign-in code failed:', detail(error));
    }
    return 'mail_unavailable';
  }
}
