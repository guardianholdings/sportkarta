import { renderSql, type SQL } from '@sportkarta/db';
import { contentNoticeCategory } from '@sportkarta/db/schema';
import { describe, expect, it } from 'vitest';

import {
  NOTICE_CATEGORIES,
  parseNotice,
  parseNoticeUrl,
  prefillPath,
  type NoticeFields,
} from '@/lib/notice-input';
import { decideNotice, insertNotice } from '@/lib/notices';

/**
 * The public notice form (/signal — DSA Art. 16) at the parsing and statement
 * level. The database half (CHECKs, the guard trigger, retention) is proven
 * against Postgres in db/src/content-notices.test.ts.
 */

const VALID: NoticeFields = {
  url: 'https://pops.bg/pasport/abc',
  category: 'abuse',
  explanation: 'Обидно име.',
  name: '',
  email: '',
  goodFaith: 'on',
};

function parse(overrides: Partial<NoticeFields> = {}) {
  return parseNotice({ ...VALID, ...overrides });
}

function fakeDb(rows: Record<string, unknown>[] = []) {
  const statements: { sql: string; params: unknown[] }[] = [];
  return {
    statements,
    execute(query: SQL) {
      statements.push(renderSql(query));
      return Promise.resolve({ rows });
    },
  };
}

describe('NOTICE_CATEGORIES', () => {
  it('is exactly the database enum, so every choice the form offers can be stored', () => {
    expect([...NOTICE_CATEGORIES]).toEqual(contentNoticeCategory.enumValues);
  });
});

describe('parseNoticeUrl', () => {
  it('accepts an absolute http(s) URL and a site path', () => {
    expect(parseNoticeUrl(' https://pops.bg/obekt/x ')).toBe('https://pops.bg/obekt/x');
    expect(parseNoticeUrl('http://example.org/a?b=c')).toBe('http://example.org/a?b=c');
    expect(parseNoticeUrl('/pasport/abc')).toBe('/pasport/abc');
  });

  it('refuses every scheme the admin queue could render as something live', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:text/html,<b>x</b>',
      '//evil.example/x',
      'ftp://example.org/x',
      'pops.bg/x',
      '',
    ]) {
      expect(parseNoticeUrl(bad), bad).toBeNull();
    }
  });

  it("refuses a site path that smuggles in somebody else's host", () => {
    for (const bad of [
      // An embedded URL: no POPS path has one, and a mail client links it.
      '/https://evil.example/pops-login',
      '/pasport/x?next=https://evil.example/',
      // A browser reads `\` as `/`: these ARE protocol-relative links.
      '/\\evil.example/login',
      '/\\/evil.example',
      '\\\\evil.example',
      // And in an absolute URL the host a reader sees is not the one opened.
      'https://evil.example\\@pops.bg/',
      // A scheme `new URL` would forgive, but not one a URL is written with.
      'https:evil.example/x',
    ]) {
      expect(parseNoticeUrl(bad), bad).toBeNull();
      expect(prefillPath(bad), bad).toBe('');
    }
  });

  it('keeps an absolute URL whole, embedded URL and all — it is only ever shown to the admin', () => {
    // Never mailed (the notice mails carry no URL at all), and rendered in the
    // admin queue as a link to the host it plainly names.
    expect(parseNoticeUrl('https://pops.bg/?r=https://evil.example/x')).toBe(
      'https://pops.bg/?r=https://evil.example/x',
    );
    expect(parseNoticeUrl('HTTPS://pops.bg/obekt/x')).toBe('HTTPS://pops.bg/obekt/x');
  });

  it('refuses whitespace and control characters — no smuggled second line', () => {
    expect(parseNoticeUrl('/a b')).toBeNull();
    expect(parseNoticeUrl('/a\nSubject: x')).toBeNull();
    expect(parseNoticeUrl(`/${'a'.repeat(600)}`)).toBeNull();
  });
});

describe('prefillPath', () => {
  it('pre-fills only a same-site path, never an outside URL', () => {
    expect(prefillPath('/pasport/abc')).toBe('/pasport/abc');
    expect(prefillPath('https://evil.example/x')).toBe('');
    expect(prefillPath('//evil.example/x')).toBe('');
    expect(prefillPath(undefined)).toBe('');
    expect(prefillPath(['/a', '/b'])).toBe('');
  });
});

