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
  PROMOTION_KINDS,
  PROMOTION_TARGETS,
  formatClock,
  compactCode,
  INVOICE_VAT_RATES,
  isBgVatNumber,
  isEik,
  isIban,
  isVatNumber,
  normalizePromoCode,
  parseClock,
  parseClosing,
  parseEuroCents,
  type PromotionKind,
  type PromotionTarget,
  type ClubCancelReason,
  type ClubKind,
  type ClubPaymentMethod,
  type ClubPlanAudience,
  type ClubPlanKind,
  type ClubRole,
  type ClubSport,
  type ClubTier,
  type InvoiceBuyerKind,
  type InvoiceVatRate,
  type IsoDate,
  AUDIENCE_FILTERS,
  AUDIENCE_KINDS,
  AUDIENCE_SEGMENTS,
  AUTOMATION_CHANNELS,
  AUTOMATION_TRIGGERS,
  BROADCAST_BODY_MAX,
  BROADCAST_PURPOSES,
  BROADCAST_SUBJECT_MAX,
  SMS_BODY_MAX,
  SMS_NOTIFY_KINDS,
  automationMinDelay,
  type Audience,
  type AutomationChannel,
  type AutomationTrigger,
  type BroadcastPurpose,
  type MessageChannel,
  type SmsNotifyKind,
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

/**
 * The club's own terms of sale, linked before a member pays online (0046's
 * clubs_terms_url_sane: https only, at most 300 characters). Empty clears it.
 */
export function parseTermsUrl(form: Reader): InputResult<string | null> {
  const raw = optionalText(form, 'termsUrl');
  if (raw === null) return { ok: true, value: null };
  const value = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(value);
    const href = url.toString();
    if (url.protocol !== 'https:' || /\s/.test(value) || href.length > 300) throw new Error('bad');
    return { ok: true, value: href };
  } catch {
    return { ok: false, errors: ['terms_url_invalid'] };
  }
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
  /** The public page's accent (0045). */
  accent: ClubAccent;
}

export const CLUB_ACCENTS = ['green', 'coral', 'sky'] as const;
export type ClubAccent = (typeof CLUB_ACCENTS)[number];

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
      accent: oneOf(text(form, 'accent'), CLUB_ACCENTS) ?? 'green',
    },
  };
}

// ─── The club's FAQ (0045) ─────────────────────────────────────────────────

export interface FaqInput {
  questionBg: string;
  answerBg: string;
  questionEn: string | null;
  answerEn: string | null;
  sortOrder: number;
}

export function parseFaq(form: Reader): InputResult<FaqInput> {
  const errors: string[] = [];
  const questionBg = required(text(form, 'questionBg'), 200, errors, 'question');
  const answerBg = required(text(form, 'answerBg'), 1500, errors, 'answer');
  const questionEn = bounded(optionalText(form, 'questionEn'), 200, errors, 'question_too_long');
  const answerEn = bounded(optionalText(form, 'answerEn'), 1500, errors, 'answer_too_long');
  if ((questionEn === null) !== (answerEn === null)) errors.push('faq_en_pair');
  const sortOrder = intInRange(text(form, 'sortOrder') || '0', 0, 999) ?? 0;
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { questionBg, answerBg, questionEn, answerEn, sortOrder } };
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

// ─── Staff profile, pay, time off (0045) ─────────────────────────────────────

export interface StaffProfileInput {
  displayName: string | null;
  bio: string | null;
  publicProfile: boolean;
}

export function parseStaffProfile(form: Reader): InputResult<StaffProfileInput> {
  const errors: string[] = [];
  const displayName = bounded(optionalText(form, 'displayName'), 80, errors, 'name_too_long');
  const bio = bounded(optionalText(form, 'bio'), 1000, errors, 'bio_too_long');
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { displayName, bio, publicProfile: checked(form, 'publicProfile') } };
}

export type PayRateInput =
  | { kind: 'none' }
  | { kind: 'flat' | 'per_head'; cents: number }
  | { kind: 'share'; shareBp: number };

export function parsePayRate(form: Reader): InputResult<PayRateInput> {
  const kind = text(form, 'payKind');
  if (kind === 'none' || kind === '') return { ok: true, value: { kind: 'none' } };
  if (kind === 'flat' || kind === 'per_head') {
    const cents = parseEuroCents(text(form, 'payAmount'));
    if (cents === null || cents > 10_000_000) return { ok: false, errors: ['price_invalid'] };
    return { ok: true, value: { kind, cents } };
  }
  if (kind === 'share') {
    const raw = text(form, 'payShare').replace(',', '.');
    const percent = /^\d{1,3}(\.\d{1,2})?$/.test(raw) ? Number(raw) : NaN;
    if (!(percent >= 0 && percent <= 100)) return { ok: false, errors: ['share_invalid'] };
    return { ok: true, value: { kind, shareBp: Math.round(percent * 100) } };
  }
  return { ok: false, errors: ['pay_kind_invalid'] };
}

export const TIME_OFF_REASONS = ['time_off', 'training', 'other'] as const;
export type TimeOffReason = (typeof TIME_OFF_REASONS)[number];

export interface TimeOffInput {
  userId: string;
  startsOn: IsoDate;
  endsOn: IsoDate;
  reason: TimeOffReason;
}

