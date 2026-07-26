import { sql, type SQL } from '@sportkarta/db';

/**
 * Partner & sponsor authoring (docs/MONETISATION.md M1).
 *
 * Everything an admin can submit passes through buildPartnerInput, which is
 * pure and throws before any database work — the campaigns pattern. Content
 * is bilingual COLUMNS (admin content, not UI strings); the blurb is "how we
 * partner", written per partner. DELIBERATELY no contact fields: sponsor
 * contacts are natural persons and live in the offline CRM, never here.
 *
 * A partner is hidden, never deleted — future sponsorship surfaces (campaign
 * FK, facility adoptions) will RESTRICT on this table, and a lapsed sponsor's
 * history must keep resolving. Public rendering is `visible AND window
 * active` — one rule, stated here, used by every reader.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * 'advertiser' (M4) is a tier, not a second table: an advertiser buys a labelled
 * slot rather than acknowledgment, but shares the creative pipeline, the
 * acceptance policy and the no-contact-columns rule. It is deliberately LAST —
 * `/partnyori` renders tier sections in this order and an advertiser is not a
 * partner of the NGO in the sense that page is about.
 */
export const PARTNER_TIERS = [
  'headline',
  'category',
  'supporter',
  'institutional',
  'advertiser',
] as const;
export type PartnerTier = (typeof PARTNER_TIERS)[number];

export class PartnerInputError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PartnerInputError';
  }
}

export interface PartnerInput {
  slug: string;
  tier: PartnerTier;
  nameBg: string;
  nameEn: string | null;
  blurbBg: string | null;
  blurbEn: string | null;
  url: string | null;
  visible: boolean;
  sortOrder: number;
  startsOn: string | null;
  endsOn: string | null;
}

export interface PartnerRow extends PartnerInput {
  id: number;
  logoPath: string | null;
}

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NAME_MAX = 120;
const TEXT_MAX = 2000;
const URL_MAX = 300;

function text(value: FormDataEntryValue | null, max: number): string | null {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw new PartnerInputError('text_too_long');
  return trimmed;
}

function dateOrNull(value: FormDataEntryValue | null): string | null {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  if (!DATE_RE.test(trimmed)) throw new PartnerInputError('bad_date');
  return trimmed;
}

/** Pure form → input; throws PartnerInputError before any database work. */
export function buildPartnerInput(formData: FormData): PartnerInput {
  const slug = String(formData.get('slug') ?? '')
    .trim()
    .toLowerCase();
  if (!SLUG_RE.test(slug) || slug.length > 60) throw new PartnerInputError('bad_slug');

  const tier = String(formData.get('tier') ?? '');
  if (!(PARTNER_TIERS as readonly string[]).includes(tier)) {
    throw new PartnerInputError('bad_tier');
  }

  const nameBg = text(formData.get('nameBg'), NAME_MAX);
  if (!nameBg) throw new PartnerInputError('name_required');

  const url = text(formData.get('url'), URL_MAX);
  if (url !== null && !/^https?:\/\/[^\s]+$/.test(url)) throw new PartnerInputError('bad_url');

  const startsOn = dateOrNull(formData.get('startsOn'));
  const endsOn = dateOrNull(formData.get('endsOn'));
  if (startsOn && endsOn && endsOn < startsOn) throw new PartnerInputError('window_order');

  const sortRaw = String(formData.get('sortOrder') ?? '0').trim() || '0';
  const sortOrder = Number(sortRaw);
  if (!Number.isInteger(sortOrder) || Math.abs(sortOrder) > 10_000) {
    throw new PartnerInputError('bad_sort');
  }

  return {
    slug,
    tier: tier as PartnerTier,
    nameBg,
    nameEn: text(formData.get('nameEn'), NAME_MAX),
    blurbBg: text(formData.get('blurbBg'), TEXT_MAX),
    blurbEn: text(formData.get('blurbEn'), TEXT_MAX),
    url,
    visible: formData.get('visible') === 'on',
    sortOrder,
    startsOn,
    endsOn,
  };
}

const COLUMNS = sql`
  id, slug, tier, name_bg, name_en, blurb_bg, blurb_en, url, logo_path,
  visible, sort_order,
  to_char(starts_on, 'YYYY-MM-DD') AS starts_on,
  to_char(ends_on, 'YYYY-MM-DD') AS ends_on
`;

