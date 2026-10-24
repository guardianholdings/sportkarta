import {
  CLUB_CANCEL_REASONS,
  CLUB_KINDS,
  CLUB_PAYMENT_METHODS,
  CLUB_PLAN_AUDIENCES,
  CLUB_PLAN_KINDS,
  CLUB_ROLES,
  CLUB_TIERS,
  addDaysIso,
  isClubSport,
  isIsoDate,
  parseEuroCents,
  type ClubCancelReason,
  type ClubKind,
  type ClubPaymentMethod,
  type ClubPlanAudience,
  type ClubPlanKind,
  type ClubRole,
  type ClubSport,
  type ClubTier,
  type IsoDate,
} from '@sportkarta/lib/clubs';
import {
  SOFIA_TZ,
  WEEKDAY_CODES,
  formatRrule,
  zonedToInstant,
  type WeekdayCode,
} from '@sportkarta/lib/recurrence';

/**
 * Every club form, from FormData to a typed value — or to the COMPLETE list of
 * what is wrong with it, in one pass, so a form shows every problem at once
 * above the input the person typed (useFormAction keeps it).
 *
 * Pure: no database, no session. The shapes mirror the CHECKs of 0039–0044 so
 * a value that passes here is one the database accepts; the database remains
 * the authority (a CHECK violation that slips through is a 500 and a bug, not
 * a user error).
 *
 * Error codes are i18n key suffixes under `ClubForm.error.*`.
 */

export type InputResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

interface Reader {
  get(name: string): FormDataEntryValue | null;
  getAll(name: string): FormDataEntryValue[];
}