export function parseTimeOff(form: Reader): InputResult<TimeOffInput> {
  const errors: string[] = [];
  const userId = text(form, 'userId');
  if (userId === '' || userId.length > 200) errors.push('not_found');
  const startsOn = text(form, 'startsOn');
  const endsOn = text(form, 'endsOn') || startsOn;
  if (!isIsoDate(startsOn) || !isIsoDate(endsOn)) errors.push('date_invalid');
  else if (endsOn < startsOn) errors.push('dates_reversed');
  // A year at most, one day short of 0045's 366-day CHECK: Sofia midnights
  // are an hour off a day's length across a DST change.
  else if (endsOn > addDaysIso(startsOn, 364)) errors.push('range_too_long');
  const reason = oneOf(text(form, 'reason') || 'time_off', TIME_OFF_REASONS);
  if (!reason) errors.push('reason_invalid');
  if (errors.length > 0 || !reason) return { ok: false, errors };
  return { ok: true, value: { userId, startsOn, endsOn, reason } };
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
  /** The club's terms (0045). */
  autoRenew: boolean;
  minTermMonths: number | null;
  noticeDays: number;
  selfPauseAllowed: boolean;
  selfCancelAllowed: boolean;
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
  const autoRenew = checked(form, 'autoRenew');
  if (autoRenew && kind === 'trial') errors.push('trial_cannot_renew');
  const minTermRaw = text(form, 'minTermMonths');
  const minTermMonths = minTermRaw === '' ? null : intInRange(minTermRaw, 1, 36);
  if (minTermRaw !== '' && minTermMonths === null) errors.push('min_term_invalid');
  const noticeRaw = text(form, 'noticeDays');
  const noticeDays = noticeRaw === '' ? 0 : intInRange(noticeRaw, 0, 120);
  if (noticeDays === null) errors.push('notice_invalid');
  if (
    errors.length > 0 ||
    !kind ||
    !audience ||
    priceCents === null ||
    amount === null ||
    noticeDays === null
  ) {
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
      autoRenew,
      minTermMonths: autoRenew ? minTermMonths : null,
      noticeDays: autoRenew ? noticeDays : 0,
      selfPauseAllowed: checked(form, 'selfPause'),
      selfCancelAllowed: autoRenew && checked(form, 'selfCancel'),
    },
  };
}

// ─── The member's own contact preferences (portal, 0045) ───────────────────

export interface ContactPreferencesInput {
  phone: string | null;
  marketingEmail: boolean;
  marketingSms: boolean;
}

export function parseContactPreferences(form: Reader): InputResult<ContactPreferencesInput> {
  const errors: string[] = [];
  const number = phone(optionalText(form, 'phone'), errors);
  const marketingSms = checked(form, 'marketingSms');
  if (marketingSms && number === null) errors.push('sms_needs_phone');
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { phone: number, marketingEmail: checked(form, 'marketingEmail'), marketingSms },
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
  /**
   * Paid at the desk now; null = an open charge, due on `dueOn`. A null
   * amount is "all of it" — the price after any offer, which the desk need
   * not work out by hand.
   */
  payment: (Omit<PaymentPart, 'amountCents'> & { amountCents: number | null }) | null;
  dueOn: IsoDate;
  /** A typed offer code (0049), normalised; absent or null when none was typed. */
  code?: string | null;
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
  let payment: SaleInput['payment'] = null;
  if (text(form, 'payNow') !== 'later') {
    const method = oneOf(text(form, 'method'), CLUB_PAYMENT_METHODS);
    if (!method) errors.push('method_invalid');
    const amountRaw = text(form, 'amount');
    const amountCents = amountRaw === '' ? null : parseEuroCents(amountRaw);
    if (amountRaw !== '' && (amountCents === null || amountCents === 0)) {
      errors.push('amount_invalid');
    }
    const receivedOn = text(form, 'receivedOn') || today;
    if (!isIsoDate(receivedOn) || receivedOn > today) errors.push('received_on_invalid');
    if (method && amountCents !== 0 && isIsoDate(receivedOn)) {
      payment = { method, amountCents, receivedOn };
    }
  }
  const codeRaw = text(form, 'code');
  const code = codeRaw === '' ? null : normalizePromoCode(codeRaw);
  if (codeRaw !== '' && code === null) errors.push('code_invalid');
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
      code,
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
  /** The room or court the class occupies (0048); null = none. */
  resourceId: string | null;
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
  /** No-show and late-cancel policy (0045); null = none. */
  noShowFeeCents: number | null;
  lateCancelFeeCents: number | null;
  strikeLimit: number | null;
  strikeDays: number | null;
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
/**
 * `keepFirstDate` is an edited series' own first date: a series that began
 * last month may be edited without being moved, while a NEW date still has to
 * be today or later.
 */
export function parseClass(
  form: Reader,
  today: IsoDate,
  keepFirstDate: IsoDate | null = null,
): InputResult<ClassInput> {
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
  else if (firstDate < today && firstDate !== keepFirstDate) errors.push('first_date_past');
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
  const fee = (name: string): number | null => {
    const raw = text(form, name);
    if (raw === '') return null;
    const cents = parseEuroCents(raw);
    if (cents === null || cents < 1 || cents > 100000) {
      errors.push('fee_invalid');
      return null;
    }
    return cents;
  };
  const noShowFeeCents = fee('noShowFee');
  const lateCancelFeeCents = fee('lateCancelFee');
  const strikeRaw = text(form, 'strikeLimit');
  const strikeLimit = strikeRaw === '' ? null : intInRange(strikeRaw, 1, 20);
  if (strikeRaw !== '' && strikeLimit === null) errors.push('strikes_invalid');
  const strikeDaysRaw = text(form, 'strikeDays');
  const strikeDays = strikeLimit === null ? null : intInRange(strikeDaysRaw || '30', 7, 180);
  if (strikeLimit !== null && strikeDays === null) errors.push('strikes_invalid');

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
      resourceId: isUuid(text(form, 'resourceId')) ? text(form, 'resourceId').toLowerCase() : null,
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
      noShowFeeCents,
      lateCancelFeeCents,
      strikeLimit,
      strikeDays,
    },
  };
}

