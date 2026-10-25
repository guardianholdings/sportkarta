import { getDb, publicFacilityVisible, sql } from '@sportkarta/db';
import type { ClubKind, ClubSport, ClubTier } from '@sportkarta/lib/clubs';

import { clubRenderableSql } from './access';
import { portalClasses, type PortalClass } from './portal';

/**
 * What the PUBLIC sees of a club: the /klubove directory, the club page, a
 * class page and the block on a facility page.
 *
 * ONE RULE FOR "MAY THIS CLUB BE SHOWN": clubRenderableSql — active, published
 * by the club itself (`visible`), and paid up or community — embedded in every
 * statement here, so a hidden, lapsed or suspended club disappears from every
 * surface at once and its page 404s. A facility is linked only when it is
 * itself public (publicFacilityVisible), so the paid-venue switches are obeyed
 * by construction. Classes carry counts, never a name.
 */

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

const NAME = (locale: string) =>
  sql`CASE WHEN ${locale} = 'en' THEN coalesce(c.name_en, c.name_bg) ELSE c.name_bg END`;
const DESCRIPTION = (locale: string) =>
  sql`CASE WHEN ${locale} = 'en' THEN coalesce(c.description_en, c.description_bg) ELSE c.description_bg END`;

export interface PublicClubCard {
  id: string;
  slug: string;
  name: string;
  kind: ClubKind;
  tier: ClubTier;
  sports: ClubSport[];
  municipalityId: number | null;
  hasLogo: boolean;
  description: string | null;
  classesThisWeek: number;
}

export async function publicClubDirectory(
  locale: string,
  filter: { municipalityId?: number | null; sport?: string | null } = {},
): Promise<PublicClubCard[]> {
  const result = await getDb().execute(sql`
    SELECT c.id, c.slug, ${NAME(locale)} AS name, c.kind, c.tier, c.sports, c.municipality_id,
           (c.logo_path IS NOT NULL) AS has_logo, ${DESCRIPTION(locale)} AS description,
           (SELECT count(*)::int FROM club_class_occurrences o JOIN club_classes k ON k.id = o.class_id
             WHERE o.club_id = c.id AND k.public AND o.status = 'scheduled'
               AND o.starts_at > now() AND o.starts_at < now() + interval '7 days') AS classes
      FROM clubs c
     WHERE ${clubRenderableSql('c')}
       ${filter.municipalityId ? sql`AND c.municipality_id = ${filter.municipalityId}` : sql``}
       ${filter.sport ? sql`AND ${filter.sport} = ANY(c.sports)` : sql``}
     ORDER BY lower(c.name_bg)
     LIMIT 500
  `);
  return result.rows.map((row) => ({
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    kind: String(row.kind) as ClubKind,
    tier: String(row.tier) as ClubTier,
    sports: (Array.isArray(row.sports) ? row.sports : []).map(String) as ClubSport[],
    municipalityId: row.municipality_id === null ? null : Number(row.municipality_id),
    hasLogo: row.has_logo === true,
    description: text(row.description),
    classesThisWeek: Number(row.classes ?? 0),
  }));
}

/** Municipalities that have at least one renderable club — the directory's filter. */
export async function clubMunicipalities(): Promise<number[]> {
  const result = await getDb().execute(sql`
    SELECT DISTINCT c.municipality_id FROM clubs c
     WHERE ${clubRenderableSql('c')} AND c.municipality_id IS NOT NULL
  `);
  return result.rows.map((row) => Number(row.municipality_id));
}

export interface PublicLocation {
  id: string;
  name: string;
  address: string | null;
  facilitySlug: string | null;
  facilityName: string | null;
}

export interface PublicPlan {
  id: string;
  name: string;
  description: string | null;
  kind: string;
  audience: string;
  priceCents: number;
  validityDays: number | null;
  validityMonths: number | null;
  visitsCount: number | null;
}

export interface PublicTrainer {
  name: string;
  bio: string | null;
}

export interface PublicFaq {
  question: string;
  answer: string;
}

export interface PublicClub extends Omit<PublicClubCard, 'classesThisWeek'> {
  websiteUrl: string | null;
  publicEmail: string | null;
  publicPhone: string | null;
  /** green | coral | sky — the page's accent (0045). */
  accent: 'green' | 'coral' | 'sky';
  locations: PublicLocation[];
  plans: PublicPlan[];
  classes: PortalClass[];
  /** Staff who opted in themselves (club_staff.public_profile). */
  trainers: PublicTrainer[];
  faq: PublicFaq[];
}