function text(form: Reader, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function optionalText(form: Reader, name: string): string | null {
  const value = text(form, name);
  return value === '' ? null : value;
}

function checked(form: Reader, name: string): boolean {
  const value = form.get(name);
  return value === 'on' || value === 'true' || value === '1';
}

function oneOf<T extends string>(value: string, allowed: readonly T[]): T | null {
  return (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function intInRange(raw: string, min: number, max: number): number | null {
  if (!/^\d{1,9}$/.test(raw)) return null;
  const value = Number(raw);
  return value >= min && value <= max ? value : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function optionalUuid(form: Reader, name: string): string | null | 'invalid' {
  const value = text(form, name);
  if (value === '') return null;
  return isUuid(value) ? value.toLowerCase() : 'invalid';
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE = /^\+?[0-9 ()-]{5,32}$/;

function email(raw: string | null, errors: string[], code = 'email_invalid'): string | null {
  if (raw === null) return null;
  const value = raw.toLowerCase();
  if (value.length > 254 || !EMAIL.test(value)) {
    errors.push(code);
    return null;
  }
  return value;
}

function phone(raw: string | null, errors: string[]): string | null {
  if (raw === null) return null;
  if (!PHONE.test(raw)) {
    errors.push('phone_invalid');
    return null;
  }
  return raw;
}

function bounded(raw: string | null, max: number, errors: string[], code: string): string | null {
  if (raw === null) return null;
  if (raw.length > max) {
    errors.push(code);
    return null;
  }
  return raw;
}

function required(raw: string, max: number, errors: string[], code: string): string {
  if (raw === '') errors.push(`${code}_required`);
  else if (raw.length > max) errors.push(`${code}_too_long`);
  return raw;
}

function website(raw: string | null, errors: string[]): string | null {
  if (raw === null) return null;
  const value = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || value.length > 300) {
      throw new Error('bad');
    }
    if (/\s/.test(value)) throw new Error('bad');
    return url.toString();
  } catch {
    errors.push('website_invalid');
    return null;
  }
}

function sports(form: Reader, errors: string[], max: number): ClubSport[] {
  const values = [
    ...new Set(form.getAll('sports').filter((v): v is string => typeof v === 'string')),
  ];
  const valid = values.filter(isClubSport);
  if (valid.length !== values.length) errors.push('sport_invalid');
  if (valid.length > max) errors.push('sports_too_many');
  return valid.slice(0, max);
}

// ─── Application (/klubove/zayavka) ────────────────────────────────────────

export interface ApplicationInput {
  nameBg: string;
  kind: ClubKind;
  tier: ClubTier;
  municipalityId: number | null;
  sports: ClubSport[];
  websiteUrl: string | null;
  descriptionBg: string | null;
}

export function parseApplication(form: Reader): InputResult<ApplicationInput> {
  const errors: string[] = [];
  const nameBg = required(text(form, 'name'), 120, errors, 'name');
  const kind = oneOf(text(form, 'kind'), CLUB_KINDS);
  if (!kind) errors.push('kind_invalid');
  const tier = oneOf(text(form, 'tier'), CLUB_TIERS);
  if (!tier) errors.push('tier_invalid');
  const municipalityRaw = text(form, 'municipalityId');
  const municipalityId = municipalityRaw === '' ? null : intInRange(municipalityRaw, 1, 100_000);
  if (municipalityRaw !== '' && municipalityId === null) errors.push('city_invalid');
  const chosen = sports(form, errors, 12);
  const websiteUrl = website(optionalText(form, 'website'), errors);
  const descriptionBg = bounded(
    optionalText(form, 'description'),
    2000,
    errors,
    'description_too_long',
  );
  if (!checked(form, 'acceptTerms')) errors.push('terms_required');
  if (errors.length > 0 || !kind || !tier) return { ok: false, errors };
  return {
    ok: true,
    value: { nameBg, kind, tier, municipalityId, sports: chosen, websiteUrl, descriptionBg },
  };
}

// ─── Club settings ─────────────────────────────────────────────────────────

export interface ClubSettingsInput {
  nameBg: string;
  nameEn: string | null;
  kind: ClubKind;
  descriptionBg: string | null;
  descriptionEn: string | null;
  sports: ClubSport[];
  municipalityId: number | null;
  websiteUrl: string | null;
  publicEmail: string | null;
  publicPhone: string | null;
  legalName: string | null;
  eik: string | null;
  locale: 'bg' | 'en';
  bookingOpensHours: number;
  cancelDeadlineHours: number;
  mailUnlinkedMembers: boolean;
}

export function parseClubSettings(form: Reader): InputResult<ClubSettingsInput> {
  const errors: string[] = [];
  const nameBg = required(text(form, 'nameBg'), 120, errors, 'name');
  const nameEn = bounded(optionalText(form, 'nameEn'), 120, errors, 'name_too_long');
  const kind = oneOf(text(form, 'kind'), CLUB_KINDS);
  if (!kind) errors.push('kind_invalid');
  const descriptionBg = bounded(
    optionalText(form, 'descriptionBg'),
    2000,
    errors,
    'description_too_long',
  );
  const descriptionEn = bounded(
    optionalText(form, 'descriptionEn'),
    2000,
    errors,
    'description_too_long',
  );
  const chosen = sports(form, errors, 12);
  const municipalityRaw = text(form, 'municipalityId');
  const municipalityId = municipalityRaw === '' ? null : intInRange(municipalityRaw, 1, 100_000);
  if (municipalityRaw !== '' && municipalityId === null) errors.push('city_invalid');
  const websiteUrl = website(optionalText(form, 'website'), errors);
  const publicEmail = email(optionalText(form, 'publicEmail'), errors);
  const publicPhone = phone(optionalText(form, 'publicPhone'), errors);
  const legalName = bounded(optionalText(form, 'legalName'), 200, errors, 'legal_name_too_long');
  const eikRaw = optionalText(form, 'eik');
  const eik = eikRaw === null ? null : /^(\d{9}|\d{13})$/.test(eikRaw) ? eikRaw : null;
  if (eikRaw !== null && eik === null) errors.push('eik_invalid');
  const locale = text(form, 'locale') === 'en' ? 'en' : 'bg';
  const opensDays = intInRange(text(form, 'bookingOpensDays') || '7', 1, 90);
  if (opensDays === null) errors.push('booking_window_invalid');
  const deadline = intInRange(text(form, 'cancelDeadlineHours') || '2', 0, 168);
  if (deadline === null) errors.push('cancel_deadline_invalid');
  if (errors.length > 0 || !kind || opensDays === null || deadline === null) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      nameBg,
      nameEn,
      kind,
      descriptionBg,
      descriptionEn,
      sports: chosen,
      municipalityId,
      websiteUrl,
      publicEmail,
      publicPhone,
      legalName,
      eik,
      locale,
      bookingOpensHours: opensDays * 24,
      cancelDeadlineHours: deadline,
      mailUnlinkedMembers: checked(form, 'mailUnlinkedMembers'),
    },
  };
}

export interface LocationInput {
  name: string;
  facilityId: string | null;
  address: string | null;
}

export function parseLocation(form: Reader): InputResult<LocationInput> {
  const errors: string[] = [];
  const name = required(text(form, 'name'), 120, errors, 'location_name');
  const facilityId = optionalUuid(form, 'facilityId');
  if (facilityId === 'invalid') errors.push('facility_invalid');
  const address = bounded(optionalText(form, 'address'), 300, errors, 'address_too_long');
  if (errors.length > 0 || facilityId === 'invalid') return { ok: false, errors };
  return { ok: true, value: { name, facilityId, address } };
}

// ─── Staff ─────────────────────────────────────────────────────────────────

export interface StaffInviteInput {
  email: string;
  role: ClubRole;
}

export function parseStaffInvite(form: Reader): InputResult<StaffInviteInput> {
  const errors: string[] = [];
  const address = email(optionalText(form, 'email'), errors);
  if (address === null && !errors.includes('email_invalid')) errors.push('email_required');
  const role = oneOf(text(form, 'role'), CLUB_ROLES);
  if (!role) errors.push('role_invalid');
  if (errors.length > 0 || !role || address === null) return { ok: false, errors };
  return { ok: true, value: { email: address, role } };
}

// ─── Members ───────────────────────────────────────────────────────────────

export interface MemberInput {
  displayName: string;
  email: string | null;
  phone: string | null;
  isMinor: boolean;
  guardianMemberId: string | null;
  tags: string[];
  staffNote: string | null;
}

export function parseTags(raw: string): string[] | null {
  const tags = raw
    .split(',')
    .map((tag) => tag.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    if (tag.length > 30) return null;
    const key = tag.toLocaleLowerCase('bg');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out.length > 20 ? null : out;
}

export function parseMember(form: Reader): InputResult<MemberInput> {
  const errors: string[] = [];
  const displayName = required(text(form, 'displayName'), 120, errors, 'member_name');
  const address = email(optionalText(form, 'email'), errors);
  const number = phone(optionalText(form, 'phone'), errors);
  const isMinor = checked(form, 'isMinor');
  const guardian = optionalUuid(form, 'guardianMemberId');
  if (guardian === 'invalid') errors.push('guardian_invalid');
  if (guardian && guardian !== 'invalid' && !isMinor) errors.push('guardian_needs_minor');
  const tags = parseTags(text(form, 'tags'));
  if (tags === null) errors.push('tags_invalid');
  const staffNote = bounded(optionalText(form, 'staffNote'), 1000, errors, 'note_too_long');
  if (errors.length > 0 || guardian === 'invalid' || tags === null) return { ok: false, errors };
  return {
    ok: true,
    value: {
      displayName,
      email: address,
      phone: number,
      isMinor,
      guardianMemberId: isMinor ? guardian : null,
      tags,
      staffNote,
    },
  };
}

// ─── Plans ─────────────────────────────────────────────────────────────────

export interface PlanInput {
  nameBg: string;
  nameEn: string | null;
  descriptionBg: string | null;
  descriptionEn: string | null;
  kind: ClubPlanKind;
  audience: ClubPlanAudience;
  priceCents: number;
  validityDays: number | null;
  validityMonths: number | null;
  visitsCount: number | null;
  visibility: 'public' | 'private';
}

export function parsePlan(form: Reader): InputResult<PlanInput> {
  const errors: string[] = [];
  const nameBg = required(text(form, 'nameBg'), 80, errors, 'plan_name');
  const nameEn = bounded(optionalText(form, 'nameEn'), 80, errors, 'plan_name_too_long');
  const descriptionBg = bounded(
    optionalText(form, 'descriptionBg'),
    500,
    errors,
    'description_too_long',
  );
  const descriptionEn = bounded(
    optionalText(form, 'descriptionEn'),
    500,
    errors,
    'description_too_long',
  );
  const kind = oneOf(text(form, 'kind'), CLUB_PLAN_KINDS);
  if (!kind) errors.push('plan_kind_invalid');
  const audience = oneOf(text(form, 'audience') || 'all', CLUB_PLAN_AUDIENCES);
  if (!audience) errors.push('audience_invalid');
  const priceCents = parseEuroCents(text(form, 'price'));
  if (priceCents === null) errors.push('price_invalid');
  const unit = text(form, 'validityUnit') === 'days' ? 'days' : 'months';
  const amount =
    unit === 'days'
      ? intInRange(text(form, 'validityAmount'), 1, 366)
      : intInRange(text(form, 'validityAmount'), 1, 24);
  if (amount === null) errors.push('validity_invalid');
  const visitsRaw = text(form, 'visitsCount');
  let visitsCount: number | null = null;
  if (kind === 'visits' || (kind === 'trial' && visitsRaw !== '')) {
    visitsCount = intInRange(visitsRaw, 1, 500);
    if (visitsCount === null) errors.push('visits_invalid');
  }
  const visibility = text(form, 'visibility') === 'private' ? 'private' : 'public';
  if (errors.length > 0 || !kind || !audience || priceCents === null || amount === null) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      nameBg,
      nameEn,
      descriptionBg,
      descriptionEn,
      kind,
      audience,
      priceCents,
      validityDays: unit === 'days' ? amount : null,
      validityMonths: unit === 'months' ? amount : null,
      visitsCount,
      visibility,
    },
  };
}

