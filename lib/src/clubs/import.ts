import { isIsoDate, type IsoDate } from './dates.js';
import { parseEuroCents } from './money.js';

/**
 * A club's member list from another system — the pure half of the CSV import
 * (1club's "migration"; vedro and 1club both export a client CSV). The web
 * adapter (apps/web/lib/clubs/import.ts) reads the file, maps the columns and
 * commits; everything that decides WHAT a row means lives here, so it is
 * tested without a database.
 *
 * MATCHING IS DELIBERATELY TIMID (the municipal importer's rule): a false
 * CONFLICT — a human looks at it — beats a false MATCH, which would silently
 * pour one person's abonnement onto another's record. A row matches an
 * existing record only when exactly one record has its e-mail (or, with no
 * e-mail, exactly one has its phone) and nothing in the row points at a
 * different record. Two rows of the same file naming the same person are both
 * conflicts.
 *
 * No date of birth is read even when the source file has one: a minor is a
 * yes/no column (CLAUDE.md — DOB is never stored).
 */

export const CLUB_IMPORT_FIELDS = [
  'name',
  'email',
  'phone',
  'tags',
  'minor',
  'guardianEmail',
  'plan',
  'startsOn',
  'endsOn',
  'visitsLeft',
  'paid',
] as const;
export type ClubImportField = (typeof CLUB_IMPORT_FIELDS)[number];

export const MAX_CLUB_IMPORT_ROWS = 2000;

export interface ClubImportRow {
  /** 1-based line number in the file (the header is line 1). */
  line: number;
  displayName: string;
  email: string | null;
  phone: string | null;
  tags: string[];
  isMinor: boolean;
  guardianEmail: string | null;
  plan: string | null;
  startsOn: IsoDate | null;
  endsOn: IsoDate | null;
  visitsLeft: number | null;
  paidCents: number | null;
}

export type NormalizedImportRow =
  { ok: true; row: ClubImportRow } | { ok: false; line: number; errors: string[] };

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE = /^\+?[0-9 ()-]{5,32}$/;
const YES = new Set(['да', 'yes', 'y', '1', 'true', 'x', 'дете', 'minor']);

/** YYYY-MM-DD, DD.MM.YYYY or DD/MM/YYYY (Bulgarian exports use the dot). */
export function parseImportDate(raw: string): IsoDate | null {
  const value = raw.trim();
  if (isIsoDate(value)) return value;
  const match = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(value);
  if (!match) return null;
  const iso = `${match[3]}-${(match[2] as string).padStart(2, '0')}-${(match[1] as string).padStart(2, '0')}`;
  return isIsoDate(iso) ? iso : null;
}

function clean(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/** Digits only, with a leading 0 read as Bulgaria's +359 — for comparing. */
export function phoneKey(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('00')) return digits.slice(2);
  if (digits.startsWith('0')) return `359${digits.slice(1)}`;
  return digits;
}

export function normalizeImportRow(
  line: number,
  raw: Partial<Record<ClubImportField, string>>,
): NormalizedImportRow {
  const errors: string[] = [];
  const displayName = clean(raw.name);
  if (displayName === '') errors.push('name_required');
  else if (displayName.length > 120) errors.push('name_too_long');

  const emailRaw = clean(raw.email).toLowerCase();
  const email = emailRaw === '' ? null : emailRaw;
  if (email !== null && (!EMAIL.test(email) || email.length > 254)) errors.push('email_invalid');

  const phoneRaw = clean(raw.phone);
  const phone = phoneRaw === '' ? null : phoneRaw;
  if (phone !== null && !PHONE.test(phone)) errors.push('phone_invalid');

  // club_tags_valid: ≤ 20 tags, ≤ 30 characters, no commas, no duplicates
  // ignoring case — the first spelling wins.
  const tags: string[] = [];
  for (const tag of clean(raw.tags).split(/[;|]/)) {
    const value = tag.trim();
    if (value === '' || value.length > 30 || value.includes(',')) continue;
    if (tags.some((t) => t.toLowerCase() === value.toLowerCase())) continue;
    if (tags.length < 20) tags.push(value);
  }

  const isMinor = YES.has(clean(raw.minor).toLowerCase());
  const guardianRaw = clean(raw.guardianEmail).toLowerCase();
  const guardianEmail = guardianRaw === '' ? null : guardianRaw;
  if (guardianEmail !== null && !EMAIL.test(guardianEmail)) errors.push('guardian_invalid');
  if (guardianEmail !== null && !isMinor) errors.push('guardian_only_for_minors');

  const planRaw = clean(raw.plan);
  const plan = planRaw === '' ? null : planRaw;
  const startsRaw = clean(raw.startsOn);
  const startsOn = startsRaw === '' ? null : parseImportDate(startsRaw);
  if (startsRaw !== '' && startsOn === null) errors.push('date_invalid');
  const endsRaw = clean(raw.endsOn);
  const endsOn = endsRaw === '' ? null : parseImportDate(endsRaw);
  if (endsRaw !== '' && endsOn === null) errors.push('date_invalid');
  if (startsOn !== null && endsOn !== null && endsOn < startsOn) errors.push('dates_reversed');
  if (plan === null && (startsOn !== null || endsOn !== null)) errors.push('plan_required');

  const visitsRaw = clean(raw.visitsLeft);
  let visitsLeft: number | null = null;
  if (visitsRaw !== '') {
    visitsLeft = /^\d{1,3}$/.test(visitsRaw) ? Number(visitsRaw) : null;
    if (visitsLeft === null || visitsLeft > 500) errors.push('visits_invalid');
  }
  const paidRaw = clean(raw.paid);
  let paidCents: number | null = null;
  if (paidRaw !== '') {
    paidCents = parseEuroCents(paidRaw.replace(/\s*(€|eur|лв\.?)$/i, ''));
    if (paidCents === null) errors.push('price_invalid');
  }

  if (errors.length > 0) return { ok: false, line, errors: [...new Set(errors)] };
  return {
    ok: true,
    row: {
      line,
      displayName,
      email,
      phone,
      tags,
      isMinor,
      guardianEmail,
      plan,
      startsOn,
      endsOn,
      visitsLeft,
      paidCents,
    },
  };
}