// ─── Resources, services, reservations (0048) ──────────────────────────────

export const CLUB_RESOURCE_KINDS = [
  'court',
  'room',
  'pitch',
  'lane',
  'equipment',
  'other',
] as const;
export type ClubResourceKind = (typeof CLUB_RESOURCE_KINDS)[number];

export interface ResourceInput {
  locationId: string;
  kind: ClubResourceKind;
  name: string;
  quantity: number;
  sortOrder: number;
}

export function parseResource(form: Reader): InputResult<ResourceInput> {
  const errors: string[] = [];
  const locationId = text(form, 'locationId');
  if (!isUuid(locationId)) errors.push('location_invalid');
  const kind = oneOf(text(form, 'kind'), CLUB_RESOURCE_KINDS);
  if (!kind) errors.push('kind_invalid');
  const name = required(text(form, 'name'), 80, errors, 'name');
  const quantity = intInRange(text(form, 'quantity') || '1', 1, 500);
  if (quantity === null) errors.push('quantity_invalid');
  const sortOrder = intInRange(text(form, 'sortOrder') || '0', 0, 999) ?? 0;
  if (errors.length > 0 || !kind || quantity === null) return { ok: false, errors };
  return { ok: true, value: { locationId, kind, name, quantity, sortOrder } };
}

export interface DayHours {
  /** ISO weekday, 1 = Monday. */
  weekday: number;
  opens: string;
  closes: string;
}

/**
 * A week of opening hours: `h<weekday>_opens` / `h<weekday>_closes` (HH:MM).
 * A day with both empty is closed; half a day, or closing before opening, is
 * an error.
 */
export function parseWeekHours(form: Reader): InputResult<DayHours[]> {
  const days: DayHours[] = [];
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    const opens = text(form, `h${weekday}_opens`);
    const closes = text(form, `h${weekday}_closes`);
    if (opens === '' && closes === '') continue;
    const from = parseClock(opens);
    const to = parseClosing(closes);
    if (from === null || to === null || to <= from) return { ok: false, errors: ['hours_invalid'] };
    // Midnight closes the day: stored as 24:00 (a Postgres time allows it).
    days.push({ weekday, opens: opens.slice(0, 5), closes: formatClock(to) });
  }
  return { ok: true, value: days };
}

export const CLUB_SERVICE_KINDS = ['rental', 'appointment'] as const;
export type ClubServiceKind = (typeof CLUB_SERVICE_KINDS)[number];
export const CLUB_SERVICE_PAYMENTS = ['desk', 'online_optional', 'online_required'] as const;
export type ClubServicePayment = (typeof CLUB_SERVICE_PAYMENTS)[number];
/** 0048's club_services_window_sane: inside the class materialisation horizon. */
export const MAX_BOOKING_WINDOW_DAYS = 42;

export interface ServiceInput {
  locationId: string;
  kind: ClubServiceKind;
  nameBg: string;
  nameEn: string | null;
  descriptionBg: string | null;
  descriptionEn: string | null;
  durationMin: number;
  durationMax: number;
  stepMinutes: number;
  bufferMinutes: number;
  priceUnit: 'hour' | 'booking';
  priceCents: number;
  memberPriceCents: number | null;
  bookingWindowDays: number;
  cancelDeadlineHours: number;
  /** Upcoming bookings of this service one account may hold online (1–50). */
  maxUpcomingPerMember: number;
  payment: ClubServicePayment;
  audience: ClubPlanAudience;
  visibility: 'public' | 'private';
  resourceIds: string[];
  staffUserIds: string[];
}

