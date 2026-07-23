import { getDb, listCampaigns } from '@sportkarta/db';
import type { Metadata } from 'next';
import { campaignPhase, daysRemaining } from '@sportkarta/lib/campaigns';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import { localizedText } from '@/lib/campaigns';

/**
 * Public campaign list (docs/ROADMAP.md §7, Stage 5.3).
 *
 * Drafts and cancelled campaigns are excluded at the query, not hidden in the
 * template: a draft is an unfinished thought and a cancelled one was withdrawn,
 * and neither should be reachable by anybody reading the markup.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Campaign' });
  return { title: t('listMetaTitle'), robots: { index: false, follow: true } };
}

export default async function CampaignsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Campaign');

  const campaigns = await listCampaigns(getDb(), { statuses: ['published', 'closed'] });
  const now = new Date();

  return (
    <main className="mx-auto max-w-2xl space-y-8 p-4">
      <header className="space-y-2 border-b border-neutral-200 pb-3">
        <h1 className="text-xl font-semibold">{t('listTitle')}</h1>
        <p className="text-sm text-neutral-600">{t('listIntro')}</p>
      </header>

      {campaigns.length === 0 ? (
        <p className="text-sm text-neutral-600">{t('listEmpty')}</p>
      ) : (
        <ul className="space-y-4">
          {campaigns.map((campaign) => {
            const phase = campaignPhase(campaign.status, campaign.window, now);
            const left = daysRemaining(campaign.window, now);
            return (
              <li key={campaign.id} className="rounded border border-neutral-200 p-4">
                <div className="flex flex-wrap items-baseline gap-2">
                  <h2 className="font-semibold">
                    <Link href={`/kampanii/${campaign.slug}`} className="underline">
                      {localizedText(campaign.titleBg, campaign.titleEn, locale)}
                    </Link>
                  </h2>
                  <span className="rounded bg-neutral-100 px-2 py-0.5 text-xs">
                    {t(`phase_${phase}`)}
                  </span>
                </div>
                <p className="mt-1 text-sm text-neutral-600">
                  {campaign.window.startsOn} → {campaign.window.endsOn}
                  {phase === 'running' && ` · ${t('daysLeft', { count: left })}`}
                </p>
                {campaign.blurbBg && (
                  <p className="mt-2 text-sm">
                    {localizedText(campaign.blurbBg, campaign.blurbEn, locale)}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
