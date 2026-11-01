import { renderSql, type SQL } from '@sportkarta/db';
import { describe, expect, it } from 'vitest';

import { applyForClub, MAX_CLUBS_PER_OWNER } from '@/lib/clubs/apply';
import type { ApplicationInput } from '@/lib/clubs/input';
import { CLUB_TERMS_DRAFT, CLUB_TERMS_VERSION } from '@/lib/legal-pages';

/**
 * The application is the club's acceptance of the clubs terms and their
 * Annex A (/usloviya-klubove). At the statement level: the audit row written
 * in the same transaction as the club says WHICH version was accepted and
 * when, so a later edition of the text cannot blur what this club agreed to.
 * The DB-backed journey (tests/journeys/clubs.test.ts) covers the rest.
 */

const USER = 'user_1';
const CLUB = '00000000-0000-4000-8000-000000000042';

/** Records every statement; answers reads from a scripted queue. */
function fakeDb(responses: Record<string, unknown>[][]) {
  const statements: { sql: string; params: unknown[] }[] = [];
  const queue = [...responses];
  const runner = {
    execute(query: SQL) {
      statements.push(renderSql(query));
      return Promise.resolve({ rows: queue.shift() ?? [] });
    },
  };
  return {
    statements,
    ...runner,
    transaction<T>(callback: (tx: typeof runner) => Promise<T>): Promise<T> {
      return callback(runner);
    },
  };
}

const input: ApplicationInput = {
  nameBg: 'Зала Пример',
  kind: 'gym',
  tier: 'standard',
  municipalityId: null,
  sports: ['yoga'],
  websiteUrl: null,
  descriptionBg: null,
};

describe('applyForClub', () => {
  it('records the version of the clubs terms the applicant accepted, in the club audit', async () => {
    const before = Date.now();
    // lock → owner counts → taken slugs → INSERT clubs RETURNING id → staff → audit
    const db = fakeDb([[], [{ owned: 0, pending: 0 }], [], [{ id: CLUB }], [], []]);
    const result = await applyForClub(db, USER, input);
    expect(result).toEqual({ ok: true, clubId: CLUB, slug: expect.any(String) });

    const auditAt = db.statements.findIndex((s) => s.sql.includes('INSERT INTO club_audit'));
    const audit = db.statements[auditAt];
    expect(audit).toBeDefined();
    const json = audit?.params.find((p) => typeof p === 'string' && p.startsWith('{'));
    const detail = JSON.parse(String(json)) as Record<string, unknown>;
    expect(detail).toMatchObject({
      tier: 'standard',
      termsVersion: CLUB_TERMS_VERSION,
      termsDraft: CLUB_TERMS_DRAFT,
    });
    expect(typeof detail.termsDraft).toBe('boolean');
    const acceptedAt = Date.parse(String(detail.termsAcceptedAt));
    expect(acceptedAt).toBeGreaterThanOrEqual(before);
    expect(acceptedAt).toBeLessThanOrEqual(Date.now());
    // The same transaction: the audit follows the club and the owner row.
    expect(db.statements.findIndex((s) => s.sql.includes('INSERT INTO clubs'))).toBeLessThan(
      auditAt,
    );
  });

  it('writes nothing when the account already has a pending application', async () => {
    const db = fakeDb([[], [{ owned: 1, pending: 1 }]]);
    expect(await applyForClub(db, USER, input)).toEqual({ ok: false, error: 'already_pending' });
    expect(db.statements.some((s) => /INSERT/.test(s.sql))).toBe(false);
  });

  it('writes nothing when the account already owns the maximum number of clubs', async () => {
    const db = fakeDb([[], [{ owned: MAX_CLUBS_PER_OWNER, pending: 0 }]]);
    expect(await applyForClub(db, USER, input)).toEqual({ ok: false, error: 'too_many' });
    expect(db.statements.some((s) => /INSERT/.test(s.sql))).toBe(false);
  });
});
