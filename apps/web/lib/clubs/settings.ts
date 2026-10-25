import { getDb, sql, type SQL } from '@sportkarta/db';

import { recordClubAudit } from './audit';
import type { ClubSettingsInput, FaqInput, InvoiceDetailsInput, LocationInput } from './input';
import { clubActorMay, clubScope, clubWriteScope, type ClubActor } from './scope';

/**
 * A club's own settings: identity, the public-page switch, booking defaults
 * and locations. Every write embeds the actor's scope and the club's
 * entitlement (scope.ts) — a lapsed or pending club changes nothing here.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TransactionalDb extends SqlRunner {
  transaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export interface ClubSettings extends ClubSettingsInput {
  slug: string;
  visible: boolean;
  logoPath: string | null;
  termsUrl: string | null;
  /** What an invoice prints about the club (0050), beside legalName and eik. */
  invoiceDetails: InvoiceDetailsInput;
}

export async function clubSettings(clubId: string): Promise<ClubSettings | null> {
  const result = await getDb().execute(sql`
    SELECT slug, name_bg, name_en, kind, description_bg, description_en, sports, municipality_id,
           website_url, public_email, public_phone, legal_name, eik, locale,
           booking_opens_hours, cancel_deadline_hours, mail_unlinked_members, visible, logo_path,
           accent, terms_url, ist.legal_address, ist.vat_number, ist.iban, ist.invoice_vat_bp,
           ist.zero_vat_basis
      FROM clubs
      LEFT JOIN club_invoice_settings ist ON ist.club_id = clubs.id
     WHERE clubs.id = ${clubId}::uuid
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    slug: String(row.slug),
    nameBg: String(row.name_bg),
    nameEn: text(row.name_en),
    kind: String(row.kind) as ClubSettings['kind'],
    descriptionBg: text(row.description_bg),
    descriptionEn: text(row.description_en),
    sports: (Array.isArray(row.sports) ? row.sports.map(String) : []) as ClubSettings['sports'],
    municipalityId: row.municipality_id === null ? null : Number(row.municipality_id),
    websiteUrl: text(row.website_url),
    publicEmail: text(row.public_email),
    publicPhone: text(row.public_phone),
    legalName: text(row.legal_name),
    eik: text(row.eik),
    locale: row.locale === 'en' ? 'en' : 'bg',
    bookingOpensHours: Number(row.booking_opens_hours),
    cancelDeadlineHours: Number(row.cancel_deadline_hours),
    mailUnlinkedMembers: row.mail_unlinked_members === true,
    accent: row.accent === 'coral' || row.accent === 'sky' ? row.accent : 'green',
    visible: row.visible === true,
    logoPath: text(row.logo_path),
    termsUrl: text(row.terms_url),
    invoiceDetails: {
      legalAddress: text(row.legal_address),
      vatNumber: text(row.vat_number),
      iban: text(row.iban),
      invoiceVatBp: [0, 900, 2000].includes(Number(row.invoice_vat_bp))
        ? (Number(row.invoice_vat_bp) as InvoiceDetailsInput['invoiceVatBp'])
        : 2000,
      zeroVatBasis: text(row.zero_vat_basis),
    },
  };
}

/** What an invoice prints about the club (0050). settings.manage. */
export async function saveInvoiceDetails(
  db: TransactionalDb,
  actor: ClubActor,
  input: InvoiceDetailsInput,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      INSERT INTO club_invoice_settings (club_id, legal_address, vat_number, iban, invoice_vat_bp,
                                         zero_vat_basis)
      SELECT ${actor.clubId}::uuid, ${input.legalAddress}, ${input.vatNumber}, ${input.iban},
             ${input.invoiceVatBp}, ${input.zeroVatBasis}
       WHERE ${clubActorMay(actor, 'settings.manage', { write: true })}
      ON CONFLICT (club_id) DO UPDATE
        SET legal_address = EXCLUDED.legal_address, vat_number = EXCLUDED.vat_number,
            iban = EXCLUDED.iban, invoice_vat_bp = EXCLUDED.invoice_vat_bp,
            zero_vat_basis = EXCLUDED.zero_vat_basis
      RETURNING club_id
    `);
    if (updated.rows.length === 0) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'settings_changed',
      detail: { part: 'invoices' },
    });
    return true;
  });
}

