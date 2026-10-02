import type { Transporter } from 'nodemailer';

import type { MailEnv, Mailer, MailMessage } from './mailer.js';

/**
 * The display name a bare SMTP_FROM address is sent under. Production's
 * SMTP_FROM was a bare Gmail address, so sign-in codes arrived from what looked
 * like a stranger's personal inbox — the fastest route to being ignored or
 * reported as spam. An SMTP_FROM that already names itself is left alone.
 */
export const DEFAULT_FROM_NAME = 'POPS';

/**
 * `no-reply@example.org` → `"POPS" <no-reply@example.org>`; anything that
 * already carries a display name (`Name <addr>`) passes through unchanged.
 */
export function formatFrom(from: string): string {
  const trimmed = from.trim();
  if (trimmed.includes('<')) return trimmed;
  return `"${DEFAULT_FROM_NAME}" <${trimmed}>`;
}

/** Header injection guard: a header value is one line, always. */
function assertSingleLineHeaders(headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) {
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
      throw new Error('mail header contains a line break');
    }
  }
}

/**
 * Commodity SMTP relay, provider-agnostic. nodemailer is imported lazily so
 * neither the Next.js client bundle nor the middleware ever pulls it in — only
 * an actual send touches it.
 *
 * POOLED, and the pool is built once per mailer. It used to be one
 * createTransport per message — a fresh TCP + TLS + AUTH handshake to the relay
 * for every recipient, which on a consumer Gmail account is exactly the login
 * pattern that trips "too many login attempts" in the middle of a digest run.
 * The web app and the worker each hold one long-lived mailer, so each keeps one
 * small pool; `close()` releases it on shutdown.
 */
export class SmtpMailer implements Mailer {
  private transport: Promise<Transporter> | undefined;

  constructor(private readonly env: MailEnv) {}

  private getTransport(): Promise<Transporter> {
    this.transport ??= import('nodemailer').then(({ createTransport }) => {
      const port = Number(this.env.SMTP_PORT ?? '587');
      const user = this.env.SMTP_USER?.trim();
      const pass = this.env.SMTP_PASS;
      const transport = createTransport({
        pool: true,
        // The worker sends one message at a time; in the web app two
        // connections let concurrent sign-in codes go out without queueing
        // behind each other, and without looking like a burst of logins.
        maxConnections: 2,
        // Re-authenticate now and then rather than riding one session forever.
        maxMessages: 100,
        host: this.env.SMTP_HOST,
        port,
        // 465 is implicit TLS; 587/25 upgrade via STARTTLS. requireTLS makes that
        // upgrade mandatory — without it nodemailer falls back to plaintext when a
        // relay does not advertise STARTTLS, and a one-time code is a credential.
        secure: port === 465,
        requireTLS: port !== 465,
        ...(user ? { auth: { user, pass } } : {}),
      });
      // A pooled transport is an EventEmitter; an unhandled 'error' would take
      // the whole process down. The message is not logged: an SMTP error can
      // quote a recipient address.
      transport.on('error', (error: unknown) => {
        const code =
          error && typeof error === 'object' && 'code' in error
            ? String((error as { code: unknown }).code)
            : 'unknown';
        console.error(
          `[mail] smtp pool error: ${/^[A-Za-z0-9_]{1,32}$/.test(code) ? code : 'unknown'}`,
        );
      });
      return transport;
    });
    return this.transport;
  }

  async send(message: MailMessage): Promise<void> {
    if (message.headers) assertSingleLineHeaders(message.headers);
    const transport = await this.getTransport();
    await transport.sendMail({
      from: formatFrom(this.env.SMTP_FROM ?? ''),
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
      ...(message.headers ? { headers: message.headers } : {}),
    });
  }

  async close(): Promise<void> {
    const pending = this.transport;
    this.transport = undefined;
    if (pending) (await pending).close();
  }
}