describe('parseNotice', () => {
  it('accepts an anonymous notice — contact is optional by design', () => {
    const result = parse();
    expect(result).toEqual({
      ok: true,
      value: {
        targetUrl: 'https://pops.bg/pasport/abc',
        category: 'abuse',
        explanation: 'Обидно име.',
        notifierName: null,
        notifierEmail: null,
      },
    });
  });

  it('keeps a name and a reply address when given', () => {
    const result = parse({ name: '  Иван   Петров ', email: ' ivan@example.org ' });
    expect(result.ok && result.value).toMatchObject({
      notifierName: 'Иван Петров',
      notifierEmail: 'ivan@example.org',
    });
  });

  it('requires the statement of good faith (Art. 16(2)(d))', () => {
    expect(parse({ goodFaith: undefined })).toEqual({ ok: false, problem: 'goodFaith' });
    expect(parse({ goodFaith: 'off' })).toEqual({ ok: false, problem: 'goodFaith' });
  });

  it('names the field that is wrong', () => {
    expect(parse({ url: 'javascript:x' })).toEqual({ ok: false, problem: 'url' });
    expect(parse({ category: 'defamation' })).toEqual({ ok: false, problem: 'category' });
    expect(parse({ explanation: '   ' })).toEqual({ ok: false, problem: 'explanation' });
    expect(parse({ explanation: 'x'.repeat(2001) })).toEqual({ ok: false, problem: 'explanation' });
    expect(parse({ name: 'x'.repeat(121) })).toEqual({ ok: false, problem: 'name' });
    expect(parse({ email: 'not-an-address' })).toEqual({ ok: false, problem: 'email' });
  });

  it('ignores non-string input rather than coercing it', () => {
    expect(parse({ url: ['https://pops.bg'] })).toEqual({ ok: false, problem: 'url' });
    expect(parse({ category: 7 })).toEqual({ ok: false, problem: 'category' });
  });
});

describe('insertNotice', () => {
  it('stores the notice with the good-faith statement set, and nothing else', async () => {
    const db = fakeDb([{ id: '11111111-1111-4111-8111-111111111111' }]);
    const parsed = parse({ email: 'ivan@example.org' });
    if (!parsed.ok) throw new Error('fixture');
    const id = await insertNotice(db, parsed.value);

    expect(id).toBe('11111111-1111-4111-8111-111111111111');
    const [insert] = db.statements;
    expect(insert?.sql).toMatch(/INSERT INTO content_notices/i);
    expect(insert?.params).toContain('ivan@example.org');
    // No IP, no user agent, no account: only what the form asked for.
    expect(insert?.sql).not.toMatch(/ip_address|user_agent|user_id/i);
  });
});

describe('decideNotice', () => {
  const ID = '11111111-1111-4111-8111-111111111111';

  it('checks the admin role INSIDE the statement, against the database', async () => {
    const db = fakeDb([{ has_contact: true }]);
    const result = await decideNotice(db, 'user_admin', ID, 'actioned', 'illegal_content');

    expect(result).toEqual({ applied: true, notify: true });
    const [update] = db.statements;
    expect(update?.sql).toMatch(/status = 'pending'/);
    expect(update?.sql).toMatch(/role = 'admin'/);
    expect(update?.params).toContain('illegal_content');
  });

  it('refuses a reason that does not belong to the outcome, before any statement', async () => {
    const db = fakeDb([{ has_contact: true }]);
    // "not_illegal" explains a dismissal, never an action.
    expect(await decideNotice(db, 'user_admin', ID, 'actioned', 'not_illegal')).toEqual({
      applied: false,
      notify: false,
    });
    expect(await decideNotice(db, 'user_admin', ID, 'dismissed', undefined)).toEqual({
      applied: false,
      notify: false,
    });
    expect(db.statements).toHaveLength(0);
  });

  it('reports nothing applied when the notice was already decided or the actor is no admin', async () => {
    const db = fakeDb([]);
    expect(await decideNotice(db, 'user_amb', ID, 'dismissed', 'not_illegal')).toEqual({
      applied: false,
      notify: false,
    });
  });
});
