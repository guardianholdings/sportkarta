/**
 * Mail abstraction (docs/ROADMAP.md §0: "SMTP via env, provider-agnostic").
 * Same shape as the storage adapter: one interface, swappable transports, so
 * call sites never know which relay is behind them. Stage 3 sends sign-in
 * OTPs through it; Stage 4 reuses it for session reminders and digests.
 */

export interface MailMessage {
  to: string;
  subject: string;
  /** Plain-text body. Always required — OTP mail must survive HTML-off clients. */
  text: string;
  html?: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/**
 * Thrown when no usable transport is configured. Callers surface a "try again
 * later" message; they must NEVER fall back to logging the message body — OTP
 * codes are credentials (CLAUDE.md: no PII/secrets in logs).
 */
export class MailNotConfiguredError extends Error {
  constructor(reason: string) {
    super(`Email is not configured: ${reason}`);
    this.name = 'MailNotConfiguredError';
  }
}

export type MailTransportKind = 'smtp' | 'file' | 'console' | 'memory' | 'disabled';

export interface MailEnv {
  MAIL_TRANSPORT?: string | undefined;
  MAIL_OUTBOX_DIR?: string | undefined;
  SMTP_HOST?: string | undefined;
  SMTP_PORT?: string | undefined;
  SMTP_USER?: string | undefined;
  SMTP_PASS?: string | undefined;
  SMTP_FROM?: string | undefined;
  NODE_ENV?: string | undefined;
}

export interface MailTransportChoice {
  kind: MailTransportKind;
  /** Why the transport is disabled — surfaced in server logs, never to users. */
  reason?: string;
}

/**
 * Pure transport selection, so the fail-closed rules are unit-testable without
 * touching the filesystem or a relay.
 *
 * Production never gets `file`/`console`: writing a one-time code to a log or a
 * world-readable file is a credential leak, so a misconfigured production
 * deployment sends nothing at all rather than sending it somewhere unsafe.
 */
export function resolveMailTransport(env: MailEnv): MailTransportChoice {
  const isProduction = env.NODE_ENV === 'production';
  const requested = env.MAIL_TRANSPORT?.trim().toLowerCase();

  if (requested) {
    if (requested === 'memory' || requested === 'file' || requested === 'console') {
      // None of the three reaches a real inbox. In production that is a silent
      // black hole for sign-in codes at best (memory even retains them, with
      // the recipient, for the life of the process), so they are refused.
      if (isProduction) {
        return {
          kind: 'disabled',
          reason: `MAIL_TRANSPORT=${requested} is refused in production (one-time codes would leak or vanish)`,
        };
      }
      return { kind: requested };
    }
    if (requested !== 'smtp') {
      return { kind: 'disabled', reason: `unknown MAIL_TRANSPORT "${requested}"` };
    }
    return smtpOrDisabled(env);
  }

  if (env.SMTP_HOST?.trim()) return smtpOrDisabled(env);
  if (isProduction) return { kind: 'disabled', reason: 'SMTP_HOST is unset' };
  // Local dev default: a readable outbox beats a silent black hole.
  return { kind: 'file' };
}

function smtpOrDisabled(env: MailEnv): MailTransportChoice {
  if (!env.SMTP_HOST?.trim()) return { kind: 'disabled', reason: 'SMTP_HOST is unset' };
  if (!env.SMTP_FROM?.trim()) return { kind: 'disabled', reason: 'SMTP_FROM is unset' };
  const port = env.SMTP_PORT?.trim();
  if (port && !/^\d+$/.test(port)) return { kind: 'disabled', reason: 'SMTP_PORT is not a number' };
  return { kind: 'smtp' };
}

/** Always throws on send. Used when nothing safe is configured. */
export class DisabledMailer implements Mailer {
  constructor(private readonly reason: string) {}

  send(): Promise<void> {
    return Promise.reject(new MailNotConfiguredError(this.reason));
  }
}

/** In-memory transport for unit tests. */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];

  send(message: MailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}
