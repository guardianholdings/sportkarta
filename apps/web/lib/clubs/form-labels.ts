import { getMessages, getTranslations } from 'next-intl/server';

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
