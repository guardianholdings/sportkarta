import { describe, expect, it } from 'vitest';

import {
  assertDelivered,
  deliverEach,
  emptyDeliveryReport,
  isMailTransportDown,
  mailFailureCategory,
  MailRunIncompleteError,
  type DeliveryOutcome,
} from './delivery.js';
import { MailNotConfiguredError } from './mailer.js';

/**
 * The shared worker send loop. What is under test is the policy, not SMTP:
 * one bad address must not stop the run, a down relay must stop it at once, a
 * run that left anybody unreached must be retryable, and no log line may carry
 * an address.
 */

/** A nodemailer-shaped SMTP error, exactly as the transport raises them. */
function smtpError(code: string, response?: string): Error {
  const error = new Error(`Message failed: ${response ?? ''}`) as Error & {
    code: string;
    response?: string;
    responseCode?: number;
  };
  error.code = code;
  if (response) {
    error.response = response;
    const reply = /^(\d{3})/.exec(response);
    if (reply) error.responseCode = Number(reply[1]);
  }
  return error;
}

const BOUNCE = smtpError('EENVELOPE', '550 5.1.1 <ivan@example.org>: Recipient address rejected');
const QUOTA = smtpError('EENVELOPE', '550-5.4.5 Daily user sending limit exceeded. For more info');
const THROTTLED = smtpError('EAUTH', '454 4.7.0 Too many login attempts, please try again later');
const BAD_LOGIN = smtpError('EAUTH', '535-5.7.8 Username and Password not accepted');

async function run(
  outcomes: (DeliveryOutcome | Error)[],
): Promise<{ report: Awaited<ReturnType<typeof deliverEach>>; logs: string[]; tried: number[] }> {
  const logs: string[] = [];
  const tried: number[] = [];
  const report = await deliverEach(
    outcomes.map((_, index) => index),
    (index) => {
      tried.push(index);
      const outcome = outcomes[index];
      return outcome instanceof Error
        ? Promise.reject(outcome)
        : Promise.resolve(outcome ?? 'sent');
    },
    { job: 'digest.weekly', logError: (line) => logs.push(line) },
  );
  return { report, logs, tried };
}

describe('mailFailureCategory', () => {
  it('keeps the code and the numeric SMTP status, and drops the address', () => {
    expect(mailFailureCategory(BOUNCE)).toBe('EENVELOPE 550 5.1.1');
    expect(mailFailureCategory(QUOTA)).toBe('EENVELOPE 550 5.4.5');
    expect(mailFailureCategory(BOUNCE)).not.toContain('@');
  });

  it('falls back to a fixed word for anything it cannot vouch for', () => {
    expect(mailFailureCategory(new Error('boom <ivan@example.org>'))).toBe('send_failed');
    expect(mailFailureCategory({ code: 'ivan@example.org' })).toBe('send_failed');
    expect(mailFailureCategory(new MailNotConfiguredError('SMTP_HOST is unset'))).toBe(
      'mail_not_configured',
    );
    // A Postgres SQLSTATE is a safe code too.
    expect(mailFailureCategory({ code: '57P01' })).toBe('57P01');
  });
});

describe('isMailTransportDown', () => {
  it('recognises the relay refusing the SENDER', () => {
    for (const error of [QUOTA, THROTTLED, BAD_LOGIN, smtpError('ETIMEDOUT')]) {
      expect(isMailTransportDown(error)).toBe(true);
    }
    expect(isMailTransportDown(new MailNotConfiguredError('SMTP_HOST is unset'))).toBe(true);
    expect(isMailTransportDown(smtpError('EENVELOPE', '421 4.7.28 Try again later'))).toBe(true);
  });

  it('treats a rejected RECIPIENT as that recipient’s problem only', () => {
    expect(isMailTransportDown(BOUNCE)).toBe(false);
    expect(isMailTransportDown({ code: '23505' })).toBe(false);
    expect(isMailTransportDown(new Error('anything'))).toBe(false);
  });
});

describe('deliverEach', () => {
  it('counts sent and skipped', async () => {
    const { report } = await run(['sent', 'skipped', 'sent']);
    expect(report).toEqual({ ...emptyDeliveryReport(3), sent: 2, skipped: 1 });
  });

  it('carries on past one bounced address', async () => {
    const { report, tried } = await run(['sent', BOUNCE, 'sent']);
    expect(tried).toEqual([0, 1, 2]);
    expect(report).toMatchObject({ sent: 2, failed: 1, unattempted: 0, transportDown: false });
  });

  it('stops at the first quota error instead of trying everybody else', async () => {
    const { report, tried, logs } = await run(['sent', QUOTA, 'sent', 'sent', 'sent']);
    // Every later send would fail identically, and each is another login
    // against an account that is already refusing us.
    expect(tried).toEqual([0, 1]);
    expect(report).toMatchObject({ sent: 1, failed: 1, unattempted: 3, transportDown: true });
    expect(logs).toContain(
      '[mail] transport_down job=digest.weekly category="EENVELOPE 550 5.4.5" sent=1 unattempted=3',
    );
  });

  it('stops on an auth failure too', async () => {
    const { report } = await run([THROTTLED, 'sent']);
    expect(report).toMatchObject({ failed: 1, unattempted: 1, transportDown: true });
  });

  it('never writes an address into a log line', async () => {
    const { logs } = await run([BOUNCE, QUOTA]);
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) expect(line).not.toContain('@');
  });
});

describe('assertDelivered', () => {
  it('passes a run that reached everybody', () => {
    expect(() => {
      assertDelivered('session.notify', { ...emptyDeliveryReport(2), sent: 1, skipped: 1 });
    }).not.toThrow();
  });

  it('throws — so the queue retries — when anybody was not reached', async () => {
    const failed = (await run(['sent', BOUNCE])).report;
    expect(() => {
      assertDelivered('session.notify', failed);
    }).toThrow(MailRunIncompleteError);

    const stopped = (await run([QUOTA, 'sent'])).report;
    expect(() => {
      assertDelivered('session.notify', stopped);
    }).toThrow(/1 failed, 1 unattempted of 2 \(transport down\)/);
  });

  it('says counts only — pg-boss keeps the message in the job row', async () => {
    const { report } = await run([BOUNCE]);
    try {
      assertDelivered('digest.weekly', report);
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain('@');
    }
  });
});
