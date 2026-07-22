import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import { buildAlternates } from '@/lib/seo';

type PageParams = Promise<{ locale: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Privacy' });
  return { title: t('title'), alternates: buildAlternates('/privacy', locale) };
}

export default async function PrivacyPage({ params }: { params: PageParams }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Privacy');

  const sections = ['analytics', 'reports', 'photos', 'data'] as const;

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-4">
      <Link href="/" className="text-sm underline">
        {t('back')}
      </Link>
      <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
      <p className="text-neutral-700">{t('intro')}</p>
      {sections.map((s) => (
        <section key={s} className="space-y-1">
          <h2 className="text-lg font-semibold">{t(`${s}Title`)}</h2>
          <p className="text-neutral-700">{t(`${s}Body`)}</p>
        </section>
      ))}
    </main>
  );
}