export function parseService(form: Reader): InputResult<ServiceInput> {
  const errors: string[] = [];
  const locationId = text(form, 'locationId');
  if (!isUuid(locationId)) errors.push('location_invalid');
  const kind = oneOf(text(form, 'kind'), CLUB_SERVICE_KINDS);
  if (!kind) errors.push('kind_invalid');
  const nameBg = required(text(form, 'nameBg'), 80, errors, 'name');
  const nameEn = bounded(optionalText(form, 'nameEn'), 80, errors, 'name_too_long');
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
  const durationMin = intInRange(text(form, 'durationMin'), 15, 720);
  const durationMax = intInRange(text(form, 'durationMax') || text(form, 'durationMin'), 15, 720);
  const stepMinutes = intInRange(text(form, 'stepMinutes') || '30', 5, 240);
  if (
    durationMin === null ||
    durationMax === null ||
    stepMinutes === null ||
    durationMax < durationMin ||
    (durationMax - durationMin) % stepMinutes !== 0
  ) {
    errors.push('duration_invalid');
  }
  const bufferMinutes = intInRange(text(form, 'bufferMinutes') || '0', 0, 120);
  if (bufferMinutes === null) errors.push('buffer_invalid');
  const priceUnit = text(form, 'priceUnit') === 'booking' ? 'booking' : 'hour';
  const priceCents = parseEuroCents(text(form, 'price'));
  if (priceCents === null || priceCents > 10_000_000) errors.push('price_invalid');
  const memberRaw = text(form, 'memberPrice');
  const memberPriceCents = memberRaw === '' ? null : parseEuroCents(memberRaw);
  if (memberRaw !== '' && (memberPriceCents === null || memberPriceCents > 10_000_000)) {
    errors.push('price_invalid');
  }
  const bookingWindowDays = intInRange(
    text(form, 'windowDays') || '14',
    1,
    MAX_BOOKING_WINDOW_DAYS,
  );
  if (bookingWindowDays === null) errors.push('window_invalid');
  const cancelDeadlineHours = intInRange(text(form, 'cancelHours') || '24', 0, 168);
  if (cancelDeadlineHours === null) errors.push('cancel_hours_invalid');
  const maxUpcomingPerMember = intInRange(text(form, 'maxUpcoming') || '4', 1, 50);
  if (maxUpcomingPerMember === null) errors.push('max_upcoming_invalid');
  const payment = oneOf(text(form, 'payment') || 'desk', CLUB_SERVICE_PAYMENTS);
  if (!payment) errors.push('payment_invalid');
  const audience = oneOf(text(form, 'audience') || 'all', CLUB_PLAN_AUDIENCES);
  if (!audience) errors.push('audience_invalid');
  const ids = (name: string) => [
    ...new Set(form.getAll(name).filter((v): v is string => typeof v === 'string' && isUuid(v))),
  ];
  const resourceIds = ids('resourceIds');
  const staffUserIds = [
    ...new Set(
      form
        .getAll('staffUserIds')
        .filter((v): v is string => typeof v === 'string' && v !== '' && v.length <= 200),
    ),
  ];
  if (kind === 'rental' && resourceIds.length === 0) errors.push('needs_resource');
  if (kind === 'appointment' && staffUserIds.length === 0) errors.push('needs_staff');
  if (
    errors.length > 0 ||
    !kind ||
    durationMin === null ||
    durationMax === null ||
    stepMinutes === null ||
    bufferMinutes === null ||
    priceCents === null ||
    bookingWindowDays === null ||
    cancelDeadlineHours === null ||
    maxUpcomingPerMember === null ||
    !payment ||
    !audience
  ) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      locationId,
      kind,
      nameBg,
      nameEn,
      descriptionBg,
      descriptionEn,
      durationMin,
      durationMax,
      stepMinutes,
      bufferMinutes,
      priceUnit,
      priceCents,
      memberPriceCents,
      bookingWindowDays,
      cancelDeadlineHours,
      maxUpcomingPerMember,
      payment,
      audience,
      visibility: checked(form, 'public') ? 'public' : 'private',
      resourceIds,
      staffUserIds,
    },
  };
}

export interface PriceRuleInput {
  weekdays: number[];
  from: string;
  to: string;
  priceCents: number;
  memberPriceCents: number | null;
  priority: number;
}

export function parsePriceRule(form: Reader): InputResult<PriceRuleInput> {
  const errors: string[] = [];
  const weekdays = [
    ...new Set(
      form
        .getAll('weekdays')
        .map((v) => (typeof v === 'string' ? Number(v) : NaN))
        .filter((v) => Number.isInteger(v) && v >= 1 && v <= 7),
    ),
  ].sort();
  if (weekdays.length === 0) errors.push('weekdays_required');
  const from = text(form, 'from');
  const to = text(form, 'to');
  const fromMin = parseClock(from);
  const toMin = parseClosing(to);
  if (fromMin === null || toMin === null || toMin <= fromMin) errors.push('hours_invalid');
  const priceCents = parseEuroCents(text(form, 'price'));
  if (priceCents === null || priceCents > 10_000_000) errors.push('price_invalid');
  const memberRaw = text(form, 'memberPrice');
  const memberPriceCents = memberRaw === '' ? null : parseEuroCents(memberRaw);
  if (memberRaw !== '' && (memberPriceCents === null || memberPriceCents > 10_000_000)) {
    errors.push('price_invalid');
  }
  const priority = Number(text(form, 'priority') || '0');
  if (!Number.isInteger(priority) || priority < -100 || priority > 100) {
    errors.push('priority_invalid');
  }
  if (errors.length > 0 || priceCents === null) return { ok: false, errors };
  return {
    ok: true,
    value: {
      weekdays,
      from: from.slice(0, 5),
      to: formatClock(toMin ?? 0),
      priceCents,
      memberPriceCents,
      priority,
    },
  };
}

