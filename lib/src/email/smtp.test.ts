import { beforeEach, describe, expect, it, vi } from 'vitest';

import { formatFrom, SmtpMailer } from './smtp.js';

/**
 * The SMTP transport's own decisions, with nodemailer stubbed: what the From
 * header says, that one pooled connection set is reused across sends, and that
 * extra headers pass through — but never with a line break in them.
 */

// vi.mock is hoisted above the imports, so its collaborators must be too.
const { sendMail, close, on, createTransport } = vi.hoisted(() => {
  const sendMail = vi.fn<(options: Record<string, unknown>) => Promise<void>>();
  const close = vi.fn();
  const on = vi.fn();
  const createTransport = vi.fn<(options: Record<string, unknown>) => unknown>(() => ({
    sendMail,
    close,
    on,
  }));
  return { sendMail, close, on, createTransport };
});

vi.mock('nodemailer', () => ({ createTransport }));

const ENV = {
  SMTP_HOST: 'smtp.example.org',
  SMTP_PORT: '587',
  SMTP_USER: 'relay@example.org',
  SMTP_PASS: 'secret',
  SMTP_FROM: 'no-reply@example.org',
};

beforeEach(() => {
  vi.clearAllMocks();
  sendMail.mockResolvedValue(undefined);
});

describe('formatFrom', () => {
  it('gives a bare address the POPS display name', () => {
    // Production's SMTP_FROM was a bare Gmail address, so every sign-in code
    // arrived from what looked like a stranger's personal inbox.
    expect(formatFrom('no-reply@example.org')).toBe('"POPS" <no-reply@example.org>');
    expect(formatFrom('  no-reply@example.org ')).toBe('"POPS" <no-reply@example.org>');
  });

  it('leaves an address that already names itself alone', () => {
    expect(formatFrom('Повече от спорт <no-reply@example.org>')).toBe(
      'Повече от спорт <no-reply@example.org>',
    );
  });
});

describe('SmtpMailer', () => {
  it('builds ONE pooled transport and reuses it for every message', async () => {
    const mailer = new SmtpMailer(ENV);
    await mailer.send({ to: 'a@example.org', subject: 's', text: 't' });
    await mailer.send({ to: 'b@example.org', subject: 's', text: 't' });

    // A fresh TCP + TLS + AUTH per recipient is the login pattern that trips a
    // consumer relay's "too many login attempts" halfway through a digest.
    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(createTransport.mock.calls[0]?.[0]).toMatchObject({
      pool: true,
      requireTLS: true,
      auth: { user: 'relay@example.org', pass: 'secret' },
    });
    expect(sendMail).toHaveBeenCalledTimes(2);
    // …and an 'error' listener is attached, so a pooled connection's error
    // cannot become an uncaught exception.
    expect(on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('sends from the formatted address, with the extra headers', async () => {
    const mailer = new SmtpMailer(ENV);
    const headers = { 'List-Unsubscribe': '<https://pops.bg/api/digest/unsubscribe/x>' };
    await mailer.send({ to: 'a@example.org', subject: 's', text: 't', headers });
    expect(sendMail.mock.calls[0]?.[0]).toMatchObject({
      from: '"POPS" <no-reply@example.org>',
      headers,
    });
  });

  it('refuses a header value with a line break (header injection)', async () => {
    const mailer = new SmtpMailer(ENV);
    await expect(
      mailer.send({
        to: 'a@example.org',
        subject: 's',
        text: 't',
        headers: { 'List-Unsubscribe': '<https://x>\r\nBcc: victim@example.org' },
      }),
    ).rejects.toThrow(/line break/);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('closes the pool on shutdown and rebuilds it if used again', async () => {
    const mailer = new SmtpMailer(ENV);
    await mailer.send({ to: 'a@example.org', subject: 's', text: 't' });
    await mailer.close();
    expect(close).toHaveBeenCalledTimes(1);
    await mailer.send({ to: 'a@example.org', subject: 's', text: 't' });
    expect(createTransport).toHaveBeenCalledTimes(2);
  });
});
