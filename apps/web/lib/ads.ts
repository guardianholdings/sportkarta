import { sql, type SQL } from '@sportkarta/db';

import { PARTNER_RENDERABLE } from '@/lib/partners';

/**
 * Ad placements (docs/MONETISATION.md S5, phase M4).
 *
 * THE SLOT IS THE PRODUCT. A placement is sold as "this surface, this period,
 * flat rate", and this module never learns anything else: no viewer attribute
 * reaches it, there is no impression or click counter to write, and the only
 * question it can answer is "what is running in slot X today". That is what
 * keeps the site free of consent machinery (§S5), so the shape of this file is
 * part of the privacy posture rather than an implementation detail.
 *
 * THE FOUR SLOTS ARE A CLOSED LIST, in three places that must agree: this
 * constant, the `ad_placements_slot_known` CHECK, and the surface table in
 * docs/MONETISATION.md §S5. Adding a fifth is a deliberate act in all three.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

export const AD_SLOTS = ['facility_page', 'city_page', 'weekly_page', 'map_panel'] as const;
export type AdSlotKey = (typeof AD_SLOTS)[number];

export function isAdSlot(value: string): value is AdSlotKey {
  return (AD_SLOTS as readonly string[]).includes(value);
}

export class AdPlacementError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AdPlacementError';
  }
}

export interface AdPlacementInput {
  partnerId: number;
  slot: AdSlotKey;
  url: string;
  altBg: string;
  altEn: string | null;
  startsOn: string;
  endsOn: string;
}

export interface AdPlacementRow extends AdPlacementInput {
  id: number;
  creativePath: string;
  visible: boolean;
}

/**
 * What a PAGE gets: enough to render, and nothing that identifies the buyer.
 * No partner id, no slug, no tier — the surface renders a labelled creative and
 * a link, not a sponsor relationship, so there is nothing here to leak into a
 * page that was not sold one.
 */