/** The club's terms of sale for online payments (0046). settings.manage. */
export async function saveTermsUrl(
  db: TransactionalDb,
  actor: ClubActor,
  termsUrl: string | null,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE clubs c SET terms_url = ${termsUrl}
       WHERE c.id = ${actor.clubId}::uuid
         AND ${clubActorMay(actor, 'settings.manage', { write: true })}
      RETURNING c.id
    `);
    if (updated.rows.length === 0) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'settings_changed',
      detail: { part: 'terms' },
    });
    return true;
  });
}

export async function updateClubSettings(
  db: TransactionalDb,
  actor: ClubActor,
  input: ClubSettingsInput,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE clubs c
         SET name_bg = ${input.nameBg}, name_en = ${input.nameEn}, kind = ${input.kind},
             description_bg = ${input.descriptionBg}, description_en = ${input.descriptionEn},
             sports = ${sql.param(input.sports)}::text[], municipality_id = ${input.municipalityId},
             website_url = ${input.websiteUrl}, public_email = ${input.publicEmail},
             public_phone = ${input.publicPhone}, legal_name = ${input.legalName}, eik = ${input.eik},
             locale = ${input.locale}, booking_opens_hours = ${input.bookingOpensHours},
             cancel_deadline_hours = ${input.cancelDeadlineHours},
             mail_unlinked_members = ${input.mailUnlinkedMembers}, accent = ${input.accent}
       WHERE c.id = ${actor.clubId}::uuid
         AND ${clubActorMay(actor, 'settings.manage', { write: true })}
       RETURNING c.id
    `);
    if (updated.rows.length === 0) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'settings_changed',
      detail: { part: 'identity' },
    });
    return true;
  });
}

/** The owner's publish switch. Target state, so a double submit settles. */
export async function setClubVisible(
  db: TransactionalDb,
  actor: ClubActor,
  visible: boolean,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE clubs c SET visible = ${visible}
       WHERE c.id = ${actor.clubId}::uuid AND c.visible IS DISTINCT FROM ${visible}
         AND ${clubActorMay(actor, 'settings.manage', { write: true })}
       RETURNING c.id
    `);
    if (updated.rows.length === 0) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'settings_changed',
      detail: { part: 'visible', visible },
    });
    return true;
  });
}

export async function setClubLogo(
  db: TransactionalDb,
  actor: ClubActor,
  logoPath: string | null,
): Promise<{ ok: boolean; previous: string | null }> {
  return db.transaction(async (tx) => {
    const previous = await tx.execute(sql`
      SELECT logo_path FROM clubs WHERE id = ${actor.clubId}::uuid FOR UPDATE
    `);
    const updated = await tx.execute(sql`
      UPDATE clubs c SET logo_path = ${logoPath}
       WHERE c.id = ${actor.clubId}::uuid
         AND ${clubActorMay(actor, 'settings.manage', { write: true })}
       RETURNING c.id
    `);
    if (updated.rows.length === 0) return { ok: false, previous: null };
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'settings_changed',
      detail: { part: 'logo' },
    });
    return { ok: true, previous: text(previous.rows[0]?.logo_path) };
  });
}

// ─── Locations ─────────────────────────────────────────────────────────────

export interface ClubLocation {
  id: string;
  name: string;
  address: string | null;
  facilityId: string | null;
  facilityName: string | null;
  facilitySlug: string | null;
  active: boolean;
}

export async function clubLocations(
  actor: ClubActor,
  options: { includeArchived?: boolean } = {},
): Promise<ClubLocation[]> {
  const result = await getDb().execute(sql`
    SELECT l.id, l.name, l.address, l.facility_id, l.active, f.name AS facility_name,
           f.slug AS facility_slug
      FROM club_locations l
      LEFT JOIN facilities f ON f.id = l.facility_id
     WHERE ${clubScope(actor, 'office.view', 'l')}
       ${options.includeArchived ? sql`` : sql`AND l.active`}
     ORDER BY l.active DESC, l.sort_order, l.name
  `);
  return result.rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    address: text(row.address),
    facilityId: text(row.facility_id),
    facilityName: text(row.facility_name),
    facilitySlug: text(row.facility_slug),
    active: row.active === true,
  }));
}

export async function saveLocation(
  db: TransactionalDb,
  actor: ClubActor,
  locationId: string | null,
  input: LocationInput,
): Promise<string | null> {
  return db.transaction(async (tx) => {
    const result = locationId
      ? await tx.execute(sql`
          UPDATE club_locations l
             SET name = ${input.name}, facility_id = ${input.facilityId}::uuid,
                 address = ${input.address}
           WHERE l.id = ${locationId}::uuid AND ${clubWriteScope(actor, 'settings.manage', 'l')}
           RETURNING l.id
        `)
      : await tx.execute(sql`
          INSERT INTO club_locations (club_id, name, facility_id, address)
          SELECT ${actor.clubId}::uuid, ${input.name}, ${input.facilityId}::uuid, ${input.address}
           WHERE ${clubActorMay(actor, 'settings.manage', { write: true })}
          RETURNING id
        `);
    const id = text(result.rows[0]?.id);
    if (!id) return null;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'location_saved',
      detail: { locationId: id },
    });
    return id;
  });
}

/** Locations with history are archived, never deleted (classes and check-ins point at them). */
export async function setLocationActive(
  db: TransactionalDb,
  actor: ClubActor,
  locationId: string,
  active: boolean,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE club_locations l SET active = ${active}
       WHERE l.id = ${locationId}::uuid AND l.active IS DISTINCT FROM ${active}
         AND ${clubWriteScope(actor, 'settings.manage', 'l')}
       RETURNING l.id
    `);
    if (updated.rows.length === 0) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: active ? 'location_saved' : 'location_archived',
      detail: { locationId },
    });
    return true;
  });
}

