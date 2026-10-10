import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SQL } from '@sportkarta/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { dashboardCounts, isUuid, listImportJobs, municipalityOptionsFor } from '@/lib/admin-data';
import { moderationSla, queuePhotos } from '@/lib/moderation-data';

/**
 * Three small admin defects from the pre-launch audit, each with the behaviour
 * that now holds:
 *
 *  - the dashboard tiles are SCOPED like the queues they summarise, so an
 *    ambassador is no longer told about pending photos they cannot see;
 *  - the photo queue names the uploader instead of printing a raw account id;
 *  - a mistyped results-editor URL is a 404, not a Postgres cast error.
 *
 * The two data functions read through `getDb()`, so the database is replaced
 * with a recorder that renders each statement and answers from a queue.
 */

const db = vi.hoisted(() => ({
  statements: [] as { sql: string; params: unknown[] }[],
  answers: [] as Record<string, unknown>[][],
}));

vi.mock('@sportkarta/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sportkarta/db')>();
  return {
    ...actual,
    getDb: () => ({
      execute(query: SQL) {
        db.statements.push(actual.renderSql(query));
        return Promise.resolve({ rows: db.answers.shift() ?? [] });
      },
    }),
  };
});

afterEach(() => {
  db.statements.length = 0;
  db.answers.length = 0;
});

describe('dashboardCounts is scoped to the actor', () => {
  it("an admin's tiles stay national", async () => {
    db.answers.push([{ active: 5, needs_verification: 2, gone: 1, pending_photos: 3 }]);
    const counts = await dashboardCounts({ id: 'user_admin', role: 'admin' });
    expect(counts).toMatchObject({ active: 5, needsVerification: 2, gone: 1, pendingPhotos: 3 });
    const [statement] = db.statements;
    expect(statement?.sql).not.toMatch(/ambassador_municipalities/);
    expect(statement?.sql).toMatch(/\(SELECT count\(\*\) FROM municipalities\) AS municipalities/);
    expect(statement?.params).not.toContain('user_admin');
  });

  it("an ambassador's facility AND photo counts carry their municipalities", async () => {
    await dashboardCounts({ id: 'user_amb', role: 'ambassador' });
    const [statement] = db.statements;
    // Twice: once for the facility tiles, once inside the pending-photo count —
    // the tile the audit caught announcing photos from the whole country.
    expect(statement?.sql.match(/FROM ambassador_municipalities WHERE user_id/g)).toHaveLength(2);
    // …and a third time for the municipalities tile, which counts their own
    // rather than the country's (UX audit 2026-10-10, A-16).
    expect(statement?.params.filter((p) => p === 'user_amb')).toHaveLength(3);
    expect(statement?.sql).toMatch(
      /\(SELECT count\(\*\) FROM ambassador_municipalities am WHERE am\.user_id = \$\d+\) AS municipalities/,
    );
    expect(statement?.sql).not.toMatch(/FROM municipalities\)/);
    expect(statement?.sql).toMatch(
      /FROM facility_photos p\s+JOIN facilities f ON f\.id = p\.facility_id\s+WHERE p\.status = 'pending' AND f\.municipality_id IN/,
    );
  });

  it('a plain member counts nothing, even if the gate were bypassed', async () => {
    await dashboardCounts({ id: 'user_1', role: 'user' });
    expect(db.statements[0]?.sql.match(/FALSE/g)).toHaveLength(2);
  });
});

describe('municipality filters offer what the actor can see (A-16)', () => {
  it('lists every municipality for an admin', async () => {
    db.answers.push([{ id: 1, name_bg: 'Банско' }]);
    expect(await municipalityOptionsFor({ id: 'user_admin', role: 'admin' })).toEqual([
      { id: 1, nameBg: 'Банско' },
    ]);
    expect(db.statements[0]?.sql).not.toMatch(/ambassador_municipalities/);
  });

  it("lists only an ambassador's own, and nothing for a scopeless one", async () => {
    db.answers.push([{ id: 68, name_bg: 'Столична' }], []);
    expect(await municipalityOptionsFor({ id: 'user_amb', role: 'ambassador' })).toEqual([
      { id: 68, nameBg: 'Столична' },
    ]);
    expect(await municipalityOptionsFor({ id: 'user_new', role: 'ambassador' })).toEqual([]);
    expect(db.statements[0]?.sql).toMatch(/FROM ambassador_municipalities am/);
    expect(db.statements[0]?.params).toContain('user_amb');
  });

  it('asks nothing for a plain member', async () => {
    expect(await municipalityOptionsFor({ id: 'user_1', role: 'user' })).toEqual([]);
    expect(db.statements).toHaveLength(0);
  });
});

