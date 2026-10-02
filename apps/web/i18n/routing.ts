import { defineRouting } from 'next-intl/routing';

export const routing = defineRouting({
  locales: ['bg', 'en'],
  defaultLocale: 'bg',
  // bg (default) is served unprefixed at "/", en at "/en" — Bulgarian-first SEO.
  localePrefix: 'as-needed',
  // No Accept-Language/cookie negotiation: "/" must deterministically serve bg
  // (crawlers send en headers; programmatic SEO needs stable content per URL).
  localeDetection: false,
  // …and therefore no NEXT_LOCALE cookie either. next-intl writes one on every
  // response by default, but with detection off nothing ever reads it: it was
  // device storage serving no purpose the visitor asked for, on a site whose
  // privacy notice lists only the sign-in cookies (ePrivacy Art. 5(3)).
  localeCookie: false,
});
