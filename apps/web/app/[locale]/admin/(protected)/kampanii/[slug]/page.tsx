import { adminStandings, campaignBySlug, frozenResults, getDb } from '@sportkarta/db';
import { campaignPhase } from '@sportkarta/lib/campaigns';
import { CANONICAL_SPORTS } from '@sportkarta/lib/sports';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { ConfirmButton } from '@/components/ui/confirm-button';
import { Link } from '@/i18n/navigation';
import { requireRole } from '@/lib/auth-session';
import { localizedText } from '@/lib/campaigns';
import { partnerText, sponsorCandidates } from '@/lib/partners';
import { cityDisplayName, loadCityCatalog } from '@/lib/places';

import {
  cancelCampaignAction,
  closeCampaignAction,
  publishCampaignAction,
  updateCampaignAction,
} from '../actions';
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
  const [t, sportName, catalog, sponsors] = await Promise.all([
    getTranslations('AdminCampaigns'),
    getTranslations('Sport'),
    loadCityCatalog(),
    sponsorCandidates(getDb()),
  ]);

  const campaign = await campaignBySlug(getDb(), slug);
  if (!campaign) notFound();

  const phase = campaignPhase(campaign.status, campaign.window, new Date());
  const isClosed = campaign.status === 'closed';

  /**
   * The ADMIN standings: everyone, by name, unpublished members included. This
   * exists so a prize can actually be awarded — scoring already counted these
   * people, and hiding them from the organisers too would mean a campaign that
   * let members compete and then could not tell anyone they had won. The public
   * board (apps/web/app/[locale]/kampanii) shows far less. It carries no age
   * datum: `adminStandings` deliberately stopped selecting `is_minor` in 0020.
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
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">
            {localizedText(campaign.titleBg, campaign.titleEn, locale)}
          </h1>
          <span className="rounded-md bg-paper-sunk px-2 py-0.5 text-caption">{t(`phase_${phase}`)}</span>
          <Link href={`/kampanii/${campaign.slug}`} className="ml-auto text-body-sm font-medium text-link hover:text-link-hover">
            {t('viewPublic')}
          </Link>
        </div>
        <p className="text-body-sm text-text-muted">
          {campaign.window.startsOn} → {campaign.window.endsOn}
        </p>
      </header>

      <section className="flex flex-wrap gap-3 rounded-card border border-line bg-surface p-4 shadow-sm">
        {(campaign.status === 'draft' || campaign.status === 'cancelled') && (
          <form action={publishCampaignAction}>
            <input type="hidden" name="id" value={campaign.id} />
            <button type="submit" className="min-h-11 rounded-pill bg-brand px-4 py-1.5 text-body-sm font-semibold text-on-brand shadow-xs focus-visible:shadow-[var(--ring)] hover:bg-brand-hover">
              {t('publish')}
            </button>
          </form>
        )}
        {!isClosed && campaign.status !== 'cancelled' && (
          <form action={cancelCampaignAction}>
            <input type="hidden" name="id" value={campaign.id} />
            <ConfirmButton
              className="rounded-md border border-line-strong px-3 py-1.5 text-body-sm"
              message={t('cancelConfirm')}
            >
              {t('cancel')}
            </ConfirmButton>
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
        {isClosed && <p className="text-body-sm text-ink-soft">{t('closedNote')}</p>}
      </section>

      <section className="space-y-3">
        <h2 className="text-h4 font-bold text-ink">
          {isClosed ? t('frozenStandings') : t('liveStandings')}
        </h2>
        {isClosed ? (
          <ol className="space-y-1 text-body-sm">
            {frozen.map((row) => (
              <li key={`${row.rank}-${row.handle ?? row.municipalityId ?? 'x'}`} className="flex gap-3">
                <span className="w-8 tabular-nums text-text-muted">{row.rank}</span>
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
          <p className="text-body-sm text-ink-soft">{t('noScoresYet')}</p>
        ) : (
          <table className="w-full text-body-sm">
            <thead>
              <tr className="border-b border-line text-left text-caption text-text-muted">
                <th scope="col" className="t-overline py-2 pr-3 font-medium">{t('columnRank')}</th>
                <th scope="col" className="t-overline py-2 pr-3 font-medium">{t('columnMember')}</th>
                <th scope="col" className="t-overline py-2 pr-3 font-medium">{t('columnVisibility')}</th>
                <th scope="col" className="t-overline py-2 text-right font-medium">{t('columnScore')}</th>
              </tr>
            </thead>
            <tbody>
              {standings.map((row) => (
                <tr key={row.userId ?? row.rank} className="border-b border-line">
                  <td className="py-2 pr-3 tabular-nums text-text-muted">{row.rank}</td>
                  <td className="py-2 pr-3">{row.displayName}</td>
                  <td className="py-2 pr-3 text-caption text-text-muted">
                    {/* Why somebody is not on the public board, stated plainly:
                        the organiser needs to know before they announce it.
                        One reason only since 0020 — the passport is private.
                        Age is not shown here and is not selected (see
                        adminStandings). */}
                    {row.isPublic ? t('publicMember') : t('notPublicPrivate')}
                  </td>
                  <td className="py-2 text-right font-medium tabular-nums">{row.score}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-h4 font-bold text-ink">{t('editTitle')}</h2>
        {isClosed && <p className="text-body-sm text-ink-soft">{t('closedNotEditable')}</p>}
        {!isClosed && (
          <CampaignForm
            action={updateCampaignAction}
            campaign={campaign}
            cities={cities}
            sportLabels={sportLabels}
            partners={sponsors.map((p) => ({
              id: p.id,
              name: partnerText(p.nameBg, p.nameEn, locale) ?? p.nameBg,
            }))}
          />
        )}
      </section>
    </main>
  );
}