export interface ReservationRequest {
  serviceId: string;
  date: IsoDate;
  /** `HH:MM` on the club's wall clock. */
  local: string;
  durationMinutes: number;
  /** The record it is for; null = the account's own (portal only). */
  memberId: string | null;
}

export function parseReservationRequest(form: Reader): InputResult<ReservationRequest> {
  const serviceId = text(form, 'serviceId');
  const date = text(form, 'date');
  const local = text(form, 'local');
  const durationMinutes = intInRange(text(form, 'duration'), 15, 720);
  const memberRaw = text(form, 'memberId');
  if (
    !isUuid(serviceId) ||
    !isIsoDate(date) ||
    parseClock(local) === null ||
    durationMinutes === null ||
    (memberRaw !== '' && !isUuid(memberRaw))
  ) {
    return { ok: false, errors: ['slot_invalid'] };
  }
  return {
    ok: true,
    value: {
      serviceId,
      date,
      local: local.slice(0, 5),
      durationMinutes,
      memberId: memberRaw === '' ? null : memberRaw,
    },
  };
}

// ─── Shop and offers (0049, wave B1) ───────────────────────────────────────

export const CLUB_PRODUCT_CATEGORIES = [
  'drink',
  'food',
  'supplement',
  'apparel',
  'equipment',
  'other',
] as const;
export type ClubProductCategory = (typeof CLUB_PRODUCT_CATEGORIES)[number];
/** The VAT rates a product carries, in basis points (0049's club_products_vat_known). */
export const CLUB_VAT_RATES = [2000, 900, 0] as const;

export interface ProductInput {
  name: string;
  sku: string | null;
  category: ClubProductCategory;
  priceCents: number;
  vatRateBp: number;
  trackStock: boolean;
  lowStockAt: number | null;
  sortOrder: number;
}

export function parseProduct(form: Reader): InputResult<ProductInput> {
  const errors: string[] = [];
  const name = required(text(form, 'name'), 80, errors, 'name');
  const skuRaw = text(form, 'sku');
  const sku = skuRaw === '' ? null : skuRaw;
  if (sku !== null && !/^[A-Za-z0-9._-]{1,40}$/.test(sku)) errors.push('sku_invalid');
  const category = oneOf(text(form, 'category') || 'other', CLUB_PRODUCT_CATEGORIES);
  if (!category) errors.push('category_invalid');
  const priceCents = parseEuroCents(text(form, 'price'));
  if (priceCents === null || priceCents > 10_000_000) errors.push('price_invalid');
  const vat = Number(text(form, 'vatRate') || '2000');
  const vatRateBp = (CLUB_VAT_RATES as readonly number[]).includes(vat) ? vat : null;
  if (vatRateBp === null) errors.push('vat_invalid');
  const lowRaw = text(form, 'lowStockAt');
  const lowStockAt = lowRaw === '' ? null : intInRange(lowRaw, 0, 100_000);
  if (lowRaw !== '' && lowStockAt === null) errors.push('low_stock_invalid');
  const sortOrder = intInRange(text(form, 'sortOrder') || '0', -1000, 1000) ?? 0;
  if (errors.length > 0 || !category || priceCents === null || vatRateBp === null) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      name,
      sku,
      category,
      priceCents,
      vatRateBp,
      trackStock: checked(form, 'trackStock'),
      lowStockAt,
      sortOrder,
    },
  };
}

/** A stock act from the products screen: a delivery, a write-off, or a count. */
export interface StockInput {
  productId: string;
  kind: 'receive' | 'waste' | 'count';
  /** receive / waste: how many; count: how many are actually on the shelf. */
  quantity: number;
  unitCostCents: number | null;
}

export function parseStock(form: Reader): InputResult<StockInput> {
  const errors: string[] = [];
  const productId = text(form, 'productId');
  if (!isUuid(productId)) errors.push('product_invalid');
  const kind = oneOf(text(form, 'kind'), ['receive', 'waste', 'count'] as const);
  if (!kind) errors.push('stock_kind_invalid');
  const quantity = intInRange(text(form, 'quantity'), kind === 'count' ? 0 : 1, 100_000);
  if (quantity === null) errors.push('stock_quantity_invalid');
  const costRaw = text(form, 'unitCost');
  const unitCostCents = costRaw === '' || kind !== 'receive' ? null : parseEuroCents(costRaw);
  if (kind === 'receive' && costRaw !== '' && unitCostCents === null) errors.push('price_invalid');
  if (errors.length > 0 || !kind || quantity === null) return { ok: false, errors };
  return { ok: true, value: { productId: productId.toLowerCase(), kind, quantity, unitCostCents } };
}

/** What the till sends: lines (`<productId>:<quantity>`), a client, how it is paid. */
export interface TillSaleInput {
  lines: { productId: string; quantity: number }[];
  memberId: string | null;
  /** null = left on the client's account (a client is then required). */
  method: 'cash' | 'card_desk' | 'other' | 'wallet' | null;
  code: string | null;
  locationId: string | null;
}

/** 'wallet' is the client's prepaid credit (0050): a client is then required. */
export const TILL_METHODS = ['cash', 'card_desk', 'other', 'wallet'] as const;