function toPartner(row: Record<string, unknown>): PartnerRow {
  return {
    id: Number(row.id),
    slug: String(row.slug),
    tier: String(row.tier) as PartnerTier,
    nameBg: String(row.name_bg),
    nameEn: row.name_en === null ? null : String(row.name_en),
    blurbBg: row.blurb_bg === null ? null : String(row.blurb_bg),
    blurbEn: row.blurb_en === null ? null : String(row.blurb_en),
    url: row.url === null ? null : String(row.url),
    logoPath: row.logo_path === null ? null : String(row.logo_path),
    visible: row.visible === true,
    sortOrder: Number(row.sort_order),
    startsOn: row.starts_on === null ? null : String(row.starts_on),
    endsOn: row.ends_on === null ? null : String(row.ends_on),
  };
}

/** Every partner, for the admin list: draft, lapsed and live alike. */
export async function listPartners(db: SqlRunner): Promise<PartnerRow[]> {
  const result = await db.execute(sql`
    SELECT ${COLUMNS} FROM partners
    ORDER BY array_position(ARRAY['headline','category','supporter','institutional'], tier),
             sort_order, name_bg
  `);
  return result.rows.map(toPartner);
}

/** Today in Sofia. Sponsorship windows are civil dates, `ends_on` inclusive. */
const SOFIA_TODAY = sql`(now() AT TIME ZONE 'Europe/Sofia')::date`;

/**
 * THE RENDERING RULE, WRITTEN ONCE: a partner appears only while `visible` AND
 * inside its window.
 *
 * Every surface embeds this fragment instead of restating the predicate —
 * `/partnyori`, the headline strip, and (M2/M3/M4) the campaign sponsor block,
 * facility adoptions and ad slots, which join `partners` and must not be able
 * to disagree about it. Without one definition, a lapsed or hidden partner
 * could still show on a facility page while `/partnyori` denies they exist.
 *
 * CONVENTION: the fragment refers to the partners table as `p`, so any query
 * embedding it must alias `partners p`. A missing alias is a loud SQL error at
 * the first call rather than a silently-unfiltered read.
 */
export const PARTNER_RENDERABLE = sql`
  p.visible
  AND (p.starts_on IS NULL OR p.starts_on <= ${SOFIA_TODAY})
  AND (p.ends_on IS NULL OR p.ends_on >= ${SOFIA_TODAY})
`;

const TIER_RANK = sql`array_position(ARRAY['headline','category','supporter','institutional','advertiser'], tier)`;

/**
 * The public `/partnyori` read: renderable partners, in tier order.
 *
 * ADVERTISERS ARE EXCLUDED HERE, in SQL, rather than by the page's tier loop
 * happening not to mention them. `/partnyori` is about who supports the NGO;
 * somebody who bought a labelled slot for a month is a customer, and listing
 * them among partners would overstate the relationship in both directions. The
 * ad itself carries its own «Реклама» label, which is the disclosure that
 * placement actually requires.
 */
export async function publicPartners(db: SqlRunner): Promise<PartnerRow[]> {
  const result = await db.execute(sql`
    SELECT ${COLUMNS} FROM partners p
     WHERE ${PARTNER_RENDERABLE} AND p.tier <> 'advertiser'
    ORDER BY ${TIER_RANK}, sort_order, name_bg
  `);
  return result.rows.map(toPartner);
}

/**
 * The headline-tier partners for the "с подкрепата на" strip (MONETISATION M1,
 * optional-by-operator-decision — the surface allowlist and the env flag live
 * in components/partners/headline-strip.tsx).
 *
 * Headline tier ONLY. A category or supporter logo on a content page is not
 * what any of those tiers were sold (§S1), and `institutional` is never
 * invoiced at all — putting a ministry's logo in a sponsor strip would
 * misrepresent a relationship.
 */
export async function headlinePartners(db: SqlRunner, limit = 3): Promise<PartnerRow[]> {
  const result = await db.execute(sql`
    SELECT ${COLUMNS} FROM partners p
     WHERE ${PARTNER_RENDERABLE} AND p.tier = 'headline'
    ORDER BY sort_order, name_bg
    LIMIT ${limit}
  `);
  return result.rows.map(toPartner);
}

