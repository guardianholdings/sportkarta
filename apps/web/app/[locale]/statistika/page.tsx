import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { BarChart, type Bar } from '@/components/stats/bar-chart';
import { StatsTable } from '@/components/stats/stats-table';
import { cityDisplayName } from '@/lib/city-names';
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

function StatCard({ label, value }: { label: string; value: string | number }) {
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

  const [t, tSport, tAccess, snapshot] = await Promise.all([
    getTranslations('Stats'),
    getTranslations('Sport'),
    getTranslations('Access'),
    getStatsSnapshot(),
  ]);
  const { national, municipalities, sports } = snapshot;
  const na = t('na');
  const fmtPct = (v: number | null) => (v === null ? na : `${v.toFixed(1)}%`);

  const topMunicipalities: Bar[] = municipalities.slice(0, 10).map((m) => ({
    label: cityDisplayName(m.nameBg, m.nameEn, locale),
    value: m.total,
    display: String(m.total),
  }));
  const topSports: Bar[] = sports.slice(0, 10).map((s) => ({
    label: tSport(s.sport),
    value: s.total,
    display: String(s.total),
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
      display: m.per10k.toFixed(2),
    }));

  const generatedDate = national
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(new Date(national.generatedAt))
    : '';
  const freeShare = national ? pct(national.free, national.total) : null;
  const needsShare = national ? pct(national.needsVerification, national.total) : null;

  return (
    <AppShell>
      <main className="mx-auto max-w-4xl space-y-8 p-4">
      <header className="space-y-2">
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('h1')}</h1>
        <p className="text-ink-soft">{t('intro')}</p>
        {national && (
          <p className="text-caption text-text-muted">{t('generatedAt', { date: generatedDate })}</p>
        )}
      </header>

      {national && (
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatCard label={t('statTotal')} value={national.total} />
          <StatCard label={t('statFree')} value={fmtPct(freeShare)} />
          <StatCard label={t('statNeedsVerification')} value={fmtPct(needsShare)} />
          <StatCard label={t('statMunicipalities')} value={national.municipalitiesCovered} />
          <StatCard label={t('statSports')} value={national.sportsCount} />
        </section>
      )}

      <section className="grid gap-6 md:grid-cols-2">
        <BarChart title={t('chartTopMunicipalities')} bars={topMunicipalities} />
        <BarChart title={t('chartTopSports')} bars={topSports} color="#059669" />
        <BarChart title={t('chartAccess')} bars={accessBars} color="#0f766e" />
        <BarChart title={t('chartPer10k')} bars={per10kBars} color="#2563eb" />
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
        <button
          type="button"
          disabled
          className="cursor-not-allowed rounded-md border border-line-strong px-4 py-2 text-sm text-text-faint"
        >
          {t('downloadComingSoon')}
        </button>
      </section>
      </main>
    </AppShell>
  );
}
