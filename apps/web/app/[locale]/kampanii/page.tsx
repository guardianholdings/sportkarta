import { getDb, listCampaigns } from '@sportkarta/db';
import type { Metadata } from 'next';
import { campaignPhase, daysRemaining } from '@sportkarta/lib/campaigns';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import { localizedText } from '@/lib/campaigns';
import { AppShell } from '@/components/shell/app-shell';
import { campaignWindowLabel } from '@/lib/campaign-window';
import { HeadlineStrip } from '@/components/partners/headline-strip';

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

export default async function CampaignsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Campaign');

  const campaigns = await listCampaigns(getDb(), { statuses: ['published', 'closed'] });
  const now = new Date();

  return (
    <AppShell>
      <main className="mx-auto max-w-2xl space-y-8 p-4">
        <header className="space-y-2 border-b border-line pb-3">
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('listTitle')}</h1>
          <p className="text-body-sm text-ink-soft">{t('listIntro')}</p>
        </header>

        {campaigns.length === 0 ? (
          <p className="text-body-sm text-ink-soft">{t('listEmpty')}</p>
        ) : (
          <ul className="space-y-4">
            {campaigns.map((campaign) => {
              const phase = campaignPhase(campaign.status, campaign.window, now);
              const left = daysRemaining(campaign.window, now);
              return (
                <li
                  key={campaign.id}
                  className="rounded-card border border-line bg-surface p-4 shadow-sm"
                >
                  <div className="flex flex-wrap items-baseline gap-2">
                    <h2 className="font-semibold">
                      <Link
                        href={`/kampanii/${campaign.slug}`}
                        className="font-medium text-link hover:text-link-hover"
                      >
                        {localizedText(campaign.titleBg, campaign.titleEn, locale)}
                      </Link>
                    </h2>
                    <span className="rounded-pill bg-paper-sunk px-2.5 py-0.5 text-caption">
                      {t(`phase_${phase}`)}
                    </span>
                  </div>
                  <p className="mt-1 text-body-sm text-ink-soft">
                    {campaignWindowLabel(locale, campaign.window)}
                    {phase === 'running' && ` · ${t('daysLeft', { count: left })}`}
                  </p>
                  {campaign.blurbBg && (
                    <p className="mt-2 text-body-sm">
                      {localizedText(campaign.blurbBg, campaign.blurbEn, locale)}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {/* One of exactly two allowlisted strip surfaces (MONETISATION M1); the
          component itself ships disabled. See headline-strip.tsx for why this
          is placed by hand rather than in a layout. */}
        <HeadlineStrip />
      </main>
    </AppShell>
  );
}
