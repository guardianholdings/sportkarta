import { OPEN_DATA_LICENSE } from '@sportkarta/lib/opendata';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import { buildAlternates } from '@/lib/seo';
import { AppShell } from '@/components/shell/app-shell';

/**
 * The licence page (Stage 6.1) — the target of the `Link: rel="license"` header
 * every open-data API response carries, and of the ODbL link in every dump's
 * LICENSE.txt.
 *
 * It answers the question a reuser actually has, which is not "what does the
 * ODbL say" (they can read it) but "what do I have to do". Hence the four
 * sections: the attribution string to copy, what share-alike does and does not
 * demand, that a map or a report made FROM the data is not itself obliged to be
 * open, and that photographs are outside all of it.
 *
 * The attribution string is rendered from OPEN_DATA_LICENSE, not typed here, so
 * the words on this page are the same bytes as the `X-Attribution` header, the
 * GeoJSON member and the LICENSE.txt beside every dump. A licence page that
 * disagreed with the header would leave a reuser complying with neither.
 */

type PageParams = Promise<{ locale: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'OpenData' });
  return {
    title: t('licenseTitle'),
    description: t('licenseIntro'),
    alternates: buildAlternates('/danni/litsenz', locale),
  };
}

export default async function OpenDataLicensePage({ params }: { params: PageParams }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('OpenData');

  const sections = [
    ['licenseShareAlikeTitle', 'licenseShareAlikeBody'],
    ['licenseProducedWorkTitle', 'licenseProducedWorkBody'],
    ['licensePhotosTitle', 'licensePhotosBody'],
    ['licensePersonalTitle', 'licensePersonalBody'],
    ['licenseSourceTitle', 'licenseSourceBody'],
  ] as const;

  return (
    <AppShell>
      <main className="mx-auto max-w-2xl space-y-6 p-4">
      <Link href="/danni" className="text-body-sm font-medium text-link hover:text-link-hover">
        {t('back')}
      </Link>
      <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('licenseTitle')}</h1>

      <p className="text-ink-soft">
        {t('licenseIntro')}{' '}
        <a
          className="font-medium text-link hover:text-link-hover"
          href={OPEN_DATA_LICENSE.url}
          rel="license noopener noreferrer"
          target="_blank"
        >
          {OPEN_DATA_LICENSE.name}
        </a>
      </p>

      <section className="space-y-2">
        <h2 className="text-h4 font-bold text-ink">{t('licenseAttributionTitle')}</h2>
        <p className="text-ink-soft">{t('licenseAttributionBody')}</p>
        {/* The one string a reuser is here to copy — rendered from the same
            constant the API headers and the dumps carry. */}
        <p className="rounded-md border border-line-strong bg-paper-sunk p-3 font-medium">
          {OPEN_DATA_LICENSE.attribution}
        </p>
      </section>

      {sections.map(([title, body]) => (
        <section key={title} className="space-y-1">
          <h2 className="text-h4 font-bold text-ink">{t(title)}</h2>
          <p className="text-ink-soft">{t(body)}</p>
        </section>
      ))}
      </main>
    </AppShell>
  );
}
