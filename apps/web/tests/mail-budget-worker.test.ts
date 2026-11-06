import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * The worker's side of the daily mail budget (0062), asserted at the source
 * level like session-mail-worker.test.ts — the worker package has no test
 * runner, and these are the properties that regress silently: a job handed
 * the bare relay mailer would spend no share and could still exhaust the
 * relay; a held one-off notice that is not deferred is a notice nobody gets.
 * The counter's atomicity is proven in db/src/mail-budget.test.ts, the send
 * loop's hold in lib/src/email/delivery.test.ts, and the sign-in action's
 * refusal in sign-in-action-budget.test.ts.
 */

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

const index = source('../../worker/src/index.ts');
const sessionJob = source('../../worker/src/session-mail-job.ts');
const messagesJob = source('../../worker/src/club-messages-job.ts');
const clubJob = source('../../worker/src/club-mail-job.ts');
const moderationJob = source('../../worker/src/moderation-mail-job.ts');
const action = source('../app/[locale]/vhod/actions.ts');

describe('every worker mail spends the day’s budget', () => {
  it('wraps the one relay mailer in the notice share, and bulk mail in the bulk share', () => {
    expect(index.match(/createMailer\(process\.env\)/g)).toHaveLength(1);
    expect(index).toMatch(
      /const mailer = budgetedMailer\(relayMailer, \{\s*db: getDb\(\),\s*kind: 'notice',\s*limits: mailBudget,?\s*\}\)/,
    );
    expect(index).toMatch(
      /const bulkMailer = budgetedMailer\(relayMailer, \{\s*db: getDb\(\),\s*kind: 'bulk',\s*limits: mailBudget,?\s*\}\)/,
    );
    // The bare relay mailer reaches no job: it is created, wrapped twice, and
    // that is every mention of it.
    expect(index.match(/relayMailer/g)).toHaveLength(3);
  });

  it('gives the club sweeps the bulk mailer and sizes their own allowance from the bulk share', () => {
    expect(index).toMatch(/mailer: bulkMailer,\s*bulkMailDailyLimit: mailBudget\.bulk/);
    // The old direct read is gone: the share is the one place the cap applies.
    expect(index).not.toMatch(/process\.env\.CLUB_BULK_MAIL_DAILY_LIMIT/);
  });

  it('the code share is the web app’s alone', () => {
    expect(index).not.toMatch(/kind: 'otp'/);
  });
});

describe('a held notice is deferred, not dropped', () => {
  it('re-sends the one-off notice jobs for the next Sofia day before asserting delivery', () => {
    for (const queue of ['SESSION_NOTIFY_QUEUE', 'CLUB_NOTIFY_QUEUE']) {
      const deferAt = index.indexOf(`deferHeld(${queue}`);
      const assertAt = index.indexOf(`assertDelivered(${queue}`);
      expect(deferAt, `${queue} defers`).toBeGreaterThan(-1);
      expect(deferAt, `${queue} defers before it asserts`).toBeLessThan(assertAt);
    }
    expect(index).toMatch(
      /if \(outcome === 'held'\) \{\s*await deferHeld\(MODERATION_NOTIFY_QUEUE/,
    );
    expect(index).toMatch(/const startAfter = nextMailBudgetDay\(\);/);
    expect(index).toMatch(/await boss\.send\(queue, data, \{ startAfter \}\);/);
  });

  it('the moderation job reports a hold instead of failing the claim', () => {
    expect(moderationJob).toMatch(/if \(isMailBudgetExhausted\(error\)\) return 'held';/);
  });

  it('sweeps stop at a hold as at a down relay — their next tick is the retry', () => {
    expect(sessionJob).toMatch(/if \(report\.transportDown \|\| report\.held > 0\) break;/);
    expect(clubJob).toMatch(/if \(out\[kind\]\.transportDown \|\| out\[kind\]\.held > 0\) break;/);
    expect(messagesJob).toMatch(/if \(report\.transportDown \|\| report\.held > 0\) break;/);
    // The sweep's totals carry the hold, so a held broadcast stays `sending`.
    expect(messagesJob).toMatch(/'failed', 'held', 'unattempted'\] as const/);
  });

  it('prunes the day counters nightly, with the expired codes', () => {
    expect(index).toMatch(/pruneMailBudget\(getDb\(\)\)/);
  });
});

describe('the sign-in code share', () => {
  it('is asked after the in-memory limiters and before a code is minted', () => {
    const globalCap = action.indexOf('otpGlobalSendLimiter.check(GLOBAL_SEND_KEY)');
    const reserve = action.indexOf('await reserveSignInCodeMail()');
    const send = action.indexOf('await sendSignInCode(email, locale)');
    expect(globalCap).toBeGreaterThan(-1);
    expect(reserve).toBeGreaterThan(globalCap);
    expect(send).toBeGreaterThan(reserve);
  });

  it('gives the slot back when no code went out', () => {
    expect(action).toMatch(/if \(outcome !== 'sent'\) await slot\.release\(\);/);
  });
});
