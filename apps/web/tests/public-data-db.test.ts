import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { municipalityAccountability } from '../lib/accountability';
import {
  LIST_PAGE_SIZE,
  scopedFacilities,
  scopedFacilityCount,
  scopedMapPoints,
} from '../lib/places';
import { getFacilityBySlug } from '../lib/public-data';

/**
 * The public read layer against a real Postgres: the reconciliation the
 * municipality page promises ("count the pins on /igrishta/[city] and get the
 * number this page shows"), the facility page's visibility, and the two
 * derived facts the page prints — «Последна проверка» and "covered".
 *
 * Requires DATABASE_URL (skips otherwise, like db/src). Every test runs in ONE
 * transaction that is rolled back: facility_edits is append-only and audited
 * facilities cannot be deleted, so committed fixtures would be permanent. The
 * app's getDb() is pointed at that transaction's connection, which is the only
 * way the production functions can see uncommitted fixtures.
 */

const url = process.env.DATABASE_URL;

const conn = vi.hoisted(() => ({ client: null as pg.Client | null }));

vi.mock('@sportkarta/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sportkarta/db')>();
  return {
    ...actual,
    getDb: () => ({
      async execute(query: Parameters<typeof actual.renderSql>[0]) {
        if (!conn.client) throw new Error('test client not connected');
        const { sql, params } = actual.renderSql(query);
        const result = await conn.client.query(sql, params);
        return { rows: result.rows as Record<string, unknown>[] };
      },
    }),
  };
});

