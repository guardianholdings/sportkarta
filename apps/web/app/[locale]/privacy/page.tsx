import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import { buildAlternates } from '@/lib/seo';
import { AppShell } from '@/components/shell/app-shell';

type PageParams = Promise<{ locale: string }>;

// Dynamic so the optional contact email (CONTACT_EMAIL) applies from the
// container env without a rebuild; the page holds no user data.
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Privacy' });
  return { title: t('title'), alternates: buildAlternates('/privacy', locale) };
}

export default async function PrivacyPage({ params }: { params: PageParams }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Privacy');

  const sections = [
    'store',
    'accounts',
    'analytics',
    'mapLayers',
    'reports',
    'photos',
    'data',
  ] as const;
  const contactEmail = process.env.CONTACT_EMAIL;

  return (
    <AppShell>
      <main className="mx-auto max-w-2xl space-y-6 p-4">
        <Link href="/" className="text-body-sm font-medium text-link hover:text-link-hover">
          {t('back')}
        </Link>
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        <p className="text-ink-soft">{t('intro')}</p>
        {sections.map((s) => (
          <section key={s} className="space-y-1">
            <h2 className="text-h4 font-bold text-ink">{t(`${s}Title`)}</h2>
            <p className="text-ink-soft">{t(`${s}Body`)}</p>
          </section>
        ))}
        <section className="space-y-1">
          <h2 className="text-h4 font-bold text-ink">{t('contactTitle')}</h2>
          <p className="text-ink-soft">{t('contactIntro')}</p>
          {contactEmail ? (
            <p>
              <a
                href={`mailto:${contactEmail}`}
                className="font-medium text-link hover:text-link-hover"
              >
                {contactEmail}
              </a>
            </p>
          ) : (
            <p className="text-ink-soft">{t('contactFallback')}</p>
          )}
        </section>
      </main>
    </AppShell>
  );
}
