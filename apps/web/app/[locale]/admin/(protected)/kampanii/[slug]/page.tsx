import { adminStandings, campaignBySlug, frozenResults, getDb } from '@sportkarta/db';
import { campaignPhase } from '@sportkarta/lib/campaigns';
import { CANONICAL_SPORTS } from '@sportkarta/lib/sports';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { Link } from '@/i18n/navigation';
import { requireRole } from '@/lib/auth-session';
import { localizedText } from '@/lib/campaigns';
import { cityDisplayName, loadCityCatalog } from '@/lib/places';

import { cancelCampaignAction, closeCampaignAction, publishCampaignAction, updateCampaignAction } from '../actions';
import { CampaignForm } from '../campaign-form';
import { CloseCampaignForm } from './close-form';

export const dynamic = 'force-dynamic';

export default async function EditCampaignPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  await requireRole('admin');
  const [t, sportName, catalog] = await Promise.all([
    getTranslations('AdminCampaigns'),
    getTranslations('Sport'),
    loadCityCatalog(),
  ]);

  const campaign = await campaignBySlug(getDb(), slug);
  if (!campaign) notFound();

  const phase = campaignPhase(campaign.status, campaign.window, new Date());
  const isClosed = campaign.status === 'closed';

  /**
   * The ADMIN standings: everyone, by name, minors and unpublished members
   * included. This exists so a prize can actually be awarded — scoring already
   * counted these people, and hiding them from the organisers too would mean a
   * campaign that let members compete and then could not tell anyone they had
   * won. The public board (apps/web/app/[locale]/kampanii) shows far less.
   */
  const standings = isClosed ? [] : await adminStandings(getDb(), campaign, { limit: 100 });
  const frozen = isClosed ? await frozenResults(getDb(), campaign.id, 100) : [];

  const sportLabels = Object.fromEntries(
    CANONICAL_SPORTS.map((sport) => [sport, sportName(sport)]),
  );
  const cities = catalog.all.map((city) => ({
    id: city.id,
    name: cityDisplayName(city.nameBg, city.nameEn, locale),
  }));

  return (
    <main className="max-w-3xl space-y-8">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">
            {localizedText(campaign.titleBg, campaign.titleEn, locale)}
          </h1>
          <span className="rounded bg-neutral-100 px-2 py-0.5 text-xs">{t(`phase_${phase}`)}</span>
          <Link href={`/kampanii/${campaign.slug}`} className="ml-auto text-sm underline">
            {t('viewPublic')}
          </Link>
        </div>
        <p className="text-sm text-neutral-500">
          {campaign.window.startsOn} → {campaign.window.endsOn}
        </p>
      </header>

      <section className="flex flex-wrap gap-3 rounded border border-neutral-200 p-4">
        {(campaign.status === 'draft' || campaign.status === 'cancelled') && (
          <form action={publishCampaignAction}>
            <input type="hidden" name="id" value={campaign.id} />
            <button type="submit" className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white">
              {t('publish')}
            </button>
          </form>
        )}
        {!isClosed && campaign.status !== 'cancelled' && (
          <form action={cancelCampaignAction}>
            <input type="hidden" name="id" value={campaign.id} />
            <button type="submit" className="rounded border border-neutral-300 px-3 py-1.5 text-sm">
              {t('cancel')}
            </button>
          </form>
        )}
        {!isClosed && (
          <CloseCampaignForm
            id={campaign.id}
            action={closeCampaignAction}
            confirmationWord={t('closeConfirmWord')}
            label={t('close')}
            confirmLabel={t('closeConfirmLabel', { word: t('closeConfirmWord') })}
            warning={t('closeWarning')}
          />
        )}
        {isClosed && <p className="text-sm text-neutral-600">{t('closedNote')}</p>}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">
          {isClosed ? t('frozenStandings') : t('liveStandings')}
        </h2>
        {isClosed ? (
          <ol className="space-y-1 text-sm">
            {frozen.map((row) => (
              <li key={`${row.rank}-${row.handle ?? row.municipalityId ?? 'x'}`} className="flex gap-3">
                <span className="w-8 tabular-nums text-neutral-500">{row.rank}</span>
                <span>
                  {row.displayName ??
                    (row.municipalityId
                      ? (cities.find((c) => c.id === row.municipalityId)?.name ?? '—')
                      : t('withheld'))}
                </span>
                <span className="ml-auto font-medium tabular-nums">{row.score}</span>
              </li>
            ))}
          </ol>
        ) : standings.length === 0 ? (
          <p className="text-sm text-neutral-600">{t('noScoresYet')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-200 text-left text-xs text-neutral-500">
                <th scope="col" className="py-2 pr-3 font-medium">{t('columnRank')}</th>
                <th scope="col" className="py-2 pr-3 font-medium">{t('columnMember')}</th>
                <th scope="col" className="py-2 pr-3 font-medium">{t('columnVisibility')}</th>
                <th scope="col" className="py-2 text-right font-medium">{t('columnScore')}</th>
              </tr>
            </thead>
            <tbody>
              {standings.map((row) => (
                <tr key={row.userId ?? row.rank} className="border-b border-neutral-100">
                  <td className="py-2 pr-3 tabular-nums text-neutral-500">{row.rank}</td>
                  <td className="py-2 pr-3">{row.displayName}</td>
                  <td className="py-2 pr-3 text-xs text-neutral-500">
                    {/* Why somebody is not on the public board, stated plainly:
                        the organiser needs to know before they announce it. */}
                    {row.isMinor
                      ? t('notPublicMinor')
                      : row.isPublic
                        ? t('publicMember')
                        : t('notPublicPrivate')}
                  </td>
                  <td className="py-2 text-right font-medium tabular-nums">{row.score}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t('editTitle')}</h2>
        {isClosed && <p className="text-sm text-neutral-600">{t('closedNotEditable')}</p>}
        {!isClosed && (
          <CampaignForm
            action={updateCampaignAction}
            campaign={campaign}
            cities={cities}
            sportLabels={sportLabels}
          />
        )}
      </section>
    </main>
  );
}