export interface FacilityChoice {
  id: string;
  name: string;
  slug: string | null;
  cityBg: string | null;
}

/**
 * Named, non-gone map facilities to link a location to, by name, optionally
 * within the club's municipality. Only the facility's own public fields.
 */
export async function searchFacilities(
  query: string,
  municipalityId: number | null,
): Promise<FacilityChoice[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const result = await getDb().execute(sql`
    SELECT f.id, f.name, f.slug, m.name_bg AS city_bg
      FROM facilities f
      LEFT JOIN municipalities m ON m.id = f.municipality_id
     WHERE f.name ILIKE ${pattern} AND f.status <> 'gone'
       ${municipalityId === null ? sql`` : sql`AND f.municipality_id = ${municipalityId}`}
     ORDER BY f.name
     LIMIT 30
  `);
  return result.rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    slug: text(row.slug),
    cityBg: text(row.city_bg),
  }));
}

/** Named, non-gone facilities of one municipality, for the location picker. */
export async function facilitiesInMunicipality(
  municipalityId: number | null,
  includeId: string | null = null,
): Promise<FacilityChoice[]> {
  if (municipalityId === null && includeId === null) return [];
  const result = await getDb().execute(sql`
    SELECT f.id, f.name, f.slug, m.name_bg AS city_bg
      FROM facilities f
      LEFT JOIN municipalities m ON m.id = f.municipality_id
     WHERE f.name IS NOT NULL AND f.status <> 'gone'
       AND (${municipalityId === null ? sql`FALSE` : sql`f.municipality_id = ${municipalityId}`}
            OR f.id = ${includeId}::uuid)
     ORDER BY f.name
     LIMIT 400
  `);
  return result.rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    slug: text(row.slug),
    cityBg: text(row.city_bg),
  }));
}

/** Every municipality, for the city select (name in the page's language). */
export async function municipalityChoices(): Promise<
  { id: number; nameBg: string; nameEn: string }[]
> {
  const result = await getDb().execute(
    sql`SELECT id, name_bg, name_en FROM municipalities ORDER BY name_bg`,
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    nameBg: String(row.name_bg),
    nameEn: String(row.name_en),
  }));
}

// ─── The club's FAQ on its public page (0045) ──────────────────────────────

export interface ClubFaqEntry extends FaqInput {
  id: string;
}

export async function clubFaq(actor: ClubActor): Promise<ClubFaqEntry[]> {
  const result = await getDb().execute(sql`
    SELECT q.id, q.question_bg, q.answer_bg, q.question_en, q.answer_en, q.sort_order
      FROM club_faq q
     WHERE ${clubScope(actor, 'settings.manage', 'q')}
     ORDER BY q.sort_order, q.created_at
  `);
  return result.rows.map((row) => ({
    id: String(row.id),
    questionBg: String(row.question_bg),
    answerBg: String(row.answer_bg),
    questionEn: text(row.question_en),
    answerEn: text(row.answer_en),
    sortOrder: Number(row.sort_order),
  }));
}

/** At most this many questions per club — a page, not a knowledge base. */
export const MAX_FAQ = 30;

export async function saveFaq(
  db: TransactionalDb,
  actor: ClubActor,
  faqId: string | null,
  input: FaqInput,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const values = sql`${input.questionBg}, ${input.answerBg}, ${input.questionEn},
      ${input.answerEn}, ${input.sortOrder}`;
    const saved = faqId
      ? await tx.execute(sql`
          UPDATE club_faq q
             SET (question_bg, answer_bg, question_en, answer_en, sort_order) = (${values})
           WHERE q.id = ${faqId}::uuid AND ${clubWriteScope(actor, 'settings.manage', 'q')}
          RETURNING q.id`)
      : await tx.execute(sql`
          INSERT INTO club_faq (club_id, question_bg, answer_bg, question_en, answer_en, sort_order)
          SELECT ${actor.clubId}::uuid, ${values}
           WHERE ${clubActorMay(actor, 'settings.manage', { write: true })}
             AND (SELECT count(*) FROM club_faq WHERE club_id = ${actor.clubId}::uuid) < ${MAX_FAQ}
          RETURNING id`);
    if (saved.rows.length === 0) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'faq_saved',
      detail: {},
    });
    return true;
  });
}

export async function removeFaq(
  db: TransactionalDb,
  actor: ClubActor,
  faqId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const removed = await tx.execute(sql`
      DELETE FROM club_faq q
       WHERE q.id = ${faqId}::uuid AND ${clubWriteScope(actor, 'settings.manage', 'q')}
      RETURNING q.id
    `);
    if (removed.rows.length === 0) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'faq_removed',
      detail: {},
    });
    return true;
  });
}
