import { getDb, listCampaigns } from '@sportkarta/db';
import { campaignPhase } from '@sportkarta/lib/campaigns';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import { requireRole } from '@/lib/auth-session';
import { localizedText } from '@/lib/campaigns';

/**
 * Campaign list (docs/ROADMAP.md §7, Stage 5.3).
 *
 * `requireRole('admin')`, not `requireAdmin()` — a campaign is national in
 * reach, decides a prize and publishes names; that is not an ambassador's
 * municipality-scoped moderation power.
 */
export const dynamic = 'force-dynamic';

export default async function AdminCampaignsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireRole('admin');
  const t = await getTranslations('AdminCampaigns');

  const campaigns = await listCampaigns(getDb());
  const now = new Date();

  return (
    <main className="space-y-6">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <Link
          href="/admin/kampanii/nova"
          className="ml-auto rounded bg-neutral-900 px-3 py-1.5 text-sm text-white"
        >
          {t('newCampaign')}
        </Link>
      </header>

      {campaigns.length === 0 ? (
        <p className="text-sm text-neutral-600">{t('empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-200 text-left text-xs text-neutral-500">
                <th scope="col" className="py-2 pr-3 font-medium">{t('columnTitle')}</th>
                <th scope="col" className="py-2 pr-3 font-medium">{t('columnWindow')}</th>
                <th scope="col" className="py-2 pr-3 font-medium">{t('columnScope')}</th>
                <th scope="col" className="py-2 pr-3 font-medium">{t('columnBoard')}</th>
                <th scope="col" className="py-2 font-medium">{t('columnPhase')}</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((campaign) => (
                <tr key={campaign.id} className="border-b border-neutral-100">
                  <td className="py-2 pr-3">
                    <Link href={`/admin/kampanii/${campaign.slug}`} className="underline">
                      {localizedText(campaign.titleBg, campaign.titleEn, locale)}
                    </Link>
                  </td>
                  <td className="py-2 pr-3 tabular-nums text-neutral-500">
                    {campaign.window.startsOn} → {campaign.window.endsOn}
                  </td>
                  <td className="py-2 pr-3 text-neutral-500">
                    {t(`scope_${campaign.scope.kind}`)}
                  </td>
                  <td className="py-2 pr-3 text-neutral-500">
                    {t(`leaderboardType_${campaign.leaderboardType}`)}
                  </td>
                  <td className="py-2">
                    {t(`phase_${campaignPhase(campaign.status, campaign.window, now)}`)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