// ─── Sales, payments ───────────────────────────────────────────────────────

export interface PaymentPart {
  method: ClubPaymentMethod;
  amountCents: number;
  receivedOn: IsoDate;
}

export interface SaleInput {
  memberId: string;
  planId: string;
  startsOn: IsoDate;
  /** Paid at the desk now; null = an open charge, due on `dueOn`. */
  payment: PaymentPart | null;
  dueOn: IsoDate;
}

function isoDateField(form: Reader, name: string, errors: string[], code: string): IsoDate | null {
  const value = text(form, name);
  if (!isIsoDate(value)) {
    errors.push(code);
    return null;
  }
  return value;
}

export function parseSale(form: Reader, today: IsoDate): InputResult<SaleInput> {
  const errors: string[] = [];
  const memberId = text(form, 'memberId');
  if (!isUuid(memberId)) errors.push('member_required');
  const planId = text(form, 'planId');
  if (!isUuid(planId)) errors.push('plan_required');
  const startsOn = isoDateField(form, 'startsOn', errors, 'starts_on_invalid');
  let payment: PaymentPart | null = null;
  if (text(form, 'payNow') !== 'later') {
    const method = oneOf(text(form, 'method'), CLUB_PAYMENT_METHODS);
    if (!method) errors.push('method_invalid');
    const amountCents = parseEuroCents(text(form, 'amount'));
    if (amountCents === null || amountCents === 0) errors.push('amount_invalid');
    const receivedOn = text(form, 'receivedOn') || today;
    if (!isIsoDate(receivedOn) || receivedOn > today) errors.push('received_on_invalid');
    if (method && amountCents && isIsoDate(receivedOn)) {
      payment = { method, amountCents, receivedOn };
    }
  }
  const dueRaw = text(form, 'dueOn');
  const dueOn = dueRaw === '' ? addDaysIso(startsOn ?? today, 7) : dueRaw;
  if (!isIsoDate(dueOn)) errors.push('due_on_invalid');
  if (errors.length > 0 || !startsOn || !isIsoDate(dueOn)) return { ok: false, errors };
  return {
    ok: true,
    value: {
      memberId: memberId.toLowerCase(),
      planId: planId.toLowerCase(),
      startsOn,
      payment,
      dueOn,
    },
  };
}

