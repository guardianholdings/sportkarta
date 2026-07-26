import { ALLOWED_RELATIONS, EXPORT_DATASETS } from '@sportkarta/lib/opendata';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { exportQuery } from './opendata/export.js';
import { renderSql } from './render-sql.js';

/**
 * Adopt-a-facility, PROVEN AGAINST POSTGRES (docs/MONETISATION.md S3, M3a).
 *
 * Three properties, and the third is the one that protects the project rather
 * than the sale:
 *
 *  1. ONE ADOPTION PER FACILITY PER PERIOD, enforced by
 *     `facility_sponsorships_one_per_facility` — a double sale of the same pitch
 *     must be impossible, not merely discouraged by the admin screen.
 *  2. NEITHER SIDE CAN VANISH. Both FKs RESTRICT: a facility with an adoption
 *     cannot be deleted, and neither can the partner.
 *  3. THE FACILITY OPEN-DATA EXPORT IS BYTE-IDENTICAL before and after an
 *     adoption exists. The allowlist makes that structural — but the test makes
 *     it visible, because "sponsorship never touches facility data" is the
 *     promise the whole feature rests on, and a future migration that added a
 *     sponsor column to `facilities` would break this and nothing else.
 *
 * Integration test against the dev/CI database; skips without DATABASE_URL.
 */

const hasDb = Boolean(process.env.DATABASE_URL);
const SLUG = 'e2e-adopt-partner';
const OTHER_SLUG = 'e2e-adopt-partner-2';

