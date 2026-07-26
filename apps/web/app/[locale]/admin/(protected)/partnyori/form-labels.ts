import { getTranslations } from 'next-intl/server';

import { PARTNER_TIERS } from '@/lib/partners';

import type { PartnerFormLabels } from './partner-form';

/** Pre-translated labels for the client form (campaign-form rule). */
export async function partnerFormLabels(): Promise<PartnerFormLabels> {
  const t = await getTranslations('AdminPartners');
  const errorCodes = [
    'bad_slug',
    'slug_taken',
    'bad_tier',
    'name_required',
    'bad_url',
    'bad_date',
    'window_order',
    'bad_sort',
    'text_too_long',
    'not_found',
    'photo_too_large',
    'invalid_photo',
  ] as const;
  return {
    slug: t('fieldSlug'),
    tier: t('fieldTier'),
    tiers: Object.fromEntries(PARTNER_TIERS.map((tier) => [tier, t(`tier_${tier}`)])),
    nameBg: t('fieldNameBg'),
    nameEn: t('fieldNameEn'),
    blurbBg: t('fieldBlurbBg'),
    blurbEn: t('fieldBlurbEn'),
    blurbHint: t('blurbHint'),
    url: t('fieldUrl'),
    logo: t('fieldLogo'),
    logoHint: t('logoHint'),
    visible: t('fieldVisible'),
    sortOrder: t('fieldSort'),
    startsOn: t('fieldStartsOn'),
    endsOn: t('fieldEndsOn'),
    submit: t('submit'),
    saved: t('saved'),
    errors: Object.fromEntries(errorCodes.map((code) => [code, t(`error_${code}`)])),
    genericError: t('error_generic'),
  };
}
