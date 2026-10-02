import { DisabledMailer, MemoryMailer, type Mailer } from '@sportkarta/lib/email';
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import {
  deliverSignInCode,
  describeErrorForLog,
  redactLogArgs,
  type AuthEmailTranslate,
  type SignInCodeDelivery,
} from '@/lib/sign-in-code';

import bg from '../messages/bg.json';
import en from '../messages/en.json';

const ADDRESS = 'member@example.org';

function translatorFor(locale: 'bg' | 'en'): AuthEmailTranslate {
  const t = createTranslator({
    locale,
    messages: locale === 'en' ? en : bg,
    namespace: 'AuthEmail',
  });
  return (key, values) => t(key, values);
}

/** The error nodemailer throws when a relay refuses every recipient. */
function envelopeRejection(): Error {
  return Object.assign(
    new Error(`Can't send mail - all recipients were rejected: 550 <${ADDRESS}>`),
    {
      code: 'EENVELOPE',
      responseCode: 550,
      rejected: [ADDRESS],
    },
  );
}

function rejectingMailer(error: unknown): Mailer {
  return { send: () => Promise.reject(error) };
}

function delivery(overrides: Partial<SignInCodeDelivery> = {}): SignInCodeDelivery {
  return {
    email: ADDRESS,
    issueCode: () => Promise.resolve('482913'),
    translate: translatorFor('bg'),
    mailer: new MemoryMailer(),
    log: vi.fn(),
    verboseErrors: false,
    ...overrides,
  };
}

/** Everything that reached the log, flattened to one searchable string. */
function logged(log: SignInCodeDelivery['log']): string {
  return JSON.stringify((log as ReturnType<typeof vi.fn>).mock.calls);
}

describe('deliverSignInCode', () => {
  it('mails the code in the language the member is using', async () => {
    const mailer = new MemoryMailer();
    const outcome = await deliverSignInCode(delivery({ mailer, translate: translatorFor('en') }));

    expect(outcome).toBe('sent');
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe(ADDRESS);
    // The English catalogue's subject — not the Bulgarian one every code used
    // to arrive with, whatever the member was reading the site in.
    expect(mailer.sent[0]?.subject).toBe(en.AuthEmail.otpSubject);
    expect(mailer.sent[0]?.text).toContain('482913');
    expect(mailer.sent[0]?.text).toContain('10 minutes');
    expect(mailer.sent[0]?.html).toContain('482913');
  });

  it('mails Bulgarian to a Bulgarian-language member', async () => {
    const mailer = new MemoryMailer();
    await deliverSignInCode(delivery({ mailer }));
    expect(mailer.sent[0]?.subject).toBe(bg.AuthEmail.otpSubject);
  });

  it('reports a missing transport instead of claiming the code was sent', async () => {
    const log = vi.fn();
    const outcome = await deliverSignInCode(
      delivery({ mailer: new DisabledMailer('SMTP_HOST is unset'), log }),
    );
    expect(outcome).toBe('mail_unavailable');
    expect(log).toHaveBeenCalledOnce();
  });

  it('reports a relay refusal, and logs it without the address', async () => {
    const log = vi.fn();
    const outcome = await deliverSignInCode(
      delivery({ mailer: rejectingMailer(envelopeRejection()), log }),
    );
    expect(outcome).toBe('mail_unavailable');
    // Type, transport code and SMTP status survive; the recipient does not.
    expect(logged(log)).toContain('Error EENVELOPE 550');
    expect(logged(log)).not.toContain(ADDRESS);
    expect(logged(log)).not.toContain('482913');
  });

  it('gives up on a relay that never answers', async () => {
    const outcome = await deliverSignInCode(
      // An executor that never settles: a relay holding the connection open.
      delivery({ mailer: { send: () => new Promise<void>(vi.fn()) }, timeoutMs: 20 }),
    );
    expect(outcome).toBe('mail_unavailable');
  });

  it('reports a failure to mint the code as unknown, without sending anything', async () => {
    const mailer = new MemoryMailer();
    const log = vi.fn();
    const outcome = await deliverSignInCode(
      delivery({
        mailer,
        log,
        issueCode: () => Promise.reject(new Error(`insert failed for ${ADDRESS}`)),
      }),
    );
    expect(outcome).toBe('unknown');
    expect(mailer.sent).toEqual([]);
    expect(logged(log)).not.toContain(ADDRESS);
  });

  it('hands development the whole error', async () => {
    const log = vi.fn();
    const error = envelopeRejection();
    await deliverSignInCode(delivery({ mailer: rejectingMailer(error), log, verboseErrors: true }));
    expect(log).toHaveBeenCalledWith(expect.any(String), error);
  });
});

describe('log redaction', () => {
  it('keeps an error to its type and codes', () => {
    expect(describeErrorForLog(envelopeRejection())).toBe('Error EENVELOPE 550');
    expect(describeErrorForLog(new TypeError('x'))).toBe('TypeError');
    expect(describeErrorForLog('a string')).toBe('string');
    // A "code" that is really free text is dropped, not trusted.
    expect(describeErrorForLog(Object.assign(new Error('boom'), { code: `bad ${ADDRESS}` }))).toBe(
      'Error',
    );
  });

  it('reduces better-auth log arguments to nothing that can name a person', () => {
    const redacted = redactLogArgs([envelopeRejection(), { email: ADDRESS }, ADDRESS, 3, true]);
    expect(redacted).toEqual(['Error EENVELOPE 550', '[redacted]', '[redacted]', 3, true]);
    expect(JSON.stringify(redacted)).not.toContain(ADDRESS);
  });
});
