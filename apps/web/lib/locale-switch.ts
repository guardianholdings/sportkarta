import { routing } from '@/i18n/routing';

export type AppLocale = (typeof routing.locales)[number];

/**
 * The locale a bg ⇄ en switch leads to: the first configured locale that is
 * not the current one. An unknown value is treated as the default locale,
 * which is what the site serves for it.
 */
export function otherLocale(current: string): AppLocale {
  const here = (routing.locales as readonly string[]).includes(current)
    ? current
    : routing.defaultLocale;
  return routing.locales.find((l) => l !== here) ?? routing.defaultLocale;
}
