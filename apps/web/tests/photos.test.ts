import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { publicFacilityVisible, renderSql, type SQL } from '@sportkarta/db';
import { describe, expect, it } from 'vitest';

import type { ModerationActor } from '@/lib/moderation';
import { photoUrl } from '@/lib/photo-url';
import {
  parsePhotoLookup,
  photoResponseHeaders,
  photosLookupClause,
  PHOTO_PUBLIC,
  resolveServablePhoto,
} from '@/lib/photos';

/**
 * Facility photo serving (lib/photos.ts, app/api/photos/[id]).
 *
 * The property that matters is WHO GETS WHICH FILE, and it is asserted at the
 * statement level: the public branch must carry both the approval and the
 * shared facility-visibility predicate, the moderator branch must carry the
 * moderation scope, and nobody else gets a second query at all. The DB-backed
 * companion is db/src/moderation-authz.test.ts.
 */

const PHOTO = '6f1c2a9e-4b7d-4c3e-9a51-0d2e8f7b6a10';
const STORED = 'facilities/2026/09/6f1c2a9e-4b7d-4c3e-9a51-0d2e8f7b6a10.webp';
const AMBASSADOR: ModerationActor = { id: 'user_amb', role: 'ambassador' };
const ADMIN: ModerationActor = { id: 'user_admin', role: 'admin' };
const MEMBER: ModerationActor = { id: 'user_plain', role: 'user' };

function fakeDb(responses: Record<string, unknown>[][]) {
  const statements: { sql: string; params: unknown[] }[] = [];
  const queue = [...responses];
  return {
    statements,
    execute(query: SQL) {
      statements.push(renderSql(query));
      return Promise.resolve({ rows: queue.shift() ?? [] });
    },
  };
}

/** A viewer callback that records whether the session was consulted at all. */
function viewer(actor: ModerationActor | null) {
  const calls = { n: 0 };
  return {
    calls,
    resolve: () => {
      calls.n += 1;
      return Promise.resolve(actor);
    },
  };
}

describe('PHOTO_PUBLIC', () => {
  it('is approval AND the shared facility-visibility predicate', () => {
    // A photo must not be public while its facility is not — the same
    // predicate the map, the facility pages and the open-data export use.
    const rendered = renderSql(PHOTO_PUBLIC).sql;
    expect(rendered).toContain("p.status = 'approved'");
    expect(rendered).toContain(renderSql(publicFacilityVisible).sql);
  });
});

describe('resolveServablePhoto', () => {
  it('serves an approved photo to anyone without touching the session', async () => {
    const db = fakeDb([[{ storage_path: STORED }]]);
    const v = viewer(null);
    expect(await resolveServablePhoto(db, PHOTO, v.resolve)).toEqual({
      storagePath: STORED,
      audience: 'public',
    });
    expect(v.calls.n).toBe(0);
    expect(db.statements).toHaveLength(1);
    expect(db.statements[0]?.sql).toContain(renderSql(PHOTO_PUBLIC).sql);
    expect(db.statements[0]?.params).toContain(PHOTO);
  });

  it('gives an anonymous visitor nothing for a photo that is not public', async () => {
    const db = fakeDb([[]]);
    expect(await resolveServablePhoto(db, PHOTO, viewer(null).resolve)).toBeNull();
    // No second, unscoped query — the refusal happens before any is built.
    expect(db.statements).toHaveLength(1);
  });

  it('gives a signed-in member no more than a visitor', async () => {
    const db = fakeDb([[]]);
    expect(await resolveServablePhoto(db, PHOTO, viewer(MEMBER).resolve)).toBeNull();
    expect(db.statements).toHaveLength(1);
  });

  it('serves a pending photo to an ambassador only through the scope predicate', async () => {
    const db = fakeDb([[], [{ storage_path: STORED }]]);
    expect(await resolveServablePhoto(db, PHOTO, viewer(AMBASSADOR).resolve)).toEqual({
      storagePath: STORED,
      audience: 'moderator',
    });
    const scoped = db.statements[1];
    expect(scoped?.sql).toMatch(/ambassador_municipalities/);
    expect(scoped?.params).toEqual([PHOTO, AMBASSADOR.id]);
    // The moderator branch deliberately has no status filter: a moderator may
    // look at pending, approved and rejected photos alike — inside scope.
    expect(scoped?.sql).not.toContain("p.status = 'approved'");
  });

  it('returns nothing when the photo is outside the ambassador’s scope', async () => {
    const db = fakeDb([[], []]);
    expect(await resolveServablePhoto(db, PHOTO, viewer(AMBASSADOR).resolve)).toBeNull();
  });

  it('lets an admin see any photo', async () => {
    const db = fakeDb([[], [{ storage_path: STORED }]]);
    const photo = await resolveServablePhoto(db, PHOTO, viewer(ADMIN).resolve);
    expect(photo?.audience).toBe('moderator');
    expect(db.statements[1]?.sql).toMatch(/AND\s+TRUE/);
  });

  it('refuses anything that is not a photo id before querying', async () => {
    for (const id of ['../../etc/passwd', 'facilities/2026/09/x.webp', '1', '']) {
      const db = fakeDb([]);
      expect(await resolveServablePhoto(db, id, viewer(ADMIN).resolve), id).toBeNull();
      expect(db.statements, id).toHaveLength(0);
    }
  });
});

