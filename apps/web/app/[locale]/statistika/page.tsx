import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { BarChart, type Bar } from '@/components/stats/bar-chart';
import { StatsTable } from '@/components/stats/stats-table';
import { Link } from '@/i18n/navigation';
import { cityDisplayName } from '@/lib/city-names';
import { formatDate, formatNumber, formatPercent } from '@/lib/format';
import { loadCityCatalog } from '@/lib/places';
import { buildAlternates } from '@/lib/seo';
import { getStatsSnapshot, type MunicipalityStat } from '@/lib/stats-data';
import { pct } from '@/lib/stats-format';
import { AppShell } from '@/components/shell/app-shell';

// Reads the materialized views (cheap — refreshed every 15 min via pg-boss).
// force-dynamic keeps it OFF the build's static prerender (the [locale] layout
// has generateStaticParams, and the Docker build has no DB).
export const dynamic = 'force-dynamic';

type PageParams = Promise<{ locale: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Stats' });
  return {
    title: t('metaTitle'),
    description: t('metaDescription'),
    alternates: buildAlternates('/statistika', locale),
  };
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card border border-line p-3">
      <div className="font-mono text-h2 font-bold text-ink tabular-nums">{value}</div>
      <div className="text-caption text-text-muted">{label}</div>
    </div>
  );
}

const hasPer10k = (m: MunicipalityStat): m is MunicipalityStat & { per10k: number } =>
  m.per10k !== null;

export default async function StatsPage({ params }: { params: PageParams }) {
  const { locale } = await params;
  setRequestLocale(locale);

  const [t, tSport, tAccess, snapshot, cities] = await Promise.all([
    getTranslations('Stats'),
    getTranslations('Sport'),
    getTranslations('Access'),
    getStatsSnapshot(),
    loadCityCatalog(),
  ]);
  const { national, municipalities, sports } = snapshot;
  const na = t('na');
  // «98,8%», «12 345», «12,46» — the reader's separators, not JavaScript's.
  const fmtPct = (v: number | null) => (v === null ? na : formatPercent(v, locale));
  const fmtCount = (v: number) => formatNumber(v, locale);
  // A municipality's bar leads to its accountability page, when its slug is
  // known (the views carry the EKATTE code, the catalogue maps it).
  const municipalityHref = (m: MunicipalityStat) => {
    const city = cities.byEkatte.get(m.ekatteCode);
    return city ? `/obshtina/${city.slug}` : undefined;
  };

  const topMunicipalities: Bar[] = municipalities.slice(0, 10).map((m) => ({
    label: cityDisplayName(m.nameBg, m.nameEn, locale),
    value: m.total,
    display: fmtCount(m.total),
    href: municipalityHref(m),
  }));
  const topSports: Bar[] = sports.slice(0, 10).map((s) => ({
    label: tSport(s.sport),
    value: s.total,
    display: fmtCount(s.total),
  }));
  // All four access values, so the shares sum to 100% (no misleading omission).
  const accessBars: Bar[] = national
    ? (['free', 'paid', 'restricted', 'school'] as const).map((a) => {
        const p = pct(national[a], national.total);
        return { label: tAccess(a), value: p ?? 0, display: fmtPct(p) };
      })
    : [];
  const per10kBars: Bar[] = municipalities
    .filter(hasPer10k)
    .sort((a, b) => b.per10k - a.per10k)
    .slice(0, 10)
    .map((m) => ({
      label: cityDisplayName(m.nameBg, m.nameEn, locale),
      value: m.per10k,
      display: formatNumber(m.per10k, locale, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
      href: municipalityHref(m),
    }));

  // Sofia's calendar day, whatever the server's time zone (lib/format.ts).
  const generatedDate = national ? formatDate(national.generatedAt, locale) : '';
  const freeShare = national ? pct(national.free, national.total) : null;
  const needsShare = national ? pct(national.needsVerification, national.total) : null;

  return (
    <AppShell>
      <main className="mx-auto max-w-4xl space-y-8 p-4">
        <header className="space-y-2">
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('h1')}</h1>
          <p className="text-ink-soft">{t('intro')}</p>
          {national && (
            <p className="text-caption text-text-muted">
              {t('generatedAt', { date: generatedDate })}
            </p>
          )}
        </header>

        {national && (
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <StatCard label={t('statTotal')} value={fmtCount(national.total)} />
            <StatCard label={t('statFree')} value={fmtPct(freeShare)} />
            <StatCard label={t('statNeedsVerification')} value={fmtPct(needsShare)} />
            <StatCard
              label={t('statMunicipalities')}
              value={fmtCount(national.municipalitiesCovered)}
            />
            <StatCard label={t('statSports')} value={fmtCount(national.sportsCount)} />
          </section>
        )}

        <section className="grid gap-6 md:grid-cols-2">
          <BarChart title={t('chartTopMunicipalities')} bars={topMunicipalities} />
          <BarChart title={t('chartTopSports')} bars={topSports} color="var(--brand)" />
          <BarChart title={t('chartAccess')} bars={accessBars} color="var(--accent)" />
          <BarChart title={t('chartPer10k')} bars={per10kBars} color="var(--sky-500)" />
        </section>

        <section aria-labelledby="table-h">
          <h2 id="table-h" className="mb-2 text-h4 font-bold text-ink">
            {t('tableHeading')}
          </h2>
          <StatsTable municipalities={municipalities} locale={locale} />
        </section>

        <section aria-labelledby="method-h">
          <h2 id="method-h" className="mb-2 text-h4 font-bold text-ink">
            {t('methodologyHeading')}
          </h2>
          <ul className="list-disc space-y-1 pl-5 text-body-sm text-ink-soft">
            <li>{t('sourceData')}</li>
            <li>{t('sourcePopulation')}</li>
            <li>{t('verificationNote')}</li>
            <li>{t('computationNote')}</li>
          </ul>
        </section>

        <section aria-labelledby="dl-h">
          <h2 id="dl-h" className="mb-2 text-h4 font-bold text-ink">
            {t('downloadHeading')}
          </h2>
          <p className="text-body-sm text-ink-soft">
            {t.rich('downloadOpenData', {
              link: (chunks) => (
                <Link href="/danni" className="font-medium text-link hover:text-link-hover">
                  {chunks}
                </Link>
              ),
            })}
          </p>
        </section>
      </main>
    </AppShell>
  );
}
