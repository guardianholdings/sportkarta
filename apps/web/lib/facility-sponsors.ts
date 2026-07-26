import { sql, type SQL } from '@sportkarta/db';

import { PARTNER_RENDERABLE } from '@/lib/partners';

/**
 * Adopt-a-facility reads and writes (docs/MONETISATION.md S3, phase M3a).
 *
 * WHY THIS IS A SEPARATE MODULE and not a join added to `getFacilityBySlug`:
 * that function feeds `FacilityDetail`, which is the shape the facility page,
 * the JSON-LD and several components all read. Widening it would put sponsor
 * fields one careless spread away from surfaces nobody decided to put a logo on.
 * A sponsorship is looked up on its own, by facility id, and rendered by its own
 * component.
 *
 * THE RENDERING RULE, ONE JOIN CONDITION: the sponsorship window is active AND
 * the partner is renderable (`PARTNER_RENDERABLE` — visible and in window). Both
 * halves matter. Without the partner half, hiding a sponsor on the partners
 * screen would leave their logo on a facility page that `/partnyori` says does
 * not exist.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

export class FacilitySponsorshipError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'FacilitySponsorshipError';
  }
}

export interface FacilitySponsorshipInput {
  facilityId: string;
  partnerId: number;
  labelBg: string | null;
  labelEn: string | null;
  startsOn: string;
  endsOn: string;
}

/** What a facility page renders: the sponsor's identity and optional plaque line. */
export interface FacilitySponsor {
  partnerId: number;
  nameBg: string;
  nameEn: string | null;
  url: string | null;
  logoPath: string | null;
  labelBg: string | null;
  labelEn: string | null;
  endsOn: string;
}

/** Admin view: every adoption of one partner, lapsed ones included. */
export interface PartnerSponsorship extends FacilitySponsorshipInput {
  id: number;
  facilitySlug: string | null;
  facilityName: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LABEL_MAX = 200;

/** Pure form → input; throws before any database work (the partners pattern). */
export function buildFacilitySponsorshipInput(formData: FormData): FacilitySponsorshipInput {
  const facilityId = String(formData.get('facilityId') ?? '').trim();
  if (!UUID_RE.test(facilityId)) throw new FacilitySponsorshipError('bad_facility');

  const partnerId = Number(String(formData.get('partnerId') ?? '').trim());
  if (!Number.isInteger(partnerId) || partnerId <= 0) {
    throw new FacilitySponsorshipError('bad_partner');
  }

  const label = (key: string): string | null => {
    const value = String(formData.get(key) ?? '').trim();
    if (!value) return null;
    if (value.length > LABEL_MAX) throw new FacilitySponsorshipError('label_too_long');
    return value;
  };

  const startsOn = String(formData.get('startsOn') ?? '').trim();
  const endsOn = String(formData.get('endsOn') ?? '').trim();
  if (!DATE_RE.test(startsOn) || !DATE_RE.test(endsOn)) {
    throw new FacilitySponsorshipError('bad_date');
  }
  if (endsOn < startsOn) throw new FacilitySponsorshipError('window_order');

  return {
    facilityId,
    partnerId,
    labelBg: label('labelBg'),
    labelEn: label('labelEn'),
    startsOn,
    endsOn,
  };
}

/** Today in Sofia — adoption windows are civil dates, `ends_on` inclusive. */
const SOFIA_TODAY = sql`(now() AT TIME ZONE 'Europe/Sofia')::date`;

/**
 * The active sponsor of a facility, or null.
 *
 * `LIMIT 1` is belt-and-braces: `facility_sponsorships_one_per_facility` already
 * makes two overlapping adoptions of one facility unconstructible.
 */
export async function facilitySponsor(
  db: SqlRunner,
  facilityId: string,
): Promise<FacilitySponsor | null> {
  if (!UUID_RE.test(facilityId)) return null;
  const result = await db.execute(sql`
    SELECT p.id AS partner_id, p.name_bg, p.name_en, p.url, p.logo_path,
           s.label_bg, s.label_en, to_char(s.ends_on, 'YYYY-MM-DD') AS ends_on
      FROM facility_sponsorships s
      JOIN partners p ON p.id = s.partner_id
     WHERE s.facility_id = ${facilityId}::uuid
       AND s.starts_on <= ${SOFIA_TODAY}
       AND s.ends_on >= ${SOFIA_TODAY}
       AND ${PARTNER_RENDERABLE}
     LIMIT 1
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    partnerId: Number(row.partner_id),
    nameBg: String(row.name_bg),
    nameEn: row.name_en === null ? null : String(row.name_en),
    url: row.url === null ? null : String(row.url),
    logoPath: row.logo_path === null ? null : String(row.logo_path),
    labelBg: row.label_bg === null ? null : String(row.label_bg),
    labelEn: row.label_en === null ? null : String(row.label_en),
    endsOn: String(row.ends_on),
  };
}

/** Every adoption of one partner, for the admin screen; lapsed ones included. */
export async function partnerSponsorships(
  db: SqlRunner,
  partnerId: number,
): Promise<PartnerSponsorship[]> {
  const result = await db.execute(sql`
    SELECT s.id, s.facility_id, s.partner_id, s.label_bg, s.label_en,
           to_char(s.starts_on, 'YYYY-MM-DD') AS starts_on,
           to_char(s.ends_on, 'YYYY-MM-DD') AS ends_on,
           f.slug AS facility_slug, f.name AS facility_name
      FROM facility_sponsorships s
      JOIN facilities f ON f.id = s.facility_id
     WHERE s.partner_id = ${partnerId}
     ORDER BY s.starts_on DESC
  `);
  return result.rows.map((row) => ({
    id: Number(row.id),
    facilityId: String(row.facility_id),
    partnerId: Number(row.partner_id),
    labelBg: row.label_bg === null ? null : String(row.label_bg),
    labelEn: row.label_en === null ? null : String(row.label_en),
    startsOn: String(row.starts_on),
    endsOn: String(row.ends_on),
    facilitySlug: row.facility_slug === null ? null : String(row.facility_slug),
    facilityName: row.facility_name === null ? null : String(row.facility_name),
  }));
}

/**
 * Resolve the facility a slug names, so the admin can enter a URL slug rather
 * than a uuid. Returns null when there is no such facility.
 */
export async function facilityIdBySlug(db: SqlRunner, slug: string): Promise<string | null> {
  if (!/^[a-z0-9-]{1,120}$/.test(slug)) return null;
  const result = await db.execute(sql`SELECT id FROM facilities WHERE slug = ${slug}`);
  const row = result.rows[0];
  return row ? String(row.id) : null;
}

export async function createFacilitySponsorship(
  db: SqlRunner,
  input: FacilitySponsorshipInput,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO facility_sponsorships
      (facility_id, partner_id, label_bg, label_en, starts_on, ends_on)
    VALUES
      (${input.facilityId}::uuid, ${input.partnerId}, ${input.labelBg}, ${input.labelEn},
       ${input.startsOn}::date, ${input.endsOn}::date)
  `);
}

/**
 * Delete an adoption.
 *
 * Adoptions are deleted rather than archived: the contractual record lives in the
 * NGO's files, and a lapsed row that keeps rendering nothing is only a way to
 * accumulate confusion on the admin screen.
 */
export async function deleteFacilitySponsorship(db: SqlRunner, id: number): Promise<void> {
  await db.execute(sql`DELETE FROM facility_sponsorships WHERE id = ${id}`);
}
