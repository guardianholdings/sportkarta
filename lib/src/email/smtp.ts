import type { MailEnv, Mailer, MailMessage } from './mailer.js';

/**
 * Commodity SMTP relay, provider-agnostic. nodemailer is imported lazily so
 * neither the Next.js client bundle nor the middleware ever pulls it in — only
 * an actual send touches it.
 */
export class SmtpMailer implements Mailer {
  constructor(private readonly env: MailEnv) {}

  async send(message: MailMessage): Promise<void> {
    const { createTransport } = await import('nodemailer');
    const port = Number(this.env.SMTP_PORT ?? '587');
    const user = this.env.SMTP_USER?.trim();
    const pass = this.env.SMTP_PASS;

    const transport = createTransport({
      host: this.env.SMTP_HOST,
      port,
      // 465 is implicit TLS; 587/25 upgrade via STARTTLS. requireTLS makes that
      // upgrade mandatory — without it nodemailer falls back to plaintext when a
      // relay does not advertise STARTTLS, and a one-time code is a credential.
      secure: port === 465,
      requireTLS: port !== 465,
      ...(user ? { auth: { user, pass } } : {}),
    });

    await transport.sendMail({
      from: this.env.SMTP_FROM,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
    });
  }
}
