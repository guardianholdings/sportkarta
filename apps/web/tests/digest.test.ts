import { renderSql, type SQL } from '@sportkarta/db';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { newUnsubscribeToken, subscribe, unsubscribe, unsubscribeByToken } from '@/lib/digest';

/**
 * The digest opt-in (docs/ROADMAP.md §6, Stage 4.4). The week query itself is
 * tested in db/src/digest.test.ts against real Postgres.
 */

function fakeDb(rows: Record<string, unknown>[][] = []) {
  const statements: { sql: string; params: unknown[] }[] = [];
  let index = 0;
  return {
    statements,
    execute(query: SQL) {
      statements.push(renderSql(query));
      const answer = rows[index] ?? [];
      index += 1;
      return Promise.resolve({ rows: answer });
    },
  };
}

describe('newUnsubscribeToken', () => {
  it('matches the shape the column CHECK enforces', () => {
    // The CHECK exists so a truncated or predictable generator fails closed.
    for (let i = 0; i < 50; i += 1) {
      expect(newUnsubscribeToken()).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    }
  });

  it('does not repeat', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => newUnsubscribeToken()));
    expect(tokens.size).toBe(500);
  });
});

describe('subscribe', () => {
  it('is idempotent and keeps the original token', async () => {
    const db = fakeDb();
    await subscribe(db, 'user_1', 7);
    const sql = db.statements[0]?.sql ?? '';
    // DO NOTHING, not DO UPDATE: re-issuing the token would silently break the
    // unsubscribe link in every digest already sitting in the member's inbox.
    expect(sql).toMatch(/ON CONFLICT \(user_id, municipality_id\) DO NOTHING/i);
    expect(sql).not.toMatch(/DO UPDATE/i);
  });

  it('scopes the delete to the caller when unsubscribing from the profile', async () => {
    const db = fakeDb();
    await unsubscribe(db, 'user_1', 7);
    const statement = db.statements[0];
    expect(statement?.sql).toMatch(/user_id = \$\d+ AND municipality_id = \$\d+/i);
    expect(statement?.params).toEqual(['user_1', 7]);
  });
});

describe('unsubscribeByToken', () => {
  it('needs no user id — the token alone stops the mail', async () => {
    const db = fakeDb([[{ name_bg: 'София', name_en: 'Sofia' }]]);
    const removed = await unsubscribeByToken(db, 'tok3n');
    expect(removed).toEqual({ nameBg: 'София', nameEn: 'Sofia' });
    const statement = db.statements[0];
    // Somebody who has lost interest must not have to sign in to make it stop.
    expect(statement?.sql).not.toMatch(/user_id/i);
    expect(statement?.params).toEqual(['tok3n']);
  });

  it('reports an unknown token instead of pretending to fail', async () => {
    // Which is also what a second click on the same link produces.
    const db = fakeDb([[]]);
    expect(await unsubscribeByToken(db, 'stale')).toBeNull();
  });
});

describe('one query, two consumers', () => {
  const pageSource = readFileSync(
    new URL('../app/[locale]/sedmitsata/[city]/page.tsx', import.meta.url),
    'utf8',
  );
  const jobSource = readFileSync(
    new URL('../../worker/src/digest-job.ts', import.meta.url),
    'utf8',
  );

  it('has the page and the job call the SAME weeklyDigest', () => {
    // The whole reason the query lives in @sportkarta/db rather than in
    // apps/web/lib: what a member reads in the mail must be what they find when
    // they follow the link. This asserts it instead of documenting it.
    for (const source of [pageSource, jobSource]) {
      expect(source).toMatch(/weeklyDigest/);
      expect(source).toMatch(/from '@sportkarta\/db'/);
    }
  });

  it('never reimplements the week query in either consumer', () => {
    for (const source of [pageSource, jobSource]) {
      expect(source).not.toMatch(/FROM play_session_occurrences/i);
    }
  });

  it('sends the digest on Monday in Europe/Sofia, not UTC', () => {
    const workerSource = readFileSync(
      new URL('../../worker/src/index.ts', import.meta.url),
      'utf8',
    );
    // A wall-clock promise to a reader must not drift by an hour twice a year.
    expect(workerSource).toMatch(/schedule\(\s*DIGEST_WEEKLY_QUEUE,\s*'0 8 \* \* 1'/);
    expect(workerSource).toMatch(/tz: 'Europe\/Sofia'/);
  });

  it('claims the send before mailing, so a retry cannot double-send', () => {
    const claimIndex = jobSource.indexOf('claimDigestSend');
    const sendIndex = jobSource.indexOf('mailer.send');
    expect(claimIndex).toBeGreaterThan(0);
    expect(sendIndex).toBeGreaterThan(claimIndex);
    // …and both inside one transaction.
    expect(jobSource).toMatch(/db\.transaction\(/);
  });

  it('keeps addresses out of the logs', () => {
    // Counts only. A mailer error can embed the recipient or the relay
    // credentials, so the catch logs the message and nothing else.
    const logLines = jobSource.match(/console\.(log|error)\([^;]*\);/gs) ?? [];
    expect(logLines.length).toBeGreaterThan(0);
    for (const line of logLines) {
      expect(line).not.toMatch(/recipient\.email|\.email\b/);
    }
  });
});

describe('unsubscribe is a POST, not a GET', () => {
  const pageSource = readFileSync(
    new URL('../app/[locale]/sedmitsata/otpisvane/[token]/page.tsx', import.meta.url),
    'utf8',
  );
  const actionSource = readFileSync(
    new URL('../app/[locale]/sedmitsata/otpisvane/[token]/actions.ts', import.meta.url),
    'utf8',
  );

  it('does not unsubscribe on render', () => {
    // Microsoft Defender Safe Links and Proofpoint URL Defense fetch every URL
    // in an inbound message. A destructive GET would silently unsubscribe
    // exactly the subscribers whose employer protects them, before they had
    // read the mail — and would be a CSRF sink for any leaked token.
    expect(pageSource).not.toMatch(/unsubscribeByToken/);
    expect(pageSource).toMatch(/<form action=\{confirmUnsubscribeAction\}>/);
  });

  it('does the delete in a server action that needs no session', () => {
    expect(actionSource).toMatch(/'use server'/);
    expect(actionSource).toMatch(/unsubscribeByToken/);
    // The token IS the authorisation — requiring a sign-in here is what gets a
    // sender marked as spam.
    expect(actionSource).not.toMatch(/requireUser|requireRole/);
  });
});

describe('the digest job never logs an address', () => {
  const jobSource = readFileSync(
    new URL('../../worker/src/digest-job.ts', import.meta.url),
    'utf8',
  );

  it('logs a category, not the mailer error message', () => {
    // "550 5.1.1 <ivan@example.org>: Recipient address rejected" IS the error
    // message, so logging it writes every bounced address into the container log.
    expect(jobSource).not.toMatch(/console\.error\([^)]*error\.message/s);
    expect(jobSource).toMatch(/failureCategory\(error\)/);
  });

  it('throws rather than mailing a message key when a string is missing', () => {
    expect(jobSource).toMatch(/is missing from messages\//);
  });
});
