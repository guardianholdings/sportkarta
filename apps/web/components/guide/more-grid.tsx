import {
  ChartColumn,
  Database,
  Flag,
  HeartHandshake,
  Landmark,
  Languages,
  Smartphone,
} from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import type { ComponentProps } from 'react';

import { SectionHead } from '@/components/home/section-head';
import { Link } from '@/i18n/navigation';

type Href = ComponentProps<typeof Link>['href'];

/**
 * «Още в POPS» — everything the five chapters did not walk through: the
 * statistics, the open data, the municipality pages, reporting, installing
 * it as an app, supporting the association, and the other language.
 */
export async function MoreGrid({ locale }: { locale: string }) {
  const t = await getTranslations('Home.guide.more');
  const other = locale === 'en' ? 'bg' : 'en';
  const items: { key: string; icon: typeof Database; href: Href | null; locale?: string }[] = [
    { key: 'stats', icon: ChartColumn, href: '/statistika' },
    { key: 'openData', icon: Database, href: '/danni' },
    { key: 'municipality', icon: Landmark, href: '/obshtina/sofia' },
    { key: 'report', icon: Flag, href: '/signal' },
    { key: 'install', icon: Smartphone, href: null },
    { key: 'support', icon: HeartHandshake, href: '/podkrepi' },
    { key: 'language', icon: Languages, href: '/', locale: other },
  ];

  return (
    <section
      id="oshte"
      aria-labelledby="guide-more"
      className="mx-auto max-w-6xl scroll-mt-14 px-4 py-16 sm:px-6 lg:px-8 lg:py-24"
    >
      <SectionHead id="guide-more" overline={t('overline')} title={t('title')} />
      <ul className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {items.map(({ key, icon: Icon, href, locale: target }) => {
          const body = (
            <>
              <Icon size={22} aria-hidden="true" className="text-brand" />
              <span className="mt-3 block text-body font-bold text-ink group-hover:text-brand">
                {t(`${key}.title`)}
              </span>
              <span className="mt-1 block text-body-sm text-ink-soft">{t(`${key}.body`)}</span>
            </>
          );
          return (
            <li key={key}>
              {href ? (
                <Link
                  href={href}
                  locale={target}
                  className="group block h-full rounded-card border border-line bg-surface p-5 transition-[border-color,box-shadow] duration-150 ease-standard hover:border-brand-border hover:shadow-sm focus-visible:shadow-[var(--ring)]"
                >
                  {body}
                </Link>
              ) : (
                <div className="h-full rounded-card border border-dashed border-line-strong p-5">
                  {body}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
