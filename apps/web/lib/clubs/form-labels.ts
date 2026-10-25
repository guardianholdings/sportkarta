import { getMessages, getTranslations } from 'next-intl/server';

import type { ClassFormLabels, ClassValues } from '@/components/clubs/class-form';
import type { MemberFormLabels } from '@/components/clubs/member-form';
import type { PlanFormLabels, SaleFormLabels } from '@/components/clubs/sales-forms';
import {
  CLUB_PAYMENT_METHODS,
  CLUB_PLAN_AUDIENCES,
  CLUB_PLAN_KINDS,
  euroInputValue,
} from '@sportkarta/lib/clubs';
import { instantToWall, parseRrule, SOFIA_TZ, WEEKDAY_CODES } from '@sportkarta/lib/recurrence';

import type { ClubClass } from './schedule';

/**
 * Pre-translated form feedback for the club module's CLIENT forms (the
 * campaign-form rule: labels arrive as props, so no club namespace has to be
 * shipped to the browser and the i18n-client-namespaces gate stays empty).
 */
export interface ClubFormMessages {
  saved: string;
  genericError: string;
  readOnly: string;
  errors: Record<string, string>;
}

export async function clubFormMessages(): Promise<ClubFormMessages> {
  const [t, messages] = await Promise.all([getTranslations('ClubForm'), getMessages()]);
  const catalogue =
    (messages as { ClubForm?: { error?: Record<string, string> } }).ClubForm?.error ?? {};
  return {
    saved: t('saved'),
    genericError: t('genericError'),
    readOnly: t('readOnly'),
    errors: Object.fromEntries(Object.keys(catalogue).map((code) => [code, t(`error.${code}`)])),
  };
}

/** The member form's labels, for the new and the edit page. */
export async function memberFormLabels(submitKey: 'create' | 'save'): Promise<MemberFormLabels> {
  const t = await getTranslations('ClubMembers.form');
  return {
    displayName: t('displayName'),
    email: t('email'),
    phone: t('phone'),
    isMinor: t('isMinor'),
    minorHint: t('minorHint'),
    guardian: t('guardian'),
    guardianNone: t('guardianNone'),
    tags: t('tags'),
    tagsHint: t('tagsHint'),
    staffNote: t('staffNote'),
    submit: t(submitKey),
  };
}

export async function planFormLabels(): Promise<PlanFormLabels> {
  const [t, tClub] = await Promise.all([
    getTranslations('ClubSales.planForm'),
    getTranslations('Club'),
  ]);
  return {
    nameBg: t('nameBg'),
    nameEn: t('nameEn'),
    descriptionBg: t('descriptionBg'),
    descriptionEn: t('descriptionEn'),
    kind: t('kind'),
    kinds: Object.fromEntries(CLUB_PLAN_KINDS.map((k) => [k, tClub(`planKind.${k}`)])),
    audience: t('audience'),
    audiences: Object.fromEntries(CLUB_PLAN_AUDIENCES.map((a) => [a, tClub(`audience.${a}`)])),
    price: t('price'),
    priceHint: t('priceHint'),
    validity: t('validity'),
    validityAmount: t('validityAmount'),
    days: t('days'),
    months: t('months'),
    visitsCount: t('visitsCount'),
    visibility: t('visibility'),
    public: t('public'),
    privatePlan: t('privatePlan'),
    terms: t('terms'),
    termsHint: t('termsHint'),
    autoRenew: t('autoRenew'),
    autoRenewHint: t('autoRenewHint'),
    minTermMonths: t('minTermMonths'),
    noticeDays: t('noticeDays'),
    selfPause: t('selfPause'),
    selfCancel: t('selfCancel'),
    save: t('save'),
  };
}

export async function saleFormLabels(): Promise<SaleFormLabels> {
  const [t, tClub] = await Promise.all([
    getTranslations('ClubSales.sale'),
    getTranslations('Club'),
  ]);
  return {
    member: t('member'),
    memberPick: t('memberPick'),
    plan: t('plan'),
    startsOn: t('startsOn'),
    payNow: t('payNow'),
    payLater: t('payLater'),
    method: t('method'),
    methods: Object.fromEntries(CLUB_PAYMENT_METHODS.map((m) => [m, tClub(`method.${m}`)])),
    amount: t('amount'),
    receivedOn: t('receivedOn'),
    dueOn: t('dueOn'),
    summary: t('summary', { plan: '{plan}', member: '{member}', price: '{price}' }),
    submit: t('submit'),
    code: t('code'),
    amountAll: t('amountAll'),
    offersNote: t('offersNote'),
    offerPrice: t('offerPrice', { price: '{price}', list: '{list}', offer: '{offer}' }),
  };
}

