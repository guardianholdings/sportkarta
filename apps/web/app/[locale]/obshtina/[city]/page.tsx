import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { BarChart, type Bar } from '@/components/stats/bar-chart';
import { Link } from '@/i18n/navigation';
import {
  ACTIVITY_WINDOW_DAYS,
  MIN_DISCLOSED_CONTRIBUTORS,
  RESOLUTION_WINDOW_DAYS,
  municipalityAccountability,
} from '@/lib/accountability';
import { cityDisplayName, getCityBySlug } from '@/lib/places';
import { buildAlternates, siteUrl } from '@/lib/seo';
import { pct } from '@/lib/stats-format';

/**
 * Municipality accountability (docs/ROADMAP.md §5, Stage 3.4).
 *
 * One page per municipality, addressed to two readers at once: a resident
 * asking "what has my municipality actually got?", and the municipality itself,
 * which can embed the same figures on its own site (the widget below).
 *
 * Three commitments make this page usable in a conversation with a mayor's
 * office rather than merely publishable:
 *
 *  - EVERY FIGURE IS RECONCILABLE. The visibility rule is the public map's, so
 *    the facility count equals the pins on /igrishta/[city]. The methodology
 *    section states each definition in words, including the awkward ones.
 *  - NOTHING HERE IS A JUDGEMENT WE INVENTED. "Poor condition" is what the
 *    public reported, "open reports" is our own queue depth — that number
 *    measures US, not the municipality, and the page says so. Publishing a
 *    responsiveness metric that quietly blames somebody else for our backlog
 *    would lose the argument the first time it was checked.
 *  - AGGREGATE ONLY. No contributor is named, and small contributor counts are
 *    suppressed (lib/accountability.ts).
 *
 * Rendered dynamically and cached at the edge by the response's own headers —
 * `revalidate` would put it in the build's static prerender, and the Docker
 * build has no database.
 */

export const dynamic = 'force-dynamic';

type PageParams = Promise<{ locale: string; city: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale, city: slug } = await params;
  const city = await getCityBySlug(slug);
  if (!city) return {};
  const t = await getTranslations({ locale, namespace: 'Accountability' });
  const name = cityDisplayName(city.nameBg, city.nameEn, locale);
  return {
    title: t('metaTitle', { city: name }),
    description: t('metaDescription', { city: name }),
    alternates: buildAlternates(`/obshtina/${city.slug}`, locale),
  };
}

function StatCard({ label, value, note }: { label: string; value: string; note?: string | null }) {
  return (
    <div className="rounded-lg border border-neutral-200 p-3">
      <div className="text-2xl font-bold tracking-tight tabular-nums">{value}</div>
      <div className="text-xs text-neutral-500">{label}</div>
      {note ? <div className="mt-1 text-xs text-neutral-400">{note}</div> : null}
    </div>
  );
}