describe('the SLA panel measures the crowd queue (A-7)', () => {
  it('counts the import backlog apart and keeps it out of the oldest item and the median', async () => {
    db.answers.push(
      [
        {
          pending_photos: 1,
          pending_reports: 2,
          pending_facilities: 3,
          import_backlog: 6900,
          oldest_pending_hours: 5,
        },
      ],
      [{ decisions: 4, median_hours: 2 }],
    );
    const sla = await moderationSla({ id: 'user_admin', role: 'admin' });
    expect(sla).toMatchObject({
      pendingFacilities: 3,
      importBacklog: 6900,
      oldestPendingHours: 5,
      medianHours: 2,
    });

    const [depth, timing] = db.statements;
    const text = depth?.sql ?? '';
    // Three facility predicates: the queue and the oldest item are crowd-only,
    // the backlog is everything else.
    expect(text.match(/f\.status = 'needs_verification'/g)).toHaveLength(3);
    expect(text.match(/needs_verification' AND f\.source = 'crowd'/g)).toHaveLength(2);
    expect(text).toMatch(/needs_verification' AND f\.source <> 'crowd'[\s\S]*?AS import_backlog/);
    // A verify-deck decision about an imported facility stays out of the median.
    expect(timing?.sql).toMatch(
      /NOT EXISTS \(\s*SELECT 1 FROM facilities f\s*WHERE d\.target_type = 'facility' AND f\.id = d\.facility_id AND f\.source <> 'crowd'/,
    );
  });
});

describe('the OSM import list names who queued it (A-17)', () => {
  it('resolves the account to a name, and returns Sofia-formattable ISO times', async () => {
    db.answers.push([
      {
        id: 'j1',
        state: 'completed',
        data: { dryRun: false, actor: 'user_1' },
        created_on: new Date('2026-10-09T22:30:00Z'),
        completed_on: new Date('2026-10-09T22:41:00Z'),
        actor_display_name: 'Мария',
        actor_email: 'maria@example.org',
      },
      {
        id: 'j2',
        state: 'failed',
        data: { actor: 'user_gone' },
        created_on: '2026-10-01T10:00:00.000Z',
        completed_on: null,
        actor_display_name: null,
        actor_email: null,
      },
    ]);
    const jobs = await listImportJobs();

    expect(db.statements[0]?.sql).toMatch(/LEFT JOIN users u ON u\.id = jobs\.data ->> 'actor'/);
    expect(jobs[0]).toMatchObject({
      actor: 'user_1',
      actorName: 'Мария',
      dryRun: false,
      createdOn: '2026-10-09T22:30:00.000Z',
      completedOn: '2026-10-09T22:41:00.000Z',
    });
    // An erased account keeps its row and loses its name.
    expect(jobs[1]).toMatchObject({ actor: 'user_gone', actorName: null, dryRun: true });
  });
});

describe('the photo queue names the uploader', () => {
  it('resolves the display name, and tells an erased uploader from a nameless one', async () => {
    const base = {
      facility_id: 'f1',
      facility_name: 'Парк',
      municipality_name: 'Пловдив',
      created_at: '2026-09-01T10:00:00.000Z',
      flags: [],
    };
    db.answers.push([
      { ...base, id: 'p1', uploaded_by: 'user_1', uploader_name: 'Мария' },
      { ...base, id: 'p2', uploaded_by: 'user_2', uploader_name: '  ' },
      { ...base, id: 'p3', uploaded_by: null, uploader_name: null },
    ]);
    const photos = await queuePhotos({ id: 'user_admin', role: 'admin' });

    expect(db.statements[0]?.sql).toMatch(/LEFT JOIN users u ON u\.id = p\.uploaded_by/);
    // A nameless member keeps their account id (the page says «profile without
    // a name»); only an erased or anonymous uploader loses it.
    expect(photos.map((photo) => [photo.uploadedBy, photo.uploaderName])).toEqual([
      ['user_1', 'Мария'],
      ['user_2', null],
      [null, null],
    ]);
  });

  it('never prints the raw account id, and links to the account for admins only', () => {
    const page = readFileSync(
      join(__dirname, '..', 'app', '[locale]', 'admin', '(protected)', 'moderation', 'page.tsx'),
      'utf8',
    );
    // The old rendering interpolated the id into the text.
    expect(page).not.toMatch(/who:\s*photo\.uploadedBy/);
    // /admin/akaunti is admin-only; an ambassador gets the name without a link
    // that would only 404 for them.
    const link = page.indexOf('href={`/admin/akaunti/${photo.uploadedBy}`}');
    expect(link).toBeGreaterThan(-1);
    expect(page.lastIndexOf("user.role === 'admin'", link)).toBeGreaterThan(-1);
  });
});

describe('the results editor refuses a malformed id before querying', () => {
  it('recognises a uuid and nothing else', () => {
    expect(isUuid('0b9f5a52-7d0c-4c3e-9f1e-2a6b8c4d5e6f')).toBe(true);
    for (const value of [
      '',
      'abc',
      '0b9f5a52-7d0c-4c3e-9f1e-2a6b8c4d5e6f/x',
      ' 0b9f5a52-7d0c-4c3e-9f1e-2a6b8c4d5e6f',
    ]) {
      expect(isUuid(value), value).toBe(false);
    }
  });

  it('calls notFound() on a non-uuid before the first ::uuid cast', () => {
    const page = readFileSync(
      join(
        __dirname,
        '..',
        'app',
        '[locale]',
        'admin',
        '(protected)',
        'rezultati',
        '[occurrenceId]',
        'page.tsx',
      ),
      'utf8',
    );
    const guard = page.indexOf('if (!isUuid(occurrenceId)) notFound();');
    expect(guard).toBeGreaterThan(-1);
    expect(page.indexOf('::uuid')).toBeGreaterThan(guard);
    expect(page.indexOf('getDb()')).toBeGreaterThan(guard);
  });
});