export interface ExistingMember {
  id: string;
  email: string | null;
  phone: string | null;
}

export type ImportClass =
  | { kind: 'new' }
  | { kind: 'match'; memberId: string }
  | { kind: 'conflict'; reason: 'several_records' | 'email_phone_disagree' | 'duplicate_in_file' };

/** New / match / conflict for each valid row, in order. */
export function classifyImportRows(
  rows: readonly ClubImportRow[],
  existing: readonly ExistingMember[],
): ImportClass[] {
  const byEmail = new Map<string, string[]>();
  const byPhone = new Map<string, string[]>();
  for (const member of existing) {
    if (member.email) byEmail.set(member.email, [...(byEmail.get(member.email) ?? []), member.id]);
    if (member.phone) {
      const key = phoneKey(member.phone);
      byPhone.set(key, [...(byPhone.get(key) ?? []), member.id]);
    }
  }
  // The same person twice in one file: both rows wait for a human. A minor
  // shares the guardian's inbox, so only adults are keyed by e-mail here.
  const seen = new Map<string, number>();
  const identity = (row: ClubImportRow): string | null =>
    row.email && !row.isMinor
      ? `e:${row.email}`
      : row.phone && !row.isMinor
        ? `p:${phoneKey(row.phone)}`
        : null;
  for (const row of rows) {
    const key = identity(row);
    if (key) seen.set(key, (seen.get(key) ?? 0) + 1);
  }

  return rows.map((row): ImportClass => {
    const key = identity(row);
    if (key && (seen.get(key) ?? 0) > 1) return { kind: 'conflict', reason: 'duplicate_in_file' };
    // Minors are matched by name under the guardian's e-mail in the adapter;
    // here a minor row is always new unless the e-mail alone is unambiguous
    // AND the record is not an adult's — the adapter cannot tell, so: new.
    if (row.isMinor) return { kind: 'new' };
    const emailHits = row.email ? (byEmail.get(row.email) ?? []) : [];
    const phoneHits = row.phone ? (byPhone.get(phoneKey(row.phone)) ?? []) : [];
    if (emailHits.length > 1) return { kind: 'conflict', reason: 'several_records' };
    if (emailHits.length === 1) {
      const id = emailHits[0] as string;
      if (phoneHits.length > 0 && !phoneHits.includes(id)) {
        return { kind: 'conflict', reason: 'email_phone_disagree' };
      }
      return { kind: 'match', memberId: id };
    }
    if (row.email === null && phoneHits.length === 1) {
      return { kind: 'match', memberId: phoneHits[0] as string };
    }
    if (phoneHits.length > 1) return { kind: 'conflict', reason: 'several_records' };
    if (row.email !== null && phoneHits.length === 1) {
      // A new e-mail on a known phone: a person who changed address, or two
      // people sharing a phone. A human decides.
      return { kind: 'conflict', reason: 'email_phone_disagree' };
    }
    return { kind: 'new' };
  });
}

/**
 * Header aliases, so a vedro or 1club export maps itself. Compared with
 * csv.ts's guessColumn (case- and punctuation-insensitive). Bulgarian
 * aliases live in apps/web/lib/csv-columns.json with the others' (the i18n
 * gate wants Cyrillic out of code); these are the English/ASCII ones.
 */
export const CLUB_IMPORT_ASCII_ALIASES: Readonly<Record<ClubImportField, readonly string[]>> = {
  name: ['name', 'full name', 'fullname', 'client', 'member', 'first name last name', 'contact'],
  email: ['email', 'e-mail', 'mail', 'email address'],
  phone: ['phone', 'mobile', 'telephone', 'tel', 'phone number', 'gsm'],
  tags: ['tags', 'labels', 'groups', 'segment'],
  minor: ['minor', 'child', 'is minor', 'kid'],
  guardianEmail: ['guardian email', 'parent email', 'guardian', 'parent'],
  plan: ['plan', 'membership', 'subscription', 'card', 'package', 'pass'],
  startsOn: ['start', 'start date', 'starts', 'valid from', 'from'],
  endsOn: ['end', 'end date', 'expires', 'expiry', 'valid until', 'valid to', 'to'],
  visitsLeft: ['visits left', 'remaining visits', 'remaining', 'sessions left', 'credits'],
  paid: ['paid', 'amount paid', 'payment', 'price paid'],
};
