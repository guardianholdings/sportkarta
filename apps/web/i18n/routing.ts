import { defineRouting } from 'next-intl/routing';

export const routing = defineRouting({
  locales: ['bg', 'en'],
  defaultLocale: 'bg',
  // bg (default) is served unprefixed at "/", en at "/en" — Bulgarian-first SEO.
  localePrefix: 'as-needed',
  // No Accept-Language/cookie negotiation: "/" must deterministically serve bg
  // (crawlers send en headers; programmatic SEO needs stable content per URL).
  localeDetection: false,
});