export async function publicClub(slug: string, locale: string): Promise<PublicClub | null> {
  if (!/^[a-z0-9-]{3,60}$/.test(slug)) return null;
  const db = getDb();
  const row = (
    await db.execute(sql`
      SELECT c.id, c.slug, ${NAME(locale)} AS name, c.kind, c.tier, c.sports, c.municipality_id,
             (c.logo_path IS NOT NULL) AS has_logo, ${DESCRIPTION(locale)} AS description,
             c.website_url, c.public_email, c.public_phone, c.accent
        FROM clubs c
       WHERE c.slug = ${slug} AND ${clubRenderableSql('c')}
    `)
  ).rows[0];
  if (!row) return null;
  const clubId = String(row.id);
  const [locations, plans, classes, trainers, faq] = await Promise.all([
    db.execute(sql`
      SELECT l.id, l.name, l.address,
             CASE WHEN f.id IS NOT NULL AND ${publicFacilityVisible} THEN f.slug END AS facility_slug,
             CASE WHEN f.id IS NOT NULL AND ${publicFacilityVisible} THEN f.name END AS facility_name
        FROM club_locations l
        LEFT JOIN facilities f ON f.id = l.facility_id
       WHERE l.club_id = ${clubId}::uuid AND l.active
       ORDER BY l.sort_order, l.name
    `),
    db.execute(sql`
      SELECT p.id, CASE WHEN ${locale} = 'en' THEN coalesce(p.name_en, p.name_bg) ELSE p.name_bg END AS name,
             CASE WHEN ${locale} = 'en' THEN coalesce(p.description_en, p.description_bg)
                  ELSE p.description_bg END AS description,
             p.kind, p.audience, p.price_cents, p.validity_days, p.validity_months, p.visits_count
        FROM club_plans p
       WHERE p.club_id = ${clubId}::uuid AND p.visibility = 'public' AND p.archived_at IS NULL
       ORDER BY p.sort_order, p.price_cents
    `),
    portalClasses(clubId),
    // Only a name and a bio, and only for staff who switched it on themselves —
    // never an e-mail, a role, a photo or the account behind it.
    db.execute(sql`
      SELECT coalesce(nullif(btrim(s.display_name), ''), nullif(btrim(u.display_name), '')) AS name,
             s.bio
        FROM club_staff s JOIN users u ON u.id = s.user_id
       WHERE s.club_id = ${clubId}::uuid AND s.public_profile
         AND coalesce(nullif(btrim(s.display_name), ''), nullif(btrim(u.display_name), '')) IS NOT NULL
       ORDER BY array_position(ARRAY['owner','manager','trainer','desk'], s.role), name
       LIMIT 24
    `),
    db.execute(sql`
      SELECT CASE WHEN ${locale} = 'en' THEN coalesce(q.question_en, q.question_bg)
                  ELSE q.question_bg END AS question,
             CASE WHEN ${locale} = 'en' THEN coalesce(q.answer_en, q.answer_bg)
                  ELSE q.answer_bg END AS answer
        FROM club_faq q
       WHERE q.club_id = ${clubId}::uuid
       ORDER BY q.sort_order, q.created_at
       LIMIT 30
    `),
  ]);
  return {
    id: clubId,
    accent: row.accent === 'coral' || row.accent === 'sky' ? row.accent : 'green',
    trainers: trainers.rows.map((t) => ({ name: String(t.name), bio: text(t.bio) })),
    faq: faq.rows.map((q) => ({ question: String(q.question), answer: String(q.answer) })),
    slug: String(row.slug),
    name: String(row.name),
    kind: String(row.kind) as ClubKind,
    tier: String(row.tier) as ClubTier,
    sports: (Array.isArray(row.sports) ? row.sports : []).map(String) as ClubSport[],
    municipalityId: row.municipality_id === null ? null : Number(row.municipality_id),
    hasLogo: row.has_logo === true,
    description: text(row.description),
    websiteUrl: text(row.website_url),
    publicEmail: text(row.public_email),
    publicPhone: text(row.public_phone),
    locations: locations.rows.map((l) => ({
      id: String(l.id),
      name: String(l.name),
      address: text(l.address),
      facilitySlug: text(l.facility_slug),
      facilityName: text(l.facility_name),
    })),
    plans: plans.rows.map((p) => ({
      id: String(p.id),
      name: String(p.name),
      description: text(p.description),
      kind: String(p.kind),
      audience: String(p.audience),
      priceCents: Number(p.price_cents),
      validityDays: p.validity_days === null ? null : Number(p.validity_days),
      validityMonths: p.validity_months === null ? null : Number(p.validity_months),
      visitsCount: p.visits_count === null ? null : Number(p.visits_count),
    })),
    classes,
  };
}

export interface PublicOccurrence extends PortalClass {
  classId: string;
  description: string | null;
  cancelled: boolean;
  clubId: string;
  clubSlug: string;
  clubName: string;
  facilitySlug: string | null;
}

