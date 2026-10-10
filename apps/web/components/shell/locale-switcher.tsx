'use client';

import { Languages } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

import { Link, usePathname } from '@/i18n/navigation';
import { otherLocale } from '@/lib/locale-switch';
import { cn } from '@/lib/utils';

/**
 * bg ⇄ en for the page the visitor is on. Before this the only way to the
 * English site was editing the URL; the hreflang tags told crawlers about it
 * and nobody else.
 *
 * Same path, same query (a map viewport or a ?next= survives the switch), the
 * other locale — next-intl's Link does the prefixing, so bg stays unprefixed
 * and en lives under /en. The label is the TARGET language in its own words
 * („English" on the Bulgarian site, „Български" on the English one), marked up
 * with that language's `lang` so a screen reader pronounces it correctly.
 *
 * Two shapes: `inline` for the site footer, `rail` for the desktop nav rail —
 * which also reaches the map screen, the one page without a footer.
 */
type Variant = 'inline' | 'rail';

interface Props {
  variant?: Variant;
  className?: string;
}

export function LocaleSwitcher(props: Props) {
  // useSearchParams() opts a statically rendered page into client rendering up
  // to the nearest Suspense boundary; this one keeps that to the link itself,
  // which meanwhile renders without the query.
  return (
    <Suspense fallback={<SwitchLink {...props} query={null} />}>
      <SwitchLinkWithQuery {...props} />
    </Suspense>
  );
}

function SwitchLinkWithQuery(props: Props) {
  const params = useSearchParams();
  return <SwitchLink {...props} query={params} />;
}

function SwitchLink({
  variant = 'inline',
  className,
  query,
}: Props & { query: URLSearchParams | null }) {
  const t = useTranslations('LocaleSwitcher');
  const target = otherLocale(useLocale());
  const pathname = usePathname();
  const href =
    query && query.toString() !== '' ? { pathname, query: Object.fromEntries(query) } : pathname;

  if (variant === 'rail') {
    // Styled as a rail item (icon over a word) so it reads as navigation, not
    // as a stray control; the word is the full language name, which fits the
    // rail as the longest tab label does.
    return (
      <Link
        href={href}
        locale={target}
        hrefLang={target}
        lang={target}
        className={cn(
          'flex flex-col items-center gap-1 rounded-md px-2 py-2 text-overline font-semibold text-ink-soft hover:bg-surface-2',
          className,
        )}
      >
        <Languages size={22} aria-hidden="true" />
        {t('switchTo')}
      </Link>
    );
  }

  return (
    <Link
      href={href}
      locale={target}
      hrefLang={target}
      lang={target}
      className={cn(
        'inline-flex min-h-11 items-center gap-1.5 font-medium text-ink-soft hover:text-brand',
        className,
      )}
    >
      <Languages size={16} aria-hidden="true" />
      {t('switchTo')}
    </Link>
  );
}