export interface PaymentInput extends PaymentPart {
  chargeId: string;
  kind: 'payment' | 'refund';
}

export function parsePayment(form: Reader, today: IsoDate): InputResult<PaymentInput> {
  const errors: string[] = [];
  const chargeId = text(form, 'chargeId');
  if (!isUuid(chargeId)) errors.push('charge_required');
  const kind = text(form, 'kind') === 'refund' ? 'refund' : 'payment';
  const method = oneOf(text(form, 'method'), CLUB_PAYMENT_METHODS);
  if (!method) errors.push('method_invalid');
  const amountCents = parseEuroCents(text(form, 'amount'));
  if (amountCents === null || amountCents === 0) errors.push('amount_invalid');
  const receivedOn = text(form, 'receivedOn') || today;
  if (!isIsoDate(receivedOn) || receivedOn > today) errors.push('received_on_invalid');
  if (errors.length > 0 || !method || !amountCents) return { ok: false, errors };
  return {
    ok: true,
    value: {
      chargeId: chargeId.toLowerCase(),
      kind,
      method,
      amountCents: kind === 'refund' ? -amountCents : amountCents,
      receivedOn,
    },
  };
}

export interface ChargeInput {
  memberId: string;
  label: string;
  amountCents: number;
  dueOn: IsoDate;
}

