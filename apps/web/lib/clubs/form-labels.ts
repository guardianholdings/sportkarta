import { getMessages, getTranslations } from 'next-intl/server';

import type { MemberFormLabels } from '@/components/clubs/member-form';
import type { PlanFormLabels, SaleFormLabels } from '@/components/clubs/sales-forms';
import { CLUB_PAYMENT_METHODS, CLUB_PLAN_AUDIENCES, CLUB_PLAN_KINDS } from '@sportkarta/lib/clubs';

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
  };
}