/**
 * The cart as `productId:quantity` strings — one product's lines summed.
 * Null when any line is malformed, there is none, or a limit is passed.
 */
export function parseTillLines(raw: readonly unknown[]): TillSaleInput['lines'] | null {
  const quantities = new Map<string, number>();
  for (const entry of raw) {
    if (typeof entry !== 'string') return null;
    const [id, qty] = entry.split(':');
    const quantity = Number(qty);
    if (!isUuid(id) || !Number.isInteger(quantity) || quantity < 1 || quantity > 1000) return null;
    const key = id.toLowerCase();
    quantities.set(key, (quantities.get(key) ?? 0) + quantity);
  }
  const lines = [...quantities].map(([productId, quantity]) => ({ productId, quantity }));
  if (lines.length === 0 || lines.length > 200 || lines.some((l) => l.quantity > 1000)) {
    return null;
  }
  return lines;
}

export function parseTillSale(form: Reader): InputResult<TillSaleInput> {
  const errors: string[] = [];
  const raw = form.getAll('line');
  const lines = parseTillLines(raw) ?? [];
  if (raw.length === 0) errors.push('cart_empty');
  else if (lines.length === 0) errors.push('line_invalid');
  const memberRaw = text(form, 'memberId');
  const memberId = memberRaw === '' ? null : memberRaw;
  if (memberId !== null && !isUuid(memberId)) errors.push('member_required');
  const methodRaw = text(form, 'method');
  const method = methodRaw === 'account' ? null : oneOf(methodRaw || 'cash', TILL_METHODS);
  if (methodRaw !== 'account' && !method) errors.push('method_invalid');
  if (methodRaw === 'account' && memberId === null) errors.push('account_needs_member');
  if (methodRaw === 'wallet' && memberId === null) errors.push('wallet_needs_client');
  const codeRaw = text(form, 'code');
  const code = codeRaw === '' ? null : normalizePromoCode(codeRaw);
  if (codeRaw !== '' && code === null) errors.push('code_invalid');
  const locationRaw = text(form, 'locationId');
  const locationId = isUuid(locationRaw) ? locationRaw.toLowerCase() : null;
  if (errors.length > 0) return { ok: false, errors: [...new Set(errors)] };
  return {
    ok: true,
    value: { lines, memberId: memberId?.toLowerCase() ?? null, method, code, locationId },
  };
}

export interface PromotionInput {
  name: string;
  code: string | null;
  kind: PromotionKind;
  value: number;
  target: PromotionTarget;
  targetIds: string[] | null;
  startsOn: IsoDate;
  endsOn: IsoDate | null;
  maxUses: number | null;
  perMemberMax: number | null;
  newMembersOnly: boolean;
  minVisits90d: number | null;
}

function optionalInt(
  form: Reader,
  name: string,
  min: number,
  max: number,
  errors: string[],
  code: string,
): number | null {
  const raw = text(form, name);
  if (raw === '') return null;
  const value = intInRange(raw, min, max);
  if (value === null) errors.push(code);
  return value;
}

export function parsePromotion(form: Reader, today: IsoDate): InputResult<PromotionInput> {
  const errors: string[] = [];
  const name = required(text(form, 'name'), 80, errors, 'name');
  const codeRaw = text(form, 'code');
  const code = codeRaw === '' ? null : normalizePromoCode(codeRaw);
  if (codeRaw !== '' && code === null) errors.push('code_invalid');
  const kind = oneOf(text(form, 'kind'), PROMOTION_KINDS);
  if (!kind) errors.push('promotion_kind_invalid');
  // Percent typed as a percentage (12,5), stored in basis points; amounts in euros.
  const valueRaw = text(form, 'value').replace(',', '.');
  let value: number | null = null;
  if (kind === 'percent') {
    const percent = Number(valueRaw);
    value = /^\d{1,3}(\.\d{1,2})?$/.test(valueRaw) ? Math.round(percent * 100) : null;
    if (value === null || value < 1 || value > 10_000) value = null;
  } else if (kind) {
    value = parseEuroCents(text(form, 'value'));
    if (value !== null && (value > 10_000_000 || (kind === 'amount' && value === 0))) value = null;
  }
  if (kind && value === null) errors.push('promotion_value_invalid');
  const target = oneOf(text(form, 'target') || 'all', PROMOTION_TARGETS);
  if (!target) errors.push('promotion_target_invalid');
  const ids = [
    ...new Set(
      form.getAll('targetIds').filter((v): v is string => typeof v === 'string' && isUuid(v)),
    ),
  ].map((id) => id.toLowerCase());
  const startsRaw = text(form, 'startsOn') || today;
  const startsOn = isIsoDate(startsRaw) ? startsRaw : null;
  if (!startsOn) errors.push('starts_on_invalid');
  const endsRaw = text(form, 'endsOn');
  const endsOn = endsRaw === '' ? null : isIsoDate(endsRaw) ? endsRaw : null;
  if (endsRaw !== '' && (endsOn === null || (startsOn !== null && endsOn < startsOn))) {
    errors.push('ends_on_invalid');
  }
  const maxUses = optionalInt(form, 'maxUses', 1, 1_000_000, errors, 'max_uses_invalid');
  const perMemberMax = optionalInt(form, 'perMemberMax', 1, 1000, errors, 'per_member_invalid');
  const minVisits90d = optionalInt(form, 'minVisits', 1, 365, errors, 'min_visits_invalid');
  if (errors.length > 0 || !kind || value === null || !target || !startsOn) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      name,
      code,
      kind,
      value,
      target,
      targetIds: ids.length > 0 ? ids.slice(0, 200) : null,
      startsOn,
      endsOn,
      maxUses,
      perMemberMax,
      newMembersOnly: checked(form, 'newMembersOnly'),
      minVisits90d,
    },
  };
}

