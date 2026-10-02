import type { ReactNode } from 'react';

import { Link } from '@/i18n/navigation';

const LINK = 'font-medium text-link hover:text-link-hover';

/**
 * The internal links the legal pages' prose may contain, as next-intl rich-text
 * tags: a message writes `<privacy>Поверителност</privacy>` and the page passes
 * these. One table, so /privacy, /usloviya and /kontakt link the same words to
 * the same places, and a message can never smuggle in an arbitrary href — the
 * tag NAME picks the destination, from this list only.
 */
const DESTINATIONS = {
  privacy: '/privacy',
  terms: '/usloviya',
  contact: '/kontakt',
  form: '/signal',
  profile: '/profil',
  openData: '/danni',
} as const;

type Tag = keyof typeof DESTINATIONS;

export const legalLinks = Object.fromEntries(
  (Object.keys(DESTINATIONS) as Tag[]).map((tag) => [
    tag,
    (chunks: ReactNode) => (
      <Link href={DESTINATIONS[tag]} className={LINK}>
        {chunks}
      </Link>
    ),
  ]),
) as Record<Tag, (chunks: ReactNode) => ReactNode>;

/** An external reference printed in legal prose (the regulator's site). */
export function externalLink(href: string) {
  return (chunks: ReactNode) => (
    <a href={href} className={LINK} rel="noopener noreferrer" target="_blank">
      {chunks}
    </a>
  );
}
