import { renderSql, type SQL } from '@sportkarta/db';
import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_EXPORT_FORMAT,
  accountExportFilename,
  accountExportResponse,
  buildAccountExport,
  EXPORT_WITHHELD,
} from '@/lib/account-export';

/**
 * The GDPR Art. 15/20 export (lib/account-export.ts), asserted on its SHAPE and
 * on the statements it sends.
 *
 * Three properties matter, and each has a test:
 *  - COMPLETE: no statement carries a LIMIT. The admin screen caps its tables
 *    for reading; an export that stopped at row 100 would be a wrong answer to
 *    a legal request.
 *  - NO LIVE KEY AND NO COORDINATE, anywhere in the output: the file is the copy
 *    of an account most likely to be forwarded. The source-level half of this
 *    rule lives in account-admin-projection.test.ts.
 *  - HONEST ABOUT WHAT IS MISSING: `withheld` names every category left out.
 */

const USER = 'user_export';
const AT = '2026-09-01T10:00:00.000Z';

/** Answer each statement by what it reads — Promise.all makes order meaningless. */
function routedDb(options: { exists?: boolean } = {}) {
  const statements: { sql: string; params: unknown[] }[] = [];
  const answer = (text: string): Record<string, unknown>[] => {
    if (/FROM users WHERE id/.test(text) && /suspended_reason/.test(text)) {
      if (options.exists === false) return [];
      return [
        {
          id: USER,
          email: 'member@example.org',
          email_verified: true,
          display_name: 'Мария',
          home_city: 'Пловдив',
          role: 'user',
          is_minor: false,
          profile_visibility: 'public',
          public_show_activity: false,
          has_handle: true,
          training_route_consent_at: AT,
          training_health_consent_at: null,
          suspended_at: null,
          suspended_reason: null,
          created_at: AT,
          updated_at: AT,
        },
      ];
    }
    if (/FROM points_ledger l/.test(text)) {
      return [
        {
          event: 'facility_added',
          points: 10,
          facility_id: 'f1',
          facility_name: 'Парк',
          created_at: AT,
        },
      ];
    }
    if (/FROM training_logs t/.test(text)) {
      return [
        {
          id: 't1',
          sport: 'running',
          started_at: AT,
          sofia_day: '2026-09-01',
          duration_s: 1800,
          distance_m: 5000,
          elevation_m: null,
          facility_id: null,
          facility_name: null,
          source: 'manual',
          evidence: 'self_reported',
          note: null,
          created_at: AT,
          has_route: true,
          has_metrics: true,
        },
      ];
    }
    if (/FROM sessions WHERE user_id/.test(text)) {
      return [{ user_agent: 'Firefox', created_at: AT, expires_at: AT }];
    }
    if (/FROM calendar_tokens/.test(text)) return [{ created_at: AT, rotated_at: AT }];
    if (/FROM api_keys/.test(text)) {
      return [
        {
          label: 'my app',
          prefix: 'pk_ab12',
          created_at: AT,
          last_used_at: null,
          revoked_at: null,
        },
      ];
    }
    if (/FROM account_access_log/.test(text)) return [{ scope: 'overview', viewed_at: AT }];
    if (/FROM admin_actions/.test(text)) return [{ action: 'passport_made_private', acted_at: AT }];
    return [];
  };
  return {
    statements,
    execute(query: SQL) {
      const rendered = renderSql(query);
      statements.push(rendered);
      return Promise.resolve({ rows: answer(rendered.sql) });
    },
  };
}

/** Every key anywhere in a JSON value, lower-cased. */
function allKeys(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, into);
  } else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      into.push(key.toLowerCase());
      allKeys(inner, into);
    }
  }
  return into;
}