// ─── Invoices (0050) ───────────────────────────────────────────────────────

export interface InvoiceDetailsInput {
  legalAddress: string | null;
  vatNumber: string | null;
  iban: string | null;
  invoiceVatBp: InvoiceVatRate;
  /** The legal basis printed for a 0 % line (a VAT-registered club). */
  zeroVatBasis: string | null;
}

/** What an invoice prints about the club: address, VAT number, IBAN, default rate. */
export function parseInvoiceDetails(form: Reader): InputResult<InvoiceDetailsInput> {
  const errors: string[] = [];
  const legalAddress = optionalText(form, 'legalAddress');
  if (legalAddress !== null && legalAddress.length > 300) errors.push('address_too_long');
  const vatRaw = optionalText(form, 'vatNumber');
  const vatNumber = vatRaw === null ? null : compactCode(vatRaw);
  if (vatNumber !== null && !isBgVatNumber(vatNumber)) errors.push('vat_number_invalid');
  const ibanRaw = optionalText(form, 'iban');
  const iban = ibanRaw === null ? null : compactCode(ibanRaw);
  if (iban !== null && !isIban(iban)) errors.push('iban_invalid');
  const rate = Number(text(form, 'invoiceVatBp'));
  const invoiceVatBp = (INVOICE_VAT_RATES as readonly number[]).includes(rate)
    ? (rate as InvoiceVatRate)
    : null;
  if (invoiceVatBp === null) errors.push('vat_rate_invalid');
  const zeroVatBasis = optionalText(form, 'zeroVatBasis');
  if (zeroVatBasis !== null && zeroVatBasis.length > 200) errors.push('basis_too_long');
  if (errors.length > 0 || invoiceVatBp === null) return { ok: false, errors };
  return { ok: true, value: { legalAddress, vatNumber, iban, invoiceVatBp, zeroVatBasis } };
}

export interface InvoiceBuyerInput {
  kind: InvoiceBuyerKind;
  name: string;
  eik: string | null;
  vatNumber: string | null;
  address: string;
}

/**
 * Who an invoice is made out to: a person (a name and an address — never an
 * identification number), or a company (name, address, and its EIK or — a
 * foreign company — its VAT number). Every buyer has an address (the
 * accountant, 2026-10-25).
 */
export function parseInvoiceBuyer(form: Reader): InputResult<InvoiceBuyerInput> {
  const errors: string[] = [];
  const kind: InvoiceBuyerKind = text(form, 'buyerKind') === 'company' ? 'company' : 'person';
  const name = text(form, 'buyerName');
  if (name === '' || name.length > 200) errors.push('buyer_name_invalid');
  const address = text(form, 'buyerAddress');
  if (address === '') errors.push('buyer_address_required');
  else if (address.length > 300) errors.push('address_too_long');
  let eik: string | null = null;
  let vatNumber: string | null = null;
  if (kind === 'company') {
    // A Bulgarian company by its EIK; a foreign one may have only a VAT number.
    const eikRaw = compactCode(text(form, 'buyerEik'));
    eik = eikRaw === '' ? null : isEik(eikRaw) ? eikRaw : null;
    if (eikRaw !== '' && eik === null) errors.push('eik_invalid');
    const vatRaw = optionalText(form, 'buyerVatNumber');
    vatNumber = vatRaw === null ? null : compactCode(vatRaw);
    if (vatNumber !== null && !isVatNumber(vatNumber)) errors.push('vat_number_invalid');
    if (eikRaw === '' && vatNumber === null) errors.push('buyer_id_required');
  } else if (text(form, 'buyerEik') !== '' || text(form, 'buyerVatNumber') !== '') {
    // A person never gets an identification number — say so rather than drop it.
    errors.push('person_no_id');
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { kind, name, eik, vatNumber, address } };
}

/** A credit note's reason: required, at most 200 characters. */
export function parseCreditReason(form: Reader): string | null {
  const reason = text(form, 'reason');
  return reason === '' || reason.length > 200 ? null : reason;
}

// ─── Messages (0051) ───────────────────────────────────────────────────────

const MESSAGE_CHANNELS: readonly MessageChannel[] = ['email', 'sms', 'push'];

/**
 * A group, as ONE select value — `all`, `segment:at_risk`, `filter:unpaid`,
 * `tag:Йога`, `plan:<uuid>`, `class:<uuid>` — so the picker is a plain
 * <select> that works without JavaScript.
 */