export async function classFormLabels(): Promise<ClassFormLabels> {
  const [t, tClub] = await Promise.all([
    getTranslations('ClubSchedule.form'),
    getTranslations('Club'),
  ]);
  return {
    title: t('title'),
    description: t('description'),
    sport: t('sport'),
    location: t('location'),
    instructor: t('instructor'),
    instructorNone: t('instructorNone'),
    room: t('room'),
    roomNone: t('roomNone'),
    roomHint: t('roomHint'),
    roomTaken: t('roomTaken'),
    firstDate: t('firstDate'),
    time: t('time'),
    duration: t('duration'),
    capacity: t('capacity'),
    capacityHint: t('capacityHint'),
    weekdays: t('weekdays'),
    weekdaysHint: t('weekdaysHint'),
    weekdayNames: WEEKDAY_CODES.map((code) => ({ code, label: tClub(`weekday.${code}`) })),
    ends: t('ends'),
    endsNever: t('endsNever'),
    endsUntil: t('endsUntil'),
    endsCount: t('endsCount'),
    until: t('until'),
    count: t('count'),
    bookingTitle: t('bookingTitle'),
    bookingOpensDays: t('bookingOpensDays'),
    cancelDeadlineHours: t('cancelDeadlineHours'),
    dropInPrice: t('dropInPrice'),
    policyTitle: t('policyTitle'),
    policyHint: t('policyHint'),
    noShowFee: t('noShowFee'),
    lateCancelFee: t('lateCancelFee'),
    strikeLimit: t('strikeLimit'),
    strikeDays: t('strikeDays'),
    coverage: t('coverage'),
    coverageAll: t('coverageAll'),
    coverageSelected: t('coverageSelected'),
    trialAllowed: t('trialAllowed'),
    public: t('public'),
    save: t('save'),
  };
}

/**
 * A stored series back into the editor's fields: the rule is decomposed into
 * the weekday picker and the end radio, the inverse of parseClass. A rule the
 * picker cannot express (none is written by this module) falls back to its
 * weekdays with no end, which the next save normalises.
 */
export function classFormValues(cls: ClubClass, locale: string): ClassValues {
  let weekdays: string[] = [];
  let ends: ClassValues['ends'] = 'never';
  let until = '';
  let count: number | null = null;
  if (cls.rrule) {
    try {
      const rule = parseRrule(cls.rrule);
      weekdays = rule.byDay
        .map((day) => WEEKDAY_CODES[day - 1])
        .filter((code): code is (typeof WEEKDAY_CODES)[number] => code !== undefined);
      if (rule.count !== undefined) {
        ends = 'count';
        count = rule.count;
      } else if (rule.untilMs !== undefined) {
        ends = 'until';
        const wall = instantToWall(rule.untilMs, SOFIA_TZ);
        until = `${String(wall.year)}-${String(wall.month).padStart(2, '0')}-${String(wall.day).padStart(2, '0')}`;
      }
    } catch {
      weekdays = [];
    }
  }
  return {
    id: cls.id,
    title: cls.title,
    description: cls.description,
    sport: cls.sport,
    locationId: cls.locationId,
    instructorUserId: cls.instructorUserId,
    resourceId: cls.resourceId,
    firstDate: cls.startsAtLocal.slice(0, 10),
    time: cls.startsAtLocal.slice(11, 16),
    durationMinutes: cls.durationMinutes,
    capacity: cls.capacity,
    weekdays,
    ends,
    until,
    count,
    bookingOpensDays: Math.max(1, Math.round(cls.bookingOpensHours / 24)),
    cancelDeadlineHours: cls.cancelDeadlineHours,
    dropInPrice: cls.dropInPriceCents === null ? '' : euroInputValue(cls.dropInPriceCents, locale),
    noShowFee: cls.noShowFeeCents === null ? '' : euroInputValue(cls.noShowFeeCents, locale),
    lateCancelFee:
      cls.lateCancelFeeCents === null ? '' : euroInputValue(cls.lateCancelFeeCents, locale),
    strikeLimit: cls.strikeLimit,
    strikeDays: cls.strikeDays,
    coversAllPlans: cls.coversAllPlans,
    planIds: cls.planIds,
    trialAllowed: cls.trialAllowed,
    public: cls.public,
  };
}