export function parseCharge(form: Reader, today: IsoDate): InputResult<ChargeInput> {
  const errors: string[] = [];
  const memberId = text(form, 'memberId');
  if (!isUuid(memberId)) errors.push('member_required');
  const label = required(text(form, 'label'), 120, errors, 'charge_label');
  const amountCents = parseEuroCents(text(form, 'amount'));
  if (amountCents === null || amountCents === 0) errors.push('amount_invalid');
  const dueOn = text(form, 'dueOn') || today;
  if (!isIsoDate(dueOn) || dueOn < today) errors.push('due_on_invalid');
  if (errors.length > 0 || !amountCents) return { ok: false, errors };
  return { ok: true, value: { memberId: memberId.toLowerCase(), label, amountCents, dueOn } };
}

export interface CancelMembershipInput {
  membershipId: string;
  reason: ClubCancelReason;
}

export function parseCancelMembership(form: Reader): InputResult<CancelMembershipInput> {
  const membershipId = text(form, 'membershipId');
  const reason = oneOf(text(form, 'reason'), CLUB_CANCEL_REASONS);
  const errors: string[] = [];
  if (!isUuid(membershipId)) errors.push('membership_required');
  if (!reason) errors.push('reason_invalid');
  if (errors.length > 0 || !reason) return { ok: false, errors };
  return { ok: true, value: { membershipId: membershipId.toLowerCase(), reason } };
}

export interface PauseInput {
  membershipId: string;
  startsOn: IsoDate;
  endsOn: IsoDate;
}

export function parsePause(form: Reader): InputResult<PauseInput> {
  const errors: string[] = [];
  const membershipId = text(form, 'membershipId');
  if (!isUuid(membershipId)) errors.push('membership_required');
  const startsOn = isoDateField(form, 'startsOn', errors, 'starts_on_invalid');
  const endsOn = isoDateField(form, 'endsOn', errors, 'ends_on_invalid');
  if (startsOn && endsOn && endsOn < startsOn) errors.push('pause_order');
  if (startsOn && endsOn && addDaysIso(startsOn, 179) < endsOn) errors.push('pause_too_long');
  if (errors.length > 0 || !startsOn || !endsOn) return { ok: false, errors };
  return { ok: true, value: { membershipId: membershipId.toLowerCase(), startsOn, endsOn } };
}

// ─── Classes ───────────────────────────────────────────────────────────────

export interface ClassInput {
  title: string;
  description: string | null;
  sport: ClubSport;
  locationId: string;
  instructorUserId: string | null;
  /** `YYYY-MM-DD HH:MM:00`, a Sofia wall clock. */
  startsAtLocal: string;
  rrule: string | null;
  durationMinutes: number;
  capacity: number | null;
  bookingOpensHours: number;
  cancelDeadlineHours: number;
  dropInPriceCents: number | null;
  coversAllPlans: boolean;
  planIds: string[];
  trialAllowed: boolean;
  public: boolean;
}

function isoWeekdayOf(date: IsoDate): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
}

/**
 * The class editor's fields to a stored series. Weekdays empty = a one-off on
 * the first date. Otherwise FREQ=WEEKLY;BYDAY=…, formatted by
 * lib/src/recurrence so the 0042 CHECKs and the materializer agree on the
 * grammar. DTSTART is moved forward to the first chosen weekday on or after
 * the first date, so the first occurrence is always one the trainer picked.
 */