export function audienceValue(audience: Audience): string {
  switch (audience.kind) {
    case 'all':
      return 'all';
    case 'segment':
      return `segment:${audience.segment}`;
    case 'filter':
      return `filter:${audience.filter}`;
    case 'tag':
      return `tag:${audience.tag}`;
    case 'plan':
      return `plan:${audience.planId}`;
    case 'class':
      return `class:${audience.classId}`;
  }
}

export function parseAudience(raw: string): Audience | null {
  const at = raw.indexOf(':');
  const kind = oneOf(at < 0 ? raw : raw.slice(0, at), AUDIENCE_KINDS);
  const value = at < 0 ? '' : raw.slice(at + 1);
  switch (kind) {
    case 'all':
      return at < 0 ? { kind: 'all' } : null;
    case 'segment': {
      const segment = oneOf(value, AUDIENCE_SEGMENTS);
      return segment ? { kind: 'segment', segment } : null;
    }
    case 'filter': {
      const filter = oneOf(value, AUDIENCE_FILTERS);
      return filter ? { kind: 'filter', filter } : null;
    }
    case 'tag': {
      const tags = parseTags(value);
      return tags?.length === 1 ? { kind: 'tag', tag: tags[0] as string } : null;
    }
    case 'plan':
      return isUuid(value) ? { kind: 'plan', planId: value.toLowerCase() } : null;
    case 'class':
      return isUuid(value) ? { kind: 'class', classId: value.toLowerCase() } : null;
    default:
      return null;
  }
}

export interface BroadcastInput {
  purpose: BroadcastPurpose;
  channels: MessageChannel[];
  audience: Audience;
  subject: string;
  body: string;
  smsBody: string | null;
}

export function parseBroadcast(form: Reader): InputResult<BroadcastInput> {
  const errors: string[] = [];
  const purpose = oneOf(text(form, 'purpose'), BROADCAST_PURPOSES);
  if (purpose === null) errors.push('purpose_invalid');
  const channels = MESSAGE_CHANNELS.filter((channel) =>
    form.getAll('channels').some((value) => value === channel),
  );
  if (channels.length === 0) errors.push('channels_required');
  if (purpose === 'marketing' && channels.includes('push')) errors.push('marketing_no_push');

  const audience = parseAudience(text(form, 'audience'));
  if (audience === null) errors.push('message_audience_invalid');

  const subject = required(text(form, 'subject'), BROADCAST_SUBJECT_MAX, errors, 'subject');
  const body = required(text(form, 'body'), BROADCAST_BODY_MAX, errors, 'message_body');
  let smsBody: string | null = null;
  if (channels.includes('sms')) {
    smsBody = required(text(form, 'smsBody'), SMS_BODY_MAX, errors, 'sms_body');
  }
  if (errors.length > 0 || purpose === null || audience === null) {
    return { ok: false, errors };
  }
  return { ok: true, value: { purpose, channels, audience, subject, body, smsBody } };
}

/**
 * When a message goes: now, or a Sofia wall-clock date and time in the next
 * 90 days.
 */
export function parseSchedule(form: Reader, now: Date): InputResult<Date> {
  if (text(form, 'when') !== 'later') return { ok: true, value: now };
  const date = text(form, 'date');
  const clock = parseClock(text(form, 'time'));
  if (!isIsoDate(date) || clock === null) return { ok: false, errors: ['schedule_invalid'] };
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const at = new Date(
    zonedToInstant({ year, month, day, hour: Math.floor(clock / 60), minute: clock % 60 }, SOFIA_TZ)
      .instantMs,
  );
  const ahead = at.getTime() - now.getTime();
  if (ahead < 0 || ahead > 90 * 86_400_000) return { ok: false, errors: ['schedule_invalid'] };
  return { ok: true, value: at };
}

export interface AutomationInput {
  trigger: AutomationTrigger;
  channel: AutomationChannel;
  delayDays: number;
  subject: string | null;
  body: string;
  active: boolean;
}

export function parseAutomation(form: Reader): InputResult<AutomationInput> {
  const errors: string[] = [];
  const trigger = oneOf(text(form, 'trigger'), AUTOMATION_TRIGGERS);
  const channel = oneOf(text(form, 'channel'), AUTOMATION_CHANNELS);
  if (trigger === null || channel === null) return { ok: false, errors: ['invalid'] };
  const delayDays = intInRange(text(form, 'delayDays'), automationMinDelay(trigger), 365);
  if (delayDays === null) errors.push('delay_invalid');
  let subject: string | null = null;
  let body: string;
  if (channel === 'email') {
    subject = required(text(form, 'subject'), BROADCAST_SUBJECT_MAX, errors, 'subject');
    body = required(text(form, 'body'), BROADCAST_BODY_MAX, errors, 'message_body');
  } else {
    body = required(text(form, 'body'), SMS_BODY_MAX, errors, 'sms_body');
  }
  if (errors.length > 0 || delayDays === null) return { ok: false, errors };
  return {
    ok: true,
    value: { trigger, channel, delayDays, subject, body, active: checked(form, 'active') },
  };
}

/** Which automatic notices also go by SMS (clubs.sms_notify). */
export function parseSmsNotify(form: Reader): SmsNotifyKind[] {
  return SMS_NOTIFY_KINDS.filter((kind) => form.getAll('smsNotify').some((v) => v === kind));
}
