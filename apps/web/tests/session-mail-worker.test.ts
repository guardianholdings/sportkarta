import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * The worker's mail wiring, asserted at the source level — the worker package
 * has no test runner of its own, and these are exactly the properties that
 * regress silently: nothing fails, somebody is just never told. The send-loop
 * policy itself (stop on a down transport, throw on a miss) is unit-tested in
 * lib/src/email/delivery.test.ts; the recipient arithmetic against real
 * Postgres in db/src/session-mail-recipients.test.ts.
 */

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

const index = source('../../worker/src/index.ts');
const sessionJob = source('../../worker/src/session-mail-job.ts');
const notifications = source('../../../db/src/sessions/notifications.ts');
const occurrence = source('../lib/sessions/occurrence.ts');
const sessionPage = source('../app/[locale]/sesiya/[occurrenceId]/page.tsx');

describe('failed session mail is retried', () => {
  it('session.notify throws when anybody was not reached', () => {
    // It is enqueued once per event (a cancellation, a promotion). A handler
    // that swallows the failure completes the job, and pg-boss never retries.
    expect(index).toMatch(/assertDelivered\(SESSION_NOTIFY_QUEUE, last\)/);
  });

  it('gives session.notify and the weekly jobs a real retry policy', () => {
    expect(index).toMatch(/ensureQueue\(SESSION_NOTIFY_QUEUE, MAIL_RETRY\)/);
    for (const queue of [
      'DIGEST_WEEKLY_QUEUE',
      'STREAK_FREEZE_QUEUE',
      'DIVISIONS_ROLLOVER_QUEUE',
    ]) {
      expect(index).toMatch(new RegExp(`ensureQueue\\(${queue}, WEEKLY_RETRY\\)`));
    }
    expect(index).toMatch(/retryBackoff: true/);
  });

  it('applies the policy to queues production already has', () => {
    // pg-boss createQueue is INSERT … ON CONFLICT DO NOTHING: options passed to
    // it never reach an existing queue. updateQueue is what changes them.
    expect(index).toMatch(/await boss\.updateQueue\(name,/);
  });

  it('leaves a log line when a weekly job fails', () => {
    // pg-boss prints nothing when a handler throws.
    for (const queue of [
      'DIGEST_WEEKLY_QUEUE',
      'STREAK_FREEZE_QUEUE',
      'DIVISIONS_ROLLOVER_QUEUE',
    ]) {
      expect(index).toMatch(new RegExp(`logged\\(${queue},`));
    }
  });
});

describe('worker robustness', () => {
  it('listens for idle-client errors on the shared db pool', () => {
    // Every mail and passport job queries through getDb()'s pool; an unhandled
    // 'error' on it is an uncaught exception that kills the worker.
    expect(index).toMatch(/getPool\(\)\.on\('error'/);
  });

  it('builds one mailer for the process, so the SMTP pool is reused', () => {
    expect(index.match(/createMailer\(process\.env\)/g)).toHaveLength(1);
    expect(index).toMatch(/mailer\.close\?\.\(\)/);
  });
});

describe('what a session mail says', () => {
  it('prints the WAITLIST place, not the queue position', () => {
    expect(sessionJob).toMatch(/waitlistPlace: recipient\.waitlistPlace/);
    expect(sessionJob).not.toMatch(/position: recipient\.position/);
    expect(notifications).toMatch(/\$\{waitlistPlaceSql\('pos'\)\} AS waitlist_place/);
  });

  it('shows the session page the same number, from the same definition', () => {
    expect(occurrence).toMatch(/waitlistPlaceSql\('p'\)/);
    expect(sessionPage).toMatch(/position: view\.viewerWaitlistPlace/);
    expect(sessionPage).not.toMatch(/viewerPosition/);
  });

  it('never puts the calendar-feed token into a mail', () => {
    // The token is a credential; a forwarded confirmation would hand it on.
    expect(sessionJob).not.toMatch(/calendarToken|\/kalendar\/\$\{recipient/);
    expect(notifications).not.toMatch(/ct\.token/);
    expect(sessionJob).toMatch(
      /calendarSettingsUrl: recipient\.hasCalendarFeed \? `\$\{base\}\/profil`/,
    );
  });
});
