import { describe, expect, it } from 'vitest';

import {
  MailBudgetExhaustedError,
  isMailBudgetExhausted,
  isMailBudgetKind,
  mailBudgetWarnAt,
  nextMailBudgetDay,
  resolveMailBudget,
} from './budget.js';

/**
 * The budget arithmetic (lib/src/email/budget.ts). The counter and its
 * atomicity are proven against Postgres in db/src/mail-budget.test.ts.
 */

describe('resolveMailBudget', () => {
  it('defaults to Migadu Mini: 100 a day, 40 for codes, 40 for notices, 20 bulk', () => {
    expect(resolveMailBudget({})).toEqual({ quota: 100, otp: 40, notice: 40, bulk: 20 });
  });

  it('sizes every share from the quota, and bulk gets the rest', () => {
    expect(
      resolveMailBudget({ MAIL_DAILY_QUOTA: '300', MAIL_OTP_SHARE: '50', MAIL_NOTICE_SHARE: '30' }),
    ).toEqual({ quota: 300, otp: 150, notice: 90, bulk: 60 });
  });

  it('lets CLUB_BULK_MAIL_DAILY_LIMIT lower the bulk share, never raise it', () => {
    expect(resolveMailBudget({ CLUB_BULK_MAIL_DAILY_LIMIT: '5' }).bulk).toBe(5);
    // The old default (60) is above the share: the share wins.
    expect(resolveMailBudget({ CLUB_BULK_MAIL_DAILY_LIMIT: '60' }).bulk).toBe(20);
    expect(resolveMailBudget({ CLUB_BULK_MAIL_DAILY_LIMIT: '0' }).bulk).toBe(0);
  });

  it('falls back to the defaults on anything unusable — never to "no limit"', () => {
    for (const quota of ['', ' ', 'abc', '0', '-5', '1e3', '10000000']) {
      expect(resolveMailBudget({ MAIL_DAILY_QUOTA: quota }).quota).toBe(100);
    }
    expect(resolveMailBudget({ MAIL_OTP_SHARE: '140' })).toMatchObject({ otp: 40 });
    expect(resolveMailBudget({ CLUB_BULK_MAIL_DAILY_LIMIT: 'lots' }).bulk).toBe(20);
  });

  it('reverts BOTH shares when together they claim more than the day', () => {
    expect(resolveMailBudget({ MAIL_OTP_SHARE: '70', MAIL_NOTICE_SHARE: '50' })).toEqual({
      quota: 100,
      otp: 40,
      notice: 40,
      bulk: 20,
    });
  });

  it('never sums the shares past the quota, whatever the rounding', () => {
    for (const quota of ['1', '7', '33', '99', '101', '250']) {
      const limits = resolveMailBudget({
        MAIL_DAILY_QUOTA: quota,
        MAIL_OTP_SHARE: '33',
        MAIL_NOTICE_SHARE: '33',
      });
      expect(limits.otp + limits.notice + limits.bulk).toBe(limits.quota);
      expect(Math.min(limits.otp, limits.notice, limits.bulk)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('mailBudgetWarnAt', () => {
  it('is 80 % of the share, rounded up, so a tiny share still warns before it is spent', () => {
    expect(mailBudgetWarnAt(40)).toBe(32);
    expect(mailBudgetWarnAt(20)).toBe(16);
    expect(mailBudgetWarnAt(3)).toBe(3);
    expect(mailBudgetWarnAt(0)).toBe(0);
  });
});

describe('MailBudgetExhaustedError', () => {
  it('names the kind, the limit and the day, and nothing about the message', () => {
    const error = new MailBudgetExhaustedError('otp', 40, '2026-11-06');
    expect(isMailBudgetExhausted(error)).toBe(true);
    expect(isMailBudgetExhausted(new Error('x'))).toBe(false);
    expect(error.code).toBe('EMAILBUDGET');
    expect(error.name).toBe('MailBudgetExhaustedError');
    expect(error.message).toBe("The day's mail budget for otp is spent (40 on 2026-11-06)");
  });

  it('knows its kinds', () => {
    expect(['otp', 'notice', 'bulk'].every(isMailBudgetKind)).toBe(true);
    expect(isMailBudgetKind('digest')).toBe(false);
  });
});

describe('nextMailBudgetDay', () => {
  const at = (iso: string) => nextMailBudgetDay(new Date(iso)).toISOString();

  it('is the coming Sofia midnight, in winter (UTC+2) and in summer (UTC+3)', () => {
    expect(at('2026-11-06T10:00:00Z')).toBe('2026-11-06T22:00:00.000Z');
    expect(at('2026-07-01T10:00:00Z')).toBe('2026-07-01T21:00:00.000Z');
  });

  it('rolls over exactly at midnight Sofia, not at midnight UTC', () => {
    // 23:59:59 Sofia on the 6th → the 7th's midnight; 00:00 Sofia on the 7th → the 8th's.
    expect(at('2026-11-06T21:59:59Z')).toBe('2026-11-06T22:00:00.000Z');
    expect(at('2026-11-06T22:00:00Z')).toBe('2026-11-07T22:00:00.000Z');
  });

  it('is right across the clock changes', () => {
    // The night the clocks go back (last Sunday of October 2026 is the 25th):
    // its midnight is still summer time; the night after is winter time.
    expect(at('2026-10-24T10:00:00Z')).toBe('2026-10-24T21:00:00.000Z');
    expect(at('2026-10-25T10:00:00Z')).toBe('2026-10-25T22:00:00.000Z');
    // The night the clocks go forward (last Sunday of March 2027 is the 28th).
    expect(at('2027-03-27T10:00:00Z')).toBe('2027-03-27T22:00:00.000Z');
    expect(at('2027-03-28T10:00:00Z')).toBe('2027-03-28T21:00:00.000Z');
  });
});