describe('photoResponseHeaders', () => {
  it('caches a public photo briefly, so a takedown takes effect within the hour', () => {
    const headers = photoResponseHeaders('public');
    expect(headers['Cache-Control']).toBe('public, max-age=3600');
    expect(headers['Cache-Control']).not.toMatch(/stale|immutable/);
    expect(headers['Content-Type']).toBe('image/webp');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
  });

  it('never stores an unreviewed photo in any cache', () => {
    expect(photoResponseHeaders('moderator')['Cache-Control']).toBe('private, no-store');
  });
});

describe('parsePhotoLookup', () => {
  it('reads a photo address, an admin facility address or a bare id as an id', () => {
    const expected = { kind: 'id', id: PHOTO };
    expect(parsePhotoLookup(`https://pops.bg/api/photos/${PHOTO}`)).toEqual(expected);
    expect(parsePhotoLookup(`https://pops.bg/admin/facilities/${PHOTO}`)).toEqual(expected);
    expect(parsePhotoLookup(`  ${PHOTO.toUpperCase()} `)).toEqual(expected);
  });

  it('reads a public facility address, in either locale, or a bare slug as a slug', () => {
    const expected = { kind: 'slug', slug: 'igrishte-borisova-gradina' };
    expect(parsePhotoLookup('https://pops.bg/obekt/igrishte-borisova-gradina')).toEqual(expected);
    expect(parsePhotoLookup('https://pops.bg/en/obekt/igrishte-borisova-gradina?x=1')).toEqual(
      expected,
    );
    expect(parsePhotoLookup('igrishte-borisova-gradina')).toEqual(expected);
  });

  it('distinguishes an empty box from text that names nothing', () => {
    expect(parsePhotoLookup('   ')).toBeNull();
    expect(parsePhotoLookup('детска площадка')).toBe('invalid');
    expect(parsePhotoLookup("x' OR 1=1 --")).toBe('invalid');
    expect(parsePhotoLookup('a'.repeat(501))).toBe('invalid');
  });
});

describe('photosLookupClause', () => {
  it('binds the lookup as a parameter and matches a photo id or a facility id', () => {
    const rendered = renderSql(photosLookupClause({ kind: 'id', id: PHOTO }));
    expect(rendered.sql).toMatch(/p\.id = .* OR p\.facility_id = /);
    expect(rendered.params).toEqual([PHOTO, PHOTO]);
    expect(renderSql(photosLookupClause({ kind: 'slug', slug: 'a-b' })).params).toEqual(['a-b']);
    expect(renderSql(photosLookupClause(null)).sql.trim()).toBe('TRUE');
  });
});

describe('photo addresses', () => {
  it('names a photo by its row id, under the row-deciding route', () => {
    expect(photoUrl(PHOTO)).toBe(`/api/photos/${PHOTO}`);
  });

  const WEB = process.cwd();
  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) out.push(...sources(full));
      else if (/\.(ts|tsx)$/.test(name)) out.push(full);
    }
    return out;
  }

  it('never builds a path-based /uploads URL anywhere in the app', () => {
    // Nothing serves /uploads, and nothing must: a path mount would publish
    // every pending upload at once. A page that went back to `/uploads/${key}`
    // would render a broken image today and a privacy incident tomorrow.
    const offenders = ['app', 'components', 'lib']
      .flatMap((dir) => sources(path.join(WEB, dir)))
      .filter((file) => /['"`]\/uploads\b/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(WEB, file));
    expect(offenders).toEqual([]);
  });

  it('lists on the facility page exactly what the route will serve', () => {
    // A list wider than the route is a broken image on a public page; a list
    // that exposed keys would invite somebody to serve them by path. (The route
    // itself is exercised in photo-route.test.ts.)
    const publicData = readFileSync(path.join(WEB, 'lib/public-data.ts'), 'utf8');
    expect(publicData).toMatch(
      /FROM facility_photos p\s+WHERE p\.facility_id = f\.id AND \$\{PHOTO_PUBLIC\}/,
    );
    expect(publicData).not.toMatch(/storage_path/);
  });
});