export default async function AccountabilityPage({ params }: { params: PageParams }) {
  const { locale, city: slug } = await params;
  setRequestLocale(locale);

  const city = await getCityBySlug(slug);
  if (!city) notFound();

  const [t, data] = await Promise.all([
    getTranslations('Accountability'),
    municipalityAccountability(city),
  ]);

  const name = cityDisplayName(city.nameBg, city.nameEn, locale);
  const na = t('na');
  const fmtPct = (part: number, whole: number): string => {
    const value = pct(part, whole);
    return value === null ? na : `${value.toFixed(1)}%`;
  };

  const median =
    data.reportsMedianHours === null
      ? na
      : data.reportsMedianHours >= 48
        ? `${(data.reportsMedianHours / 24).toFixed(0)} ${t('unitDays')}`
        : `${data.reportsMedianHours.toFixed(0)} ${t('unitHours')}`;

  const conditionBars: Bar[] = (
    [
      ['conditionExcellent', data.conditionExcellent],
      ['conditionGood', data.conditionGood],
      ['conditionPoor', data.conditionPoor],
      ['conditionUnusable', data.conditionUnusable],
      ['conditionUnreported', data.conditionUnreported],
    ] as const
  ).map(([key, value]) => ({ label: t(key), value, display: String(value) }));

  const provenanceBars: Bar[] = (
    [
      ['sourceOsm', data.fromOsm],
      ['sourceMunicipal', data.fromMunicipal],
      ['sourceCrowd', data.fromCrowd],
    ] as const
  ).map(([key, value]) => ({ label: t(key), value, display: String(value) }));

  // The snippet a municipality copies. Absolute, because it is pasted into
  // somebody else's HTML where a relative URL means their own domain.
  const embedUrl = `${siteUrl()}/api/widget/obshtina/${city.slug}?lang=${locale}`;
  const embedSnippet =
    `<iframe src="${embedUrl}" width="100%" height="260" ` +
    `style="border:0" loading="lazy" title="${name}"></iframe>`;

  const generated = new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(
    new Date(data.generatedAt),
  );

  return (
    <main className="mx-auto max-w-4xl space-y-8 p-4">
      <Link href={`/igrishta/${city.slug}`} className="text-sm underline">
        {t('backToCity')}
      </Link>

      <header className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight">{t('h1', { city: name })}</h1>
        <p className="text-neutral-700">{t('intro', { city: name })}</p>
        <p className="text-xs text-neutral-500">{t('generatedAt', { date: generated })}</p>
      </header>

      <section aria-labelledby="coverage-h" className="space-y-3">
        <h2 id="coverage-h" className="text-lg font-semibold">
          {t('coverageHeading')}
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <StatCard label={t('statTotal')} value={String(data.total)} />
          <StatCard
            label={t('statPer10k')}
            value={data.per10k === null ? na : data.per10k.toFixed(1)}
            note={
              data.per10kRank === null || data.per10kOf === null
                ? t('noPopulation')
                : t('rankOf', { rank: data.per10kRank, of: data.per10kOf })
            }
          />
          <StatCard label={t('statFreeShare')} value={fmtPct(data.free, data.total)} />
          <StatCard label={t('statLit')} value={String(data.lit)} />
        </div>
      </section>

      <section aria-labelledby="quality-h" className="space-y-3">
        <h2 id="quality-h" className="text-lg font-semibold">
          {t('qualityHeading')}
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <StatCard label={t('statVerified')} value={fmtPct(data.active, data.total)} />
          <StatCard label={t('statNeedsVerification')} value={String(data.needsVerification)} />
          <StatCard label={t('statWithPhoto')} value={fmtPct(data.withPhoto, data.total)} />
          <StatCard
            label={t('statContributors')}
            value={
              data.contributors === null
                ? t('fewerThan', { n: MIN_DISCLOSED_CONTRIBUTORS })
                : String(data.contributors)
            }
            note={t('windowDays', { days: ACTIVITY_WINDOW_DAYS })}
          />
        </div>
        <div className="grid gap-6 md:grid-cols-2">
          <BarChart title={t('conditionHeading')} bars={conditionBars} color="#0f766e" />
          <BarChart title={t('provenanceHeading')} bars={provenanceBars} color="#2563eb" />
        </div>
      </section>

      <section aria-labelledby="response-h" className="space-y-3">
        <h2 id="response-h" className="text-lg font-semibold">
          {t('responseHeading')}
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label={t('statOpenReports')} value={String(data.reportsOpen)} />
          <StatCard
            label={t('statOldestOpen')}
            value={
              data.reportsOldestOpenDays === null
                ? na
                : `${data.reportsOldestOpenDays.toFixed(0)} ${t('unitDays')}`
            }
          />
          <StatCard
            label={t('statResolved')}
            value={String(data.reportsResolvedInWindow)}
            note={t('windowDays', { days: RESOLUTION_WINDOW_DAYS })}
          />
          <StatCard label={t('statMedianResponse')} value={median} />
        </div>
        <p className="text-sm text-neutral-600">{t('responseCaveat')}</p>
      </section>

      <section aria-labelledby="embed-h" className="space-y-3">
        <h2 id="embed-h" className="text-lg font-semibold">
          {t('embedHeading')}
        </h2>
        <p className="text-sm text-neutral-700">{t('embedIntro')}</p>
        <pre className="overflow-x-auto rounded border border-neutral-200 bg-neutral-50 p-3 text-xs">
          <code>{embedSnippet}</code>
        </pre>
        <ul className="list-disc space-y-1 pl-5 text-sm text-neutral-700">
          <li>{t('embedNoScript')}</li>
          <li>{t('embedNoCookies')}</li>
          <li>{t('embedAggregate')}</li>
          <li>
            <a href={`${embedUrl}&format=json`} className="underline">
              {t('embedJson')}
            </a>
          </li>
        </ul>
      </section>

      <section aria-labelledby="method-h" className="space-y-2">
        <h2 id="method-h" className="text-lg font-semibold">
          {t('methodologyHeading')}
        </h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-neutral-700">
          <li>{t('methodVisibility')}</li>
          <li>{t('methodPer10k')}</li>
          <li>{t('methodCondition')}</li>
          <li>{t('methodResponse', { days: RESOLUTION_WINDOW_DAYS })}</li>
          <li>{t('methodPrivacy', { n: MIN_DISCLOSED_CONTRIBUTORS })}</li>
          <li>{t('attribution')}</li>
        </ul>
      </section>
    </main>
  );
}