describe.skipIf(!url)('public read layer (requires running database)', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: url });
    await client.connect();
    conn.client = client;
  });

  afterAll(async () => {
    conn.client = null;
    await client.end();
  });

  /** Runs `body` inside a transaction that is always rolled back. */
  async function inRollback(body: () => Promise<void>): Promise<void> {
    await client.query('BEGIN');
    try {
      await body();
    } finally {
      await client.query('ROLLBACK');
    }
  }

  async function setShowPaid(value: boolean): Promise<void> {
    await client.query(
      `INSERT INTO app_settings (key, value) VALUES ('public_show_paid', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [String(value)],
    );
  }

  async function municipality(): Promise<{
    id: number;
    slug: string;
    nameBg: string;
    nameEn: string;
  }> {
    // A code no register municipality uses, on a box inside the facilities
    // CHECK's Bulgarian envelope. Facilities are pinned to it by id below.
    const code = `T${randomUUID().slice(0, 4).toUpperCase()}`;
    const result = await client.query<{ id: number }>(
      `INSERT INTO municipalities (ekatte_code, name_bg, name_en, geom)
       VALUES ($1, 'Testova', 'Testova', ST_Multi(ST_MakeEnvelope(25.0, 42.0, 25.01, 42.01, 4326)))
       RETURNING id`,
      [code],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error('municipality INSERT returned no row');
    return { id, slug: 'testova', nameBg: 'Testova', nameEn: 'Testova' };
  }

  async function business(visible: boolean): Promise<number> {
    const result = await client.query<{ id: number }>(
      `INSERT INTO businesses (name, normalized_key, visible) VALUES ('Test Gym', $1, $2) RETURNING id`,
      [`test-gym-${randomUUID()}`, visible],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error('business INSERT returned no row');
    return Number(id);
  }

  interface FacilityFixture {
    municipalityId: number;
    access?: 'free' | 'paid' | 'restricted' | 'school';
    status?: 'active' | 'needs_verification' | 'gone';
    slugged?: boolean;
    businessId?: number | null;
    covered?: boolean;
    attrs?: Record<string, unknown>;
    name?: string | null;
  }

  /** Inserts a crowd-source facility; returns its slug ('' when unslugged). */
  async function facility(f: FacilityFixture): Promise<{ id: string; slug: string }> {
    const slug = f.slugged === false ? null : `test-${randomUUID().slice(0, 12)}`;
    const result = await client.query<{ id: string }>(
      `INSERT INTO facilities
         (geom, slug, sport_types, access, status, source, municipality_id, business_id,
          covered, attrs, name)
       VALUES (ST_SetSRID(ST_MakePoint(25.005, 42.005), 4326), $1, '{football}', $2, $3,
               'crowd', $4, $5, $6, $7::jsonb, $8)
       RETURNING id`,
      [
        slug,
        f.access ?? 'free',
        f.status ?? 'active',
        f.municipalityId,
        f.businessId ?? null,
        f.covered ?? false,
        JSON.stringify(f.attrs ?? {}),
        f.name ?? null,
      ],
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error('facility INSERT returned no row');
    return { id, slug: slug ?? '' };
  }

  async function edit(
    facilityId: string,
    field: string,
    actor: string | null,
    newValue: unknown,
    ageDays: number,
    source: 'crowd' | 'osm' | 'municipal' = 'crowd',
  ): Promise<void> {
    await client.query(
      `INSERT INTO facility_edits (facility_id, actor, source, field, new_value, created_at)
       VALUES ($1, $2, $6, $3, $4::jsonb, now() - make_interval(days => $5))`,
      [facilityId, actor, field, JSON.stringify(newValue), ageDays, source],
    );
  }

  it('the accountability total equals the /igrishta count, paid gate included', async () => {
    await inRollback(async () => {
      const city = await municipality();
      const hidden = await business(false);
      await facility({ municipalityId: city.id, access: 'free' });
      await facility({ municipalityId: city.id, access: 'school', status: 'needs_verification' });
      await facility({ municipalityId: city.id, status: 'gone' });
      await facility({ municipalityId: city.id, slugged: false });
      await facility({ municipalityId: city.id, access: 'paid' });
      await facility({ municipalityId: city.id, access: 'paid', businessId: hidden });

      // Switch off (the default): no paid row is public anywhere.
      await setShowPaid(false);
      expect(await scopedFacilityCount(city.id)).toBe(2);
      const off = await municipalityAccountability(city);
      expect(off.total).toBe(2);
      expect(off.free).toBe(1);

      // Switch on: the business-less paid row appears; the hidden business's does not.
      await setShowPaid(true);
      const pins = await scopedFacilityCount(city.id);
      expect(pins).toBe(3);
      expect((await municipalityAccountability(city)).total).toBe(pins);
    });
  });

  it('the list pages partition the scope and the map carries all of it', async () => {
    await inRollback(async () => {
      const city = await municipality();
      // One page and one row over, with duplicate and missing names — the
      // cases where an order that is not total would repeat or drop a row
      // across the page boundary.
      const slugs: string[] = [];
      for (let i = 0; i <= LIST_PAGE_SIZE; i += 1) {
        const name = i % 3 === 0 ? null : `Игрище ${String(i % 7)}`;
        slugs.push((await facility({ municipalityId: city.id, name })).slug);
      }
      await facility({ municipalityId: city.id, status: 'gone', name: 'Изчезнало' });

      expect(await scopedFacilityCount(city.id)).toBe(LIST_PAGE_SIZE + 1);
      const first = await scopedFacilities(city.id, {}, 1);
      const second = await scopedFacilities(city.id, {}, 2);
      expect(first).toHaveLength(LIST_PAGE_SIZE);
      expect(second).toHaveLength(1);
      expect(await scopedFacilities(city.id, {}, 3)).toHaveLength(0);
      const listed = [...first, ...second].map((row) => row.slug);
      expect(new Set(listed).size).toBe(listed.length);
      expect([...listed].sort()).toEqual([...slugs].sort());

      const map = (await scopedMapPoints(city.id)).map((row) => row.slug);
      expect([...map].sort()).toEqual([...slugs].sort());
    });
  });

  it('a hidden business has no facility page, whatever the master switch says', async () => {
    await inRollback(async () => {
      const city = await municipality();
      const visibleGym = await facility({
        municipalityId: city.id,
        access: 'paid',
        businessId: await business(true),
      });
      const hiddenGym = await facility({
        municipalityId: city.id,
        access: 'paid',
        businessId: await business(false),
      });

      await setShowPaid(true);
      expect(await getFacilityBySlug(visibleGym.slug)).not.toBeNull();
      expect(await getFacilityBySlug(hiddenGym.slug)).toBeNull();

      await setShowPaid(false);
      expect(await getFacilityBySlug(visibleGym.slug)).toBeNull();
    });
  });

  it('dates «last checked» from verification evidence, not from claims or complaints', async () => {
    await inRollback(async () => {
      const city = await municipality();
      const f = await facility({ municipalityId: city.id, status: 'needs_verification' });
      await edit(f.id, 'created', 'user_adder', { name: null }, 1);
      await edit(f.id, 'reported_missing', 'user_doubter', true, 1);
      await edit(f.id, 'condition', 'user_remote', 'poor', 1);
      await edit(f.id, 'status', 'user_mod', 'needs_verification', 1);

      const unchecked = await getFacilityBySlug(f.slug);
      expect(unchecked?.lastVerifiedAt).toBeNull();
      expect(unchecked?.status).toBe('needs_verification');

      // A confirmation ten days ago dates the check, even though newer
      // non-evidence rows exist.
      await edit(f.id, 'verified', 'user_checker', true, 10);
      const checked = await getFacilityBySlug(f.slug);
      const ageDays =
        (Date.now() - new Date(String(checked?.lastVerifiedAt)).getTime()) / 86_400_000;
      expect(ageDays).toBeGreaterThan(9);
      expect(ageDays).toBeLessThan(11);

      // Publication counts too.
      await edit(f.id, 'status', 'user_mod', 'active', 3);
      const published = await getFacilityBySlug(f.slug);
      const publishedAge =
        (Date.now() - new Date(String(published?.lastVerifiedAt)).getTime()) / 86_400_000;
      expect(publishedAge).toBeGreaterThan(2);
      expect(publishedAge).toBeLessThan(4);
    });
  });

  it('treats covered=false as unknown until a source said so', async () => {
    await inRollback(async () => {
      const city = await municipality();
      const silent = await facility({ municipalityId: city.id });
      const osmNo = await facility({
        municipalityId: city.id,
        attrs: { osm: { tags: { leisure: 'pitch', covered: 'no' } } },
      });
      const roofed = await facility({ municipalityId: city.id, covered: true });
      const checked = await facility({ municipalityId: city.id });
      await edit(checked.id, 'verified', 'user_checker', true, 1);
      const remoteOnly = await facility({ municipalityId: city.id });
      await edit(remoteOnly.id, 'condition', 'user_remote', 'good', 1);
      // A moderator publishing the pin was never asked about a roof.
      const published = await facility({ municipalityId: city.id });
      await edit(published.id, 'status', 'user_mod', 'active', 1);
      // An OSM-side change is already reflected in the tags it came from.
      const osmEdit = await facility({ municipalityId: city.id });
      await edit(osmEdit.id, 'covered', null, false, 1, 'osm');
      const registry = await facility({ municipalityId: city.id });
      await edit(registry.id, 'covered', null, false, 1, 'municipal');

      expect((await getFacilityBySlug(silent.slug))?.coveredKnown).toBe(false);
      expect((await getFacilityBySlug(osmNo.slug))?.coveredKnown).toBe(true);
      expect((await getFacilityBySlug(roofed.slug))?.coveredKnown).toBe(true);
      expect((await getFacilityBySlug(checked.slug))?.coveredKnown).toBe(true);
      expect((await getFacilityBySlug(remoteOnly.slug))?.coveredKnown).toBe(false);
      expect((await getFacilityBySlug(published.slug))?.coveredKnown).toBe(false);
      expect((await getFacilityBySlug(osmEdit.slug))?.coveredKnown).toBe(false);
      expect((await getFacilityBySlug(registry.slug))?.coveredKnown).toBe(true);
    });
  });
});