export interface ActiveAd {
  id: number;
  url: string;
  altBg: string;
  altEn: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ALT_MAX = 200;
const URL_MAX = 300;

/** Pure form → input; throws before any database work (the partners pattern). */
export function buildAdPlacementInput(formData: FormData): AdPlacementInput {
  const partnerId = Number(String(formData.get('partnerId') ?? '').trim());
  if (!Number.isInteger(partnerId) || partnerId <= 0) {
    throw new AdPlacementError('bad_partner');
  }

  const slot = String(formData.get('slot') ?? '');
  if (!isAdSlot(slot)) throw new AdPlacementError('bad_slot');

  const url = String(formData.get('url') ?? '').trim();
  if (!/^https?:\/\/[^\s]+$/.test(url) || url.length > URL_MAX) {
    throw new AdPlacementError('bad_url');
  }

  const altBg = String(formData.get('altBg') ?? '').trim();
  if (!altBg) throw new AdPlacementError('alt_required');
  if (altBg.length > ALT_MAX) throw new AdPlacementError('alt_too_long');

  const altEnRaw = String(formData.get('altEn') ?? '').trim();
  if (altEnRaw.length > ALT_MAX) throw new AdPlacementError('alt_too_long');

  const startsOn = String(formData.get('startsOn') ?? '').trim();
  const endsOn = String(formData.get('endsOn') ?? '').trim();
  // Both bounded, unlike a partner window: a slot with no end date is a slot
  // nobody remembers to take down (and the column is NOT NULL anyway).
  if (!DATE_RE.test(startsOn) || !DATE_RE.test(endsOn)) throw new AdPlacementError('bad_date');
  if (endsOn < startsOn) throw new AdPlacementError('window_order');

  return { partnerId, slot, url, altBg, altEn: altEnRaw || null, startsOn, endsOn };
}

const COLUMNS = sql`
  a.id, a.partner_id, a.slot, a.creative_path, a.url, a.alt_bg, a.alt_en, a.visible,
  to_char(a.starts_on, 'YYYY-MM-DD') AS starts_on,
  to_char(a.ends_on, 'YYYY-MM-DD') AS ends_on
`;

function toPlacement(row: Record<string, unknown>): AdPlacementRow {
  return {
    id: Number(row.id),
    partnerId: Number(row.partner_id),
    slot: String(row.slot) as AdSlotKey,
    creativePath: String(row.creative_path),
    url: String(row.url),
    altBg: String(row.alt_bg),
    altEn: row.alt_en === null ? null : String(row.alt_en),
    visible: row.visible === true,
    startsOn: String(row.starts_on),
    endsOn: String(row.ends_on),
  };
}

/** Today in Sofia — placement windows are civil dates, `ends_on` inclusive. */
const SOFIA_TODAY = sql`(now() AT TIME ZONE 'Europe/Sofia')::date`;

/**
 * What is running in a slot right now, or null.
 *
 * FOUR CONDITIONS, ALL IN SQL. The placement is visible and inside its window,
 * AND the partner is renderable (`PARTNER_RENDERABLE`, the same fragment
 * `/partnyori` uses). The partner condition is the one that is easy to forget
 * and the one that matters most: without it, hiding an advertiser on the
 * partners screen would leave their creative running on four public pages.
 *
 * `LIMIT 1` is belt-and-braces. `ad_placements_one_visible_per_slot` already
 * makes two visible placements on one slot and date unconstructible, so this
 * can only ever match one row — but a page must render one ad or none, never a
 * stack, even if that constraint were ever relaxed.
 */
export async function activeAd(db: SqlRunner, slot: AdSlotKey): Promise<ActiveAd | null> {
  const result = await db.execute(sql`
    SELECT a.id, a.url, a.alt_bg, a.alt_en
      FROM ad_placements a
      JOIN partners p ON p.id = a.partner_id
     WHERE a.slot = ${slot}
       AND a.visible
       AND a.starts_on <= ${SOFIA_TODAY}
       AND a.ends_on >= ${SOFIA_TODAY}
       AND ${PARTNER_RENDERABLE}
     LIMIT 1
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    url: String(row.url),
    altBg: String(row.alt_bg),
    altEn: row.alt_en === null ? null : String(row.alt_en),
  };
}

/** Every placement of one partner, for the admin screen: draft and live alike. */
export async function partnerPlacements(
  db: SqlRunner,
  partnerId: number,
): Promise<AdPlacementRow[]> {
  const result = await db.execute(sql`
    SELECT ${COLUMNS} FROM ad_placements a
     WHERE a.partner_id = ${partnerId}
     ORDER BY a.starts_on DESC, a.slot
  `);
  return result.rows.map(toPlacement);
}

export async function createPlacement(
  db: SqlRunner,
  input: AdPlacementInput,
  creativePath: string,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO ad_placements
      (partner_id, slot, creative_path, url, alt_bg, alt_en, starts_on, ends_on)
    VALUES
      (${input.partnerId}, ${input.slot}, ${creativePath}, ${input.url}, ${input.altBg},
       ${input.altEn}, ${input.startsOn}::date, ${input.endsOn}::date)
  `);
}

/**
 * Posts the TARGET state (the 0018 rule) — a double submit settles.
 *
 * Publishing is where `ad_placements_one_visible_per_slot` can refuse: the
 * caller turns that into "slot_taken" rather than a 500, because the refusal is
 * information the operator needs ("somebody already sold that month").
 */
export async function setPlacementVisible(
  db: SqlRunner,
  id: number,
  visible: boolean,
): Promise<void> {
  await db.execute(sql`
    UPDATE ad_placements SET visible = ${visible}, updated_at = now() WHERE id = ${id}
  `);
}

/**
 * Delete a placement, returning its creative key so the caller can remove the
 * file AFTER the row is gone (never before — an orphaned row pointing at a
 * missing file renders a broken image on a public page).
 *
 * Placements are deleted rather than archived, unlike partners: nothing
 * references them, and a lapsed placement has no history worth keeping — the
 * deliverable report for a renewal is screenshots plus page views (§Ongoing),
 * not this table.
 */
export async function deletePlacement(db: SqlRunner, id: number): Promise<string | null> {
  const result = await db.execute(sql`
    DELETE FROM ad_placements WHERE id = ${id} RETURNING creative_path
  `);
  const row = result.rows[0];
  return row ? String(row.creative_path) : null;
}

/** bg is required, en optional — en readers fall back to Bulgarian. */
export function adAlt(altBg: string, altEn: string | null, locale: string): string {
  return locale === 'en' && altEn ? altEn : altBg;
}
