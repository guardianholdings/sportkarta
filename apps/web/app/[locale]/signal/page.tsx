import { NOTIFIER_CONTACT_RETENTION_DAYS } from '@sportkarta/db';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { NoticeForm } from '@/components/legal/notice-form';
import { AppShell } from '@/components/shell/app-shell';
import { Link } from '@/i18n/navigation';
import { issueFormToken } from '@/lib/form-token';
import { prefillPath } from '@/lib/notice-input';
import { buildAlternates } from '@/lib/seo';

/**
 * «Сигнал за съдържание» — the notice-and-action mechanism DSA Art. 16 requires
 * of a hosting service, and the only intake that covers EVERY kind of user
 * content: a photo, a facility name, a display name or home city on a board, a
 * public passport, a session. The facility report form stays what it was — a
 * way to say the swings are broken — and this is the way to say something here
 * is unlawful or breaks the terms.
 *
 * "Report this" links elsewhere pass the page they sit on as `?url=`; only a
 * same-site path is accepted as a pre-fill (lib/notice-input.ts `prefillPath`),
 * so a crafted link cannot plant somebody else's URL in the form.
 *
 * Dynamic: the anti-spam token is issued per render. Not indexed — a form page
 * with a query-string pre-fill has nothing for a search engine.
 */
export const dynamic = 'force-dynamic';

type PageParams = Promise<{ locale: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Notice' });
  return {
    title: t('title'),
    description: t('metaDescription'),
    alternates: buildAlternates('/signal', locale),
    robots: { index: false, follow: true },
  };
}

export default async function NoticePage({
  params,
  searchParams,
}: {
  params: PageParams;
  searchParams: SearchParams;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Notice');
  const { url } = await searchParams;

  return (
    <AppShell>
      <main className="mx-auto max-w-2xl space-y-6 p-4">
        <Link href="/" className="text-body-sm font-medium text-link hover:text-link-hover">
          {t('back')}
        </Link>
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        <p className="text-ink-soft">{t('intro')}</p>
        <p className="text-body-sm text-ink-soft">
          {t.rich('otherChannels', {
            report: (chunks) => <span className="font-medium text-ink">{chunks}</span>,
            contact: (chunks) => (
              <Link href="/kontakt" className="font-medium text-link hover:text-link-hover">
                {chunks}
              </Link>
            ),
          })}
        </p>
        <NoticeForm
          defaultUrl={prefillPath(url)}
          formToken={issueFormToken()}
          retentionDays={NOTIFIER_CONTACT_RETENTION_DAYS}
        />
        <p className="text-caption text-text-muted">
          {t.rich('termsNote', {
            terms: (chunks) => (
              <Link href="/usloviya" className="font-medium text-link hover:text-link-hover">
                {chunks}
              </Link>
            ),
          })}
        </p>
      </main>
    </AppShell>
  );
}