/**
 * Who may be picked as a CAMPAIGN SPONSOR (MONETISATION S2, phase M2).
 *
 * Tier headline or category only — that is what §S1's tier table sells, and an
 * `institutional` partner (a municipality, ММС, a federation) on a sponsored
 * campaign would contradict "never invoiced"; an `advertiser` bought a labelled
 * slot, not a campaign; a `supporter` bought a name listing.
 *
 * DELIBERATELY NOT filtered by `PARTNER_RENDERABLE`: an admin needs to attach a
 * sponsor to a campaign before publishing either of them, and needs to still
 * SEE the sponsor already attached to a campaign whose partner has since lapsed.
 * Whether the sponsor line actually renders is decided at read time by the
 * renderability rule, which is the one place that decision belongs.
 */
export async function sponsorCandidates(
  db: SqlRunner,
): Promise<{ id: number; nameBg: string; nameEn: string | null }[]> {
  const result = await db.execute(sql`
    SELECT id, name_bg, name_en FROM partners
     WHERE tier IN ('headline', 'category')
     ORDER BY sort_order, name_bg
  `);
  return result.rows.map((row) => ({
    id: Number(row.id),
    nameBg: String(row.name_bg),
    nameEn: row.name_en === null ? null : String(row.name_en),
  }));
}

/**
 * The sponsor to SHOW for a campaign, or null.
 *
 * The renderability rule again (`visible` AND window active), so a hidden or
 * lapsed sponsor's name silently leaves every campaign page — the failure mode
 * this prevents is a logo still on a campaign that `/partnyori` says does not
 * exist.
 */
export async function campaignSponsor(
  db: SqlRunner,
  partnerId: number,
): Promise<PartnerRow | null> {
  const result = await db.execute(sql`
    SELECT ${COLUMNS} FROM partners p
     WHERE p.id = ${partnerId} AND ${PARTNER_RENDERABLE}
  `);
  const row = result.rows[0];
  return row ? toPartner(row) : null;
}

export async function partnerBySlug(db: SqlRunner, slug: string): Promise<PartnerRow | null> {
  const result = await db.execute(sql`SELECT ${COLUMNS} FROM partners WHERE slug = ${slug}`);
  const row = result.rows[0];
  return row ? toPartner(row) : null;
}

export async function createPartner(db: SqlRunner, input: PartnerInput): Promise<void> {
  await db.execute(sql`
    INSERT INTO partners
      (slug, tier, name_bg, name_en, blurb_bg, blurb_en, url, visible, sort_order, starts_on, ends_on)
    VALUES
      (${input.slug}, ${input.tier}, ${input.nameBg}, ${input.nameEn}, ${input.blurbBg},
       ${input.blurbEn}, ${input.url}, ${input.visible}, ${input.sortOrder},
       ${input.startsOn}::date, ${input.endsOn}::date)
  `);
}

export async function updatePartner(
  db: SqlRunner,
  slug: string,
  input: PartnerInput,
): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE partners SET
      slug = ${input.slug}, tier = ${input.tier}, name_bg = ${input.nameBg},
      name_en = ${input.nameEn}, blurb_bg = ${input.blurbBg}, blurb_en = ${input.blurbEn},
      url = ${input.url}, visible = ${input.visible}, sort_order = ${input.sortOrder},
      starts_on = ${input.startsOn}::date, ends_on = ${input.endsOn}::date, updated_at = now()
    WHERE slug = ${slug}
    RETURNING id
  `);
  return result.rows.length > 0;
}

/** Post the TARGET state, not "flip it" — a double submit settles (0018 rule). */
export async function setPartnerVisible(
  db: SqlRunner,
  slug: string,
  visible: boolean,
): Promise<void> {
  await db.execute(sql`
    UPDATE partners SET visible = ${visible}, updated_at = now() WHERE slug = ${slug}
  `);
}

/** Callers read the previous path first (partnerBySlug) to clean up storage. */
export async function setPartnerLogo(
  db: SqlRunner,
  slug: string,
  logoPath: string | null,
): Promise<void> {
  await db.execute(sql`
    UPDATE partners SET logo_path = ${logoPath}, updated_at = now() WHERE slug = ${slug}
  `);
}

/** bg is required, en optional — en readers fall back to Bulgarian. */
export function partnerText(bg: string | null, en: string | null, locale: string): string | null {
  if (locale === 'en' && en) return en;
  return bg;
}
