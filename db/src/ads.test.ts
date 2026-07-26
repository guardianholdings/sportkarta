import { ALLOWED_RELATIONS } from '@sportkarta/lib/opendata';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Ad-slot exclusivity, PROVEN AGAINST POSTGRES (docs/MONETISATION.md S5, M4).
 *
 * "One advertiser per slot per period" is the product being sold, so it is a
 * constraint rather than a rule in a server action: two people editing the admin
 * screen, a double submit, or a future script would each be a way around an
 * application check. `ad_placements_one_visible_per_slot` is attacked here from
 * every direction the schema allows — overlapping windows, adjacent windows, the
 * inclusive end date, publishing into an occupied slot — with no application in
 * the picture.
 *
 * The partial predicate (`WHERE (visible)`) is asserted in BOTH directions: two
 * drafts may overlap (an operator preparing next month's sale while this month
 * runs), and the moment one of them is published the constraint bites.
 *
 * Integration test against the dev/CI database; skips without DATABASE_URL.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

const SLUG = 'e2e-ads-advertiser';
const OTHER_SLUG = 'e2e-ads-advertiser-2';

describe.skipIf(!hasDb)('ad placement exclusivity (requires running database)', () => {
  let client: pg.Client;
  let partnerId: number;
  let otherPartnerId: number;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await cleanup();
    await client.end();
  });

  async function cleanup(): Promise<void> {
    await client.query(
      `DELETE FROM ad_placements WHERE partner_id IN (SELECT id FROM partners WHERE slug = ANY($1::text[]))`,
      [[SLUG, OTHER_SLUG]],
    );
    await client.query(`DELETE FROM partners WHERE slug = ANY($1::text[])`, [[SLUG, OTHER_SLUG]]);
  }

  beforeEach(async () => {
    await cleanup();
    const inserted = await client.query<{ id: number; slug: string }>(
      `INSERT INTO partners (slug, tier, name_bg, visible)
       VALUES ($1, 'advertiser', 'Рекламодател', true),
              ($2, 'advertiser', 'Рекламодател 2', true)
       RETURNING id, slug`,
      [SLUG, OTHER_SLUG],
    );
    partnerId = inserted.rows.find((r) => r.slug === SLUG)?.id as number;
    otherPartnerId = inserted.rows.find((r) => r.slug === OTHER_SLUG)?.id as number;
  });

  /** One placement. `visible` and the window are what every test varies. */
  function place(opts: {
    partner?: number;
    slot?: string;
    from?: string;
    to?: string;
    visible?: boolean;
  }) {
    return client.query(
      `INSERT INTO ad_placements
         (partner_id, slot, creative_path, url, alt_bg, starts_on, ends_on, visible)
       VALUES ($1, $2, $3, 'https://example.org', 'Реклама', $4::date, $5::date, $6)`,
      [
        opts.partner ?? partnerId,
        opts.slot ?? 'facility_page',
        `ads/2026/08/${String(Math.abs((opts.from ?? 'a').length * 7 + (opts.to ?? 'b').length))}-${opts.slot ?? 'facility_page'}-${opts.visible ? 'v' : 'd'}.webp`,
        opts.from ?? '2026-08-01',
        opts.to ?? '2026-08-31',
        opts.visible ?? true,
      ],
    );
  }

  it('accepts one live placement per slot', async () => {
    await expect(place({ visible: true })).resolves.toBeDefined();
  });

  it('REFUSES a second live placement overlapping the same slot', async () => {
    await place({ visible: true });
    await expect(
      place({ partner: otherPartnerId, from: '2026-08-15', to: '2026-09-15', visible: true }),
    ).rejects.toThrow(/ad_placements_one_visible_per_slot/);
  });

  it('treats ends_on as INCLUSIVE — a one-day touch is an overlap', async () => {
    await place({ from: '2026-08-01', to: '2026-08-31', visible: true });
    // 31 August is a day the first advertiser paid for.
    await expect(
      place({ partner: otherPartnerId, from: '2026-08-31', to: '2026-09-30', visible: true }),
    ).rejects.toThrow(/ad_placements_one_visible_per_slot/);
  });

  it('allows the very next day — adjacent periods are not overlapping ones', async () => {
    await place({ from: '2026-08-01', to: '2026-08-31', visible: true });
    await expect(
      place({ partner: otherPartnerId, from: '2026-09-01', to: '2026-09-30', visible: true }),
    ).resolves.toBeDefined();
  });

  it('scopes exclusivity to the slot — the same month sells four times over', async () => {
    for (const slot of ['facility_page', 'city_page', 'weekly_page', 'map_panel']) {
      await expect(place({ slot, visible: true })).resolves.toBeDefined();
    }
  });

  it('lets DRAFTS overlap freely — next month is prepared while this month runs', async () => {
    await place({ visible: false });
    await expect(
      place({ partner: otherPartnerId, from: '2026-08-10', to: '2026-08-20', visible: false }),
    ).resolves.toBeDefined();
  });

  it('bites the moment a colliding draft is PUBLISHED, not before', async () => {
    await place({ visible: true });
    await place({ partner: otherPartnerId, from: '2026-08-10', to: '2026-08-20', visible: false });
    await expect(
      client.query(
        `UPDATE ad_placements SET visible = true WHERE partner_id = $1`,
        [otherPartnerId],
      ),
    ).rejects.toThrow(/ad_placements_one_visible_per_slot/);
  });

  it('frees the slot when the incumbent is hidden', async () => {
    await place({ visible: true });
    await place({ partner: otherPartnerId, from: '2026-08-10', to: '2026-08-20', visible: false });
    await client.query(`UPDATE ad_placements SET visible = false WHERE partner_id = $1`, [
      partnerId,
    ]);
    await expect(
      client.query(`UPDATE ad_placements SET visible = true WHERE partner_id = $1`, [
        otherPartnerId,
      ]),
    ).resolves.toBeDefined();
  });

  it('refuses an unknown slot — the CHECK, not the form, is the authority', async () => {
    await expect(place({ slot: 'passport_page' })).rejects.toThrow(/ad_placements_slot_known/);
  });

  it('refuses a creative path that tries to climb out of the prefix', async () => {
    await expect(
      client.query(
        `INSERT INTO ad_placements (partner_id, slot, creative_path, url, alt_bg, starts_on, ends_on)
         VALUES ($1, 'city_page', '../../etc/passwd', 'https://example.org', 'Реклама', '2026-08-01', '2026-08-31')`,
        [partnerId],
      ),
    ).rejects.toThrow(/ad_placements_creative_path_sane/);
  });

  it('refuses an empty alt text', async () => {
    await expect(
      client.query(
        `INSERT INTO ad_placements (partner_id, slot, creative_path, url, alt_bg, starts_on, ends_on)
         VALUES ($1, 'city_page', 'ads/x.webp', 'https://example.org', '   ', '2026-08-01', '2026-08-31')`,
        [partnerId],
      ),
    ).rejects.toThrow(/ad_placements_alt_sane/);
  });

  it('RESTRICTS deleting a partner who has placements — a sold slot has a buyer', async () => {
    await place({ visible: true });
    await expect(client.query(`DELETE FROM partners WHERE id = $1`, [partnerId])).rejects.toThrow(
      /ad_placements_partner_id_partners_id_fk/,
    );
  });

  it('keeps ad tables out of the open-data catalogue', () => {
    // Structural, not a promise: the export SELECT list is generated from the
    // declared fields, and the allowlist refuses a relation that is not there.
    expect(ALLOWED_RELATIONS).not.toContain('ad_placements');
    expect(ALLOWED_RELATIONS).not.toContain('partners');
  });
});