describe('buildAccountExport', () => {
  it('returns null for an account that does not exist', async () => {
    const db = routedDb({ exists: false });
    expect(await buildAccountExport(db, 'ghost')).toBeNull();
    // Nothing else is read once the subject is known to be absent.
    expect(db.statements).toHaveLength(1);
  });

  it('builds the whole record, scoped to the one account', async () => {
    const db = routedDb();
    const data = await buildAccountExport(db, USER, new Date(AT));
    if (!data) throw new Error('expected an export');

    expect(data.format).toBe(ACCOUNT_EXPORT_FORMAT);
    expect(data.generatedAt).toBe(AT);
    expect(data.account).toMatchObject({ id: USER, email: 'member@example.org', suspension: null });
    expect(data.consents.passportPublic).toBe(true);
    expect(data.consents.trainingRouteConsentAt).toBe(AT);
    expect(data.pointsLedger).toHaveLength(1);
    expect(data.trainings[0]).toMatchObject({ hasRoute: true, hasHealthMetrics: true });
    expect(data.credentials.sessions).toEqual([
      { userAgent: 'Firefox', createdAt: AT, expiresAt: AT },
    ]);
    expect(data.credentials.calendarFeed).toEqual({ issuedAt: AT, rotatedAt: AT });
    expect(data.adminAccess).toEqual([{ scope: 'overview', at: AT }]);
    expect(data.adminActions).toEqual([{ action: 'passport_made_private', at: AT }]);

    // Every statement is about THIS account: each binds the subject id.
    for (const statement of db.statements) {
      expect(statement.params, statement.sql).toContain(USER);
    }
  });

  it('is complete: no statement is capped', async () => {
    const db = routedDb();
    await buildAccountExport(db, USER, new Date(AT));
    for (const statement of db.statements) {
      expect(statement.sql, statement.sql).not.toMatch(/\bLIMIT\b/i);
    }
  });

  it('contains no credential and no coordinate, and says what it withheld', async () => {
    const data = await buildAccountExport(routedDb(), USER, new Date(AT));
    const keys = allKeys(data);
    for (const forbidden of ['token', 'password', 'hash', 'geom', 'heart', 'calories', 'ip']) {
      expect(
        keys.filter((key) => key === forbidden || key.endsWith(forbidden)),
        `export carries a "${forbidden}" key`,
      ).toEqual([]);
    }
    expect(data?.withheld).toEqual(EXPORT_WITHHELD);
    expect(EXPORT_WITHHELD).toEqual(
      expect.arrayContaining([
        'session_tokens',
        'calendar_feed_token',
        'training_route_geometry',
        'training_heart_rate_and_calories',
      ]),
    );
  });

  it('carries the suspension, reason included, when there is one', async () => {
    const db = routedDb();
    const original = db.execute.bind(db);
    db.execute = async (query: SQL) => {
      const result = await original(query);
      const row = result.rows[0];
      if (row && 'suspended_reason' in row) {
        row.suspended_at = AT;
        row.suspended_reason = 'спам';
        row.profile_visibility = 'private';
      }
      return result;
    };
    const data = await buildAccountExport(db, USER, new Date(AT));
    // Art. 15: the member is entitled to what is recorded about them.
    expect(data?.account.suspension).toEqual({ since: AT, reason: 'спам' });
  });
});

describe('the export as a file', () => {
  it('names the file from the date and a sanitised id, never from what the member typed', () => {
    const now = new Date(AT);
    expect(accountExportFilename(now)).toBe('pops-account-2026-09-01.json');
    expect(accountExportFilename(now, 'abc"; evil\r\n')).toBe(
      'pops-account-abcevil-2026-09-01.json',
    );
  });

  it('is an attachment that no cache may keep', async () => {
    const data = await buildAccountExport(routedDb(), USER, new Date(AT));
    if (!data) throw new Error('expected an export');
    const response = accountExportResponse(data, 'pops-account-2026-09-01.json');
    expect(response.headers.get('Content-Disposition')).toBe(
      'attachment; filename="pops-account-2026-09-01.json"',
    );
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Content-Type')).toMatch(/^application\/json/);
    const parsed = (await response.json()) as { account: { id: string } };
    expect(parsed.account.id).toBe(USER);
  });
});
