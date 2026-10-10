import { renderSql, type SQL } from '@sportkarta/db';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  newUnsubscribeToken,
  subscribe,
  subscriptionByToken,
  unsubscribe,
  unsubscribeByToken,
} from '@/lib/digest';

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
    const db = fakeDb([[{ id: 68, name_bg: 'София', name_en: 'Sofia' }]]);
    const removed = await unsubscribeByToken(db, 'tok3n');
    // The id goes to the "done" screen, which names the city (L-6).
    expect(removed).toEqual({ municipalityId: 68, nameBg: 'София', nameEn: 'Sofia' });
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

describe('subscriptionByToken', () => {
  it('names the city for the confirm page WITHOUT unsubscribing (a GET must not)', async () => {
    const db = fakeDb([[{ id: 68, name_bg: 'София', name_en: 'Sofia' }]]);
    expect(await subscriptionByToken(db, 'tok3n')).toEqual({
      municipalityId: 68,
      nameBg: 'София',
      nameEn: 'Sofia',
    });
    const statement = db.statements[0];
    expect(statement?.sql).toMatch(/^\s*SELECT/);
    expect(statement?.sql).not.toMatch(/DELETE|UPDATE/i);
    expect(statement?.params).toEqual(['tok3n']);
  });

  it('is null for an unknown token', async () => {
    expect(await subscriptionByToken(fakeDb([[]]), 'stale')).toBeNull();
  });
});

const deliverySource = readFileSync(
  new URL('../../../lib/src/email/delivery.ts', import.meta.url),
  'utf8',
);

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
    // credentials, so the catch logs a category and nothing else. The
    // per-recipient loop now lives in lib/src/email/delivery.ts (shared with
    // session mail), so its log lines are checked there too.
    const logLines = [jobSource, deliverySource].flatMap(
      (source) => source.match(/(console\.(log|error)|logError)\([^;]*\);/gs) ?? [],
    );
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
    // It READS the city to name it (L-6) — subscriptionByToken is a SELECT.
    expect(pageSource).toMatch(/subscriptionByToken\(/);
  });

  it('names the city once it is done, from an id rather than anything typed', () => {
    expect(actionSource).toMatch(/ok&m=\$\{String\(removed\.municipalityId\)\}/);
    expect(pageSource).toMatch(/t\('unsubscribedCity', \{ city \}\)/);
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
    // The job hands its loop to deliverEach, which categorises.
    expect(jobSource).toMatch(/deliverEach\(/);
    for (const source of [jobSource, deliverySource]) {
      expect(source).not.toMatch(/(console\.error|logError)\([^)]*error\.message/s);
    }
    expect(deliverySource).toMatch(/mailFailureCategory\(error\)/);
  });

  it('fails the job when anybody was missed, so the queue retries this week', () => {
    // The digest runs once a week: a swallowed failure used to mean that
    // subscriber simply missed the week.
    const workerSource = readFileSync(
      new URL('../../worker/src/index.ts', import.meta.url),
      'utf8',
    );
    expect(workerSource).toMatch(/assertDelivered\(DIGEST_WEEKLY_QUEUE, last\)/);
    expect(workerSource).toMatch(/ensureQueue\(DIGEST_WEEKLY_QUEUE, WEEKLY_RETRY\)/);
  });

  it('sends the RFC 8058 one-click header to the POST endpoint, not the confirm page', () => {
    expect(jobSource).toMatch(
      /oneClickUnsubscribeUrl: `\$\{base\}\/api\/digest\/unsubscribe\/\$\{recipient\.unsubscribeToken\}`/,
    );
  });

  it('throws rather than mailing a message key when a string is missing', () => {
    expect(jobSource).toMatch(/is missing from messages\//);
  });
});

describe('one-click unsubscribe endpoint (RFC 8058)', () => {
  // The route calls unsubscribeByToken; the database behind it is faked here.
  // What is under test is the HTTP contract a mail provider relies on.
  const TOKEN = 'Zm9vYmFyYmF6cXV4cXV1eGNvcmdl';
  const params = (token: string) => ({ params: Promise.resolve({ token }) });

  async function loadRoute(removed: { nameBg: string; nameEn: string } | null) {
    vi.resetModules();
    const unsubscribeByTokenMock = vi.fn(() => Promise.resolve(removed));
    vi.doMock('@/lib/digest', () => ({ unsubscribeByToken: unsubscribeByTokenMock }));
    vi.doMock('@sportkarta/db', () => ({ getDb: () => ({}) }));
    const route = await import('../app/api/digest/unsubscribe/[token]/route');
    return { route, unsubscribeByTokenMock };
  }

  afterEach(() => {
    vi.doUnmock('@/lib/digest');
    vi.doUnmock('@sportkarta/db');
  });

  it('unsubscribes on the POST a mail provider sends, with no redirect', async () => {
    const { route, unsubscribeByTokenMock } = await loadRoute({ nameBg: 'София', nameEn: 'Sofia' });
    const request = new Request(`http://localhost/api/digest/unsubscribe/${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    const response = await route.POST(request, params(TOKEN));
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(unsubscribeByTokenMock).toHaveBeenCalledWith(expect.anything(), TOKEN);
  });

  it('answers an unknown token exactly like a known one (no token oracle)', async () => {
    const { route } = await loadRoute(null);
    const response = await route.POST(
      new Request('http://localhost/x', { method: 'POST' }),
      params(TOKEN),
    );
    expect(response.status).toBe(200);
  });

  it('never touches the database for a token that cannot exist', async () => {
    const { route, unsubscribeByTokenMock } = await loadRoute(null);
    const response = await route.POST(
      new Request('http://localhost/x', { method: 'POST' }),
      params('short'),
    );
    expect(response.status).toBe(200);
    expect(unsubscribeByTokenMock).not.toHaveBeenCalled();
  });

  it('never unsubscribes on a GET — a link scanner gets the confirm page', async () => {
    const { route, unsubscribeByTokenMock } = await loadRoute({ nameBg: 'София', nameEn: 'Sofia' });
    const response = await route.GET(new Request('http://localhost/x'), params(TOKEN));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toMatch(new RegExp(`/sedmitsata/otpisvane/${TOKEN}$`));
    expect(unsubscribeByTokenMock).not.toHaveBeenCalled();
  });
});