export function parseClass(form: Reader, today: IsoDate): InputResult<ClassInput> {
  const errors: string[] = [];
  const title = required(text(form, 'title'), 120, errors, 'class_title');
  const description = bounded(
    optionalText(form, 'description'),
    2000,
    errors,
    'description_too_long',
  );
  const sportRaw = text(form, 'sport');
  const sport = isClubSport(sportRaw) ? sportRaw : null;
  if (!sport) errors.push('sport_invalid');
  const locationId = text(form, 'locationId');
  if (!isUuid(locationId)) errors.push('location_required');
  const instructorRaw = text(form, 'instructorUserId');
  const instructorUserId =
    instructorRaw === ''
      ? null
      : /^[A-Za-z0-9_-]{1,64}$/.test(instructorRaw)
        ? instructorRaw
        : null;
  if (instructorRaw !== '' && instructorUserId === null) errors.push('instructor_invalid');

  let firstDate = text(form, 'firstDate');
  if (!isIsoDate(firstDate)) errors.push('first_date_invalid');
  else if (firstDate < today) errors.push('first_date_past');
  const time = text(form, 'time');
  const timeMatch = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!timeMatch) errors.push('time_invalid');
  const durationMinutes = intInRange(text(form, 'durationMinutes'), 15, 480);
  if (durationMinutes === null) errors.push('duration_invalid');
  const capacityRaw = text(form, 'capacity');
  const capacity = capacityRaw === '' ? null : intInRange(capacityRaw, 1, 500);
  if (capacityRaw !== '' && capacity === null) errors.push('capacity_invalid');

  const weekdays = [
    ...new Set(
      form
        .getAll('weekdays')
        .filter((v): v is string => typeof v === 'string')
        .map((v) => oneOf(v, WEEKDAY_CODES))
        .filter((v): v is WeekdayCode => v !== null),
    ),
  ];
  const ends = text(form, 'ends') || 'never';
  let rrule: string | null = null;
  if (weekdays.length > 0 && isIsoDate(firstDate)) {
    const days = weekdays.map((code) => WEEKDAY_CODES.indexOf(code) + 1).sort((a, b) => a - b);
    for (let i = 0; i < 7 && !days.includes(isoWeekdayOf(firstDate)); i += 1) {
      firstDate = addDaysIso(firstDate, 1);
    }
    let count: number | undefined;
    let untilMs: number | undefined;
    if (ends === 'count') {
      const n = intInRange(text(form, 'count'), 1, 999);
      if (n === null) errors.push('count_invalid');
      else count = n;
    } else if (ends === 'until') {
      const until = text(form, 'until');
      if (!isIsoDate(until) || until < firstDate) errors.push('until_invalid');
      else {
        const [y, m, d] = until.split('-').map(Number) as [number, number, number];
        untilMs = zonedToInstant(
          { year: y, month: m, day: d, hour: 23, minute: 59 },
          SOFIA_TZ,
        ).instantMs;
      }
    }
    rrule = formatRrule({ freq: 'WEEKLY', interval: 1, byDay: days, count, untilMs });
  }

  const opensDays = intInRange(text(form, 'bookingOpensDays') || '7', 1, 90);
  if (opensDays === null) errors.push('booking_window_invalid');
  const deadline = intInRange(text(form, 'cancelDeadlineHours') || '2', 0, 168);
  if (deadline === null) errors.push('cancel_deadline_invalid');
  const dropInRaw = text(form, 'dropInPrice');
  const dropInPriceCents = dropInRaw === '' ? null : parseEuroCents(dropInRaw);
  if (dropInRaw !== '' && dropInPriceCents === null) errors.push('price_invalid');
  const coversAllPlans = text(form, 'coverage') !== 'selected';
  const planIds = coversAllPlans
    ? []
    : [
        ...new Set(
          form
            .getAll('planIds')
            .filter((v): v is string => typeof v === 'string' && isUuid(v))
            .map((v) => v.toLowerCase()),
        ),
      ];
  if (!coversAllPlans && planIds.length === 0) errors.push('plans_required');

  if (
    errors.length > 0 ||
    !sport ||
    !timeMatch ||
    durationMinutes === null ||
    opensDays === null ||
    deadline === null
  ) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      title,
      description,
      sport,
      locationId: locationId.toLowerCase(),
      instructorUserId,
      startsAtLocal: `${firstDate} ${time}:00`,
      rrule,
      durationMinutes,
      capacity,
      bookingOpensHours: opensDays * 24,
      cancelDeadlineHours: deadline,
      dropInPriceCents,
      coversAllPlans,
      planIds,
      trialAllowed: checked(form, 'trialAllowed'),
      public: checked(form, 'public'),
    },
  };
}