/** One public class occurrence of a renderable club (the class page). */
export async function publicOccurrence(
  slug: string,
  occurrenceId: string,
  locale: string,
): Promise<PublicOccurrence | null> {
  const result = await getDb().execute(sql`
    SELECT o.id, o.class_id, k.title, k.description, k.sport, o.starts_at, o.ends_at, o.status,
           l.name AS location_name, k.trial_allowed,
           coalesce(nullif(btrim(sto.display_name), ''), nullif(btrim(uo.display_name), ''), nullif(btrim(stk.display_name), ''), nullif(btrim(uk.display_name), '')) AS instructor_name,
           coalesce(o.capacity, k.capacity) AS capacity,
           o.starts_at - make_interval(hours => k.booking_opens_hours) AS opens_at,
           (SELECT count(*) FILTER (WHERE bp.booking_status = 'going')::int FROM club_booking_positions bp
             WHERE bp.club_id = o.club_id AND bp.occurrence_id = o.id) AS going,
           (SELECT count(*) FILTER (WHERE bp.booking_status = 'waitlisted')::int FROM club_booking_positions bp
             WHERE bp.club_id = o.club_id AND bp.occurrence_id = o.id) AS waitlisted,
           c.id AS club_id, c.slug, ${NAME(locale)} AS club_name,
           CASE WHEN f.id IS NOT NULL AND ${publicFacilityVisible} THEN f.slug END AS facility_slug
      FROM club_class_occurrences o
      JOIN club_classes k ON k.id = o.class_id AND k.public
      JOIN clubs c ON c.id = o.club_id
      JOIN club_locations l ON l.id = k.location_id
      LEFT JOIN facilities f ON f.id = l.facility_id
      LEFT JOIN club_staff sto ON sto.club_id = o.club_id AND sto.user_id = o.instructor_user_id
      LEFT JOIN users uo ON uo.id = o.instructor_user_id
      LEFT JOIN club_staff stk ON stk.club_id = k.club_id AND stk.user_id = k.instructor_user_id
      LEFT JOIN users uk ON uk.id = k.instructor_user_id
     WHERE o.id = ${occurrenceId}::uuid AND c.slug = ${slug} AND ${clubRenderableSql('c')}
  `);
  const row = result.rows[0];
  if (!row) return null;
  const iso = (value: unknown) =>
    value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
  return {
    occurrenceId: String(row.id),
    classId: String(row.class_id),
    title: String(row.title),
    description: text(row.description),
    sport: String(row.sport) as ClubSport,
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    cancelled: row.status === 'cancelled',
    locationName: String(row.location_name),
    instructorName: text(row.instructor_name),
    capacity: row.capacity === null ? null : Number(row.capacity),
    going: Number(row.going ?? 0),
    waitlisted: Number(row.waitlisted ?? 0),
    bookingOpensAt: iso(row.opens_at),
    trialAllowed: row.trial_allowed === true,
    clubId: String(row.club_id),
    clubSlug: String(row.slug),
    clubName: String(row.club_name),
    facilitySlug: text(row.facility_slug),
  };
}

export interface FacilityClub {
  id: string;
  slug: string;
  name: string;
  tier: ClubTier;
  hasLogo: boolean;
  sports: ClubSport[];
  next: { occurrenceId: string; title: string; startsAt: string }[];
}

/**
 * Renderable clubs with an active location AT this facility, for the block on
 * its page — and only while the facility is itself public.
 */
export async function facilityClubs(facilityId: string, locale: string): Promise<FacilityClub[]> {
  const result = await getDb().execute(sql`
    SELECT c.id, c.slug, ${NAME(locale)} AS name, c.tier, (c.logo_path IS NOT NULL) AS has_logo,
           c.sports,
           coalesce((
             SELECT json_agg(n ORDER BY n.starts_at) FROM (
               SELECT o.id AS occurrence_id, k.title, o.starts_at
                 FROM club_class_occurrences o JOIN club_classes k ON k.id = o.class_id
                WHERE o.club_id = c.id AND k.location_id = l.id AND k.public
                  AND o.status = 'scheduled' AND o.starts_at > now()
                ORDER BY o.starts_at LIMIT 2) n), '[]'::json) AS next
      FROM club_locations l
      JOIN clubs c ON c.id = l.club_id
      JOIN facilities f ON f.id = l.facility_id
     WHERE l.facility_id = ${facilityId}::uuid AND l.active
       AND ${clubRenderableSql('c')} AND ${publicFacilityVisible}
     ORDER BY lower(c.name_bg)
     LIMIT 6
  `);
  return result.rows.map((row) => ({
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    tier: String(row.tier) as ClubTier,
    hasLogo: row.has_logo === true,
    sports: (Array.isArray(row.sports) ? row.sports : []).map(String) as ClubSport[],
    next: (Array.isArray(row.next) ? row.next : []).map((n: Record<string, unknown>) => ({
      occurrenceId: String(n.occurrence_id),
      title: String(n.title),
      startsAt: new Date(String(n.starts_at)).toISOString(),
    })),
  }));
}