describe.skipIf(!hasDb)('facility sponsorships (requires running database)', () => {
  let client: pg.Client;
  let partnerId: number;
  let otherPartnerId: number;
  let facilityA: string;
  let facilityB: string;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    // Borrow two real facilities, as the other DB suites do: inventing rows
    // would drift the statistics materialised views.
    //
    // UNADOPTED ones only. The exclusion constraint is the thing under test, so
    // a facility the operator has already adopted in their dev database would
    // make every insert here fail for the right reason at the wrong time —
    // found exactly that way.
    const picked = await client.query<{ id: string }>(
      `SELECT id FROM facilities
        WHERE slug IS NOT NULL
          AND id NOT IN (SELECT facility_id FROM facility_sponsorships)
        ORDER BY id LIMIT 2`,
    );
    facilityA = picked.rows[0]?.id as string;
    facilityB = picked.rows[1]?.id as string;
    if (!facilityA || !facilityB) throw new Error('need two facilities');
  });

  afterAll(async () => {
    await cleanup();
    await client.end();
  });

  async function cleanup(): Promise<void> {
    await client.query(
      `DELETE FROM facility_sponsorships
        WHERE partner_id IN (SELECT id FROM partners WHERE slug = ANY($1::text[]))`,
      [[SLUG, OTHER_SLUG]],
    );
    await client.query(`DELETE FROM partners WHERE slug = ANY($1::text[])`, [[SLUG, OTHER_SLUG]]);
  }

  beforeEach(async () => {
    await cleanup();
    const inserted = await client.query<{ id: number; slug: string }>(
      `INSERT INTO partners (slug, tier, name_bg, visible)
       VALUES ($1, 'category', 'Осиновител', true), ($2, 'category', 'Осиновител 2', true)
       RETURNING id, slug`,
      [SLUG, OTHER_SLUG],
    );
    partnerId = inserted.rows.find((r) => r.slug === SLUG)?.id as number;
    otherPartnerId = inserted.rows.find((r) => r.slug === OTHER_SLUG)?.id as number;
  });

  function adopt(opts: { facility?: string; partner?: number; from?: string; to?: string }) {
    return client.query(
      `INSERT INTO facility_sponsorships (facility_id, partner_id, starts_on, ends_on)
       VALUES ($1::uuid, $2, $3::date, $4::date)`,
      [
        opts.facility ?? facilityA,
        opts.partner ?? partnerId,
        opts.from ?? '2026-01-01',
        opts.to ?? '2026-12-31',
      ],
    );
  }

  it('accepts one adoption of a facility', async () => {
    await expect(adopt({})).resolves.toBeDefined();
  });

  it('REFUSES a second adoption overlapping the same facility', async () => {
    await adopt({});
    await expect(adopt({ partner: otherPartnerId, from: '2026-06-01', to: '2027-05-31' })).rejects.toThrow(
      /facility_sponsorships_one_per_facility/,
    );
  });

  it('treats ends_on as INCLUSIVE — the last day is still sponsored', async () => {
    await adopt({ from: '2026-01-01', to: '2026-12-31' });
    await expect(
      adopt({ partner: otherPartnerId, from: '2026-12-31', to: '2027-12-31' }),
    ).rejects.toThrow(/facility_sponsorships_one_per_facility/);
  });

  it('allows the next year — consecutive adoptions are how renewal works', async () => {
    await adopt({ from: '2026-01-01', to: '2026-12-31' });
    await expect(
      adopt({ partner: otherPartnerId, from: '2027-01-01', to: '2027-12-31' }),
    ).resolves.toBeDefined();
  });

  it('scopes exclusivity to the facility — one partner may adopt several', async () => {
    await adopt({ facility: facilityA });
    await expect(adopt({ facility: facilityB })).resolves.toBeDefined();
  });

  it('refuses a window that ends before it starts', async () => {
    await expect(adopt({ from: '2026-12-31', to: '2026-01-01' })).rejects.toThrow(
      /facility_sponsorships_window_order/,
    );
  });

  it('refuses a blank plaque line rather than storing an empty string', async () => {
    await expect(
      client.query(
        `INSERT INTO facility_sponsorships (facility_id, partner_id, label_bg, starts_on, ends_on)
         VALUES ($1::uuid, $2, '   ', '2026-01-01', '2026-12-31')`,
        [facilityA, partnerId],
      ),
    ).rejects.toThrow(/facility_sponsorships_label_sane/);
  });

  it('RESTRICTS deleting a partner who has adoptions', async () => {
    await adopt({});
    await expect(client.query(`DELETE FROM partners WHERE id = $1`, [partnerId])).rejects.toThrow(
      /facility_sponsorships_partner_id_partners_id_fk/,
    );
  });

  it('leaves the facility row and its provenance trail untouched', async () => {
    async function snapshot() {
      const row = await client.query(`SELECT * FROM facilities WHERE id = $1::uuid`, [facilityA]);
      const edits = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM facility_edits WHERE facility_id = $1::uuid`,
        [facilityA],
      );
      return { row: row.rows[0], edits: edits.rows[0]?.n ?? 0 };
    }
    const before = await snapshot();
    await adopt({});
    // Sponsorship is ADJACENT: no field of the facility changes, and no edit is
    // recorded — an adoption is not a change to facility data, so it must not
    // enter the provenance trail the merge policy reads.
    expect(await snapshot()).toEqual(before);
  });

  it('leaves the facility open-data export BYTE-IDENTICAL', async () => {
    const dataset = EXPORT_DATASETS.find((d) => d.id === 'facilities');
    if (!dataset) throw new Error('facilities dataset missing from the catalogue');
    const rendered = renderSql(exportQuery(dataset, { limit: 50 }));

    const before = await client.query(rendered.sql, rendered.params);
    await adopt({});
    const after = await client.query(rendered.sql, rendered.params);

    // The allowlist and the generated SELECT list make this structural; the test
    // makes it visible, because "sponsorship never reaches the open data" is the
    // promise the whole feature rests on. A future migration that put a sponsor
    // column on `facilities` would break this and nothing else.
    expect(JSON.stringify(after.rows)).toBe(JSON.stringify(before.rows));
  });

  it('keeps adoption data out of the open-data catalogue', () => {
    expect(ALLOWED_RELATIONS).not.toContain('facility_sponsorships');
  });
});
