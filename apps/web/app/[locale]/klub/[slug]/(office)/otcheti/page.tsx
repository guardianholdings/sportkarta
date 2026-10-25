import { ENGAGEMENT_WEIGHTS, formatEuro, lowestTierWith, sofiaToday } from '@sportkarta/lib/clubs';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { BarChart } from '@/components/stats/bar-chart';
import { buttonVariants } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { actorCan, requireClubStaff } from '@/lib/clubs/club-session';
import { CLUB_EXPORT_DATASETS, exportPermission } from '@/lib/clubs/export';
import { featureOn } from '@/lib/clubs/features';
import {
  AT_RISK_DAYS,
  activeByMonth,
  atRiskMembers,
  churnByMonth,
  classFillRates,
  engagementBands,
  monthToDate,
  peakHours,
  retentionCohorts,
  revenueByMonth,
  revenueByPlan,
  staffPay,
  topClients,
} from '@/lib/clubs/reports';
import { formatDate, formatMonthYear, formatNumber, formatPercent } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * Отчети: four figures with their definitions printed under their titles
 * (lib/clubs/reports.ts), and the club's data as CSV. Server-rendered bars,
 * no chart library, no client JavaScript.
 */
const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
/** The day the grid shows by default; it widens to fit any earlier or later visit. */
const PEAK_FROM = 6;
const PEAK_TO = 22;

export default async function ClubReportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ mesec?: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const { actor, club } = await requireClubStaff(slug, 'reports.view');
  const query = await searchParams;
  const payMonth =
    query.mesec && /^\d{4}-(0[1-9]|1[0-2])$/.test(query.mesec)
      ? query.mesec
      : sofiaToday().slice(0, 7);
  const advanced = featureOn(club, 'reports_advanced');
  const withPay = featureOn(club, 'staff_pay');
  const [t, tSettings, tClub, active, revenue, atRisk, fill] = await Promise.all([
    getTranslations('ClubReports'),
    getTranslations('ClubSettings'),
    getTranslations('Club'),
    activeByMonth(actor),
    revenueByMonth(actor),
    atRiskMembers(actor),
    classFillRates(actor),
  ]);
  const [mtd, peaks, cohorts, churn, byPlan, top, bands] = advanced
    ? await Promise.all([
        monthToDate(actor),
        peakHours(actor),
        retentionCohorts(actor),
        churnByMonth(actor),
        revenueByPlan(actor),
        topClients(actor),
        engagementBands(actor),
      ])
    : [null, [], [], [], [], { byVisits: [], bySpend: [] }, null];
  const pay = withPay ? await staffPay(actor, payMonth) : [];
  const peakMax = Math.max(1, ...peaks.map((c) => c.count));
  const peakFrom = Math.min(PEAK_FROM, ...peaks.map((c) => c.hour));
  const peakTo = Math.max(PEAK_TO, ...peaks.map((c) => c.hour));
  const peakHoursShown = Array.from({ length: peakTo - peakFrom + 1 }, (_, i) => peakFrom + i);
  const peakAt = (weekday: number, hour: number) =>
    peaks.find((c) => c.weekday === weekday && c.hour === hour)?.count ?? 0;
  const shade = (count: number) => {
    if (count === 0) return '';
    const level = count / peakMax;
    return level > 0.75
      ? 'bg-green-500 text-on-brand'
      : level > 0.5
        ? 'bg-green-300'
        : level > 0.25
          ? 'bg-green-200'
          : 'bg-green-100';
  };
  const delta = ([now, then]: [number, number]) =>
    then === 0
      ? '—'
      : `${now >= then ? '+' : '−'}${formatPercent((Math.abs(now - then) / then) * 100, locale, 0)}`;
  const section = 'space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm';
  const def = 'text-caption text-text-muted';
  const month = (value: string) => formatMonthYear(`${value}-01`, locale);
  const percent = (value: number | null) =>
    value === null ? t('noLimit') : formatPercent(value * 100, locale, 0);
  const datasets = CLUB_EXPORT_DATASETS.filter((dataset) =>
    actorCan(actor, exportPermission(dataset)),
  );

  return (
    <main className="space-y-5">
      <div>
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        <p className="mt-1 max-w-prose text-body-sm text-ink-soft">{t('intro')}</p>
      </div>

      {advanced && mtd && (
        <section className={section} aria-labelledby="mtd-h">
          <h2 id="mtd-h" className="text-h4 font-bold text-ink">
            {t('mtdTitle')}
          </h2>
          <p className={def}>{t('mtdDef', { days: mtd.days })}</p>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(
              [
                ['revenue', mtd.revenue, (v: number) => formatEuro(v, locale)],
                ['checkins', mtd.checkins, (v: number) => formatNumber(v, locale)],
                ['newMembers', mtd.newMembers, (v: number) => formatNumber(v, locale)],
                ['sales', mtd.sales, (v: number) => formatNumber(v, locale)],
              ] as const
            ).map(([key, pair, show]) => (
              <div key={key} className="rounded-card border border-line p-3">
                <dt className="text-caption text-text-muted">{t(`mtd.${key}`)}</dt>
                <dd className="text-h4 font-bold tabular-nums text-ink">{show(pair[0])}</dd>
                <dd className="text-caption text-ink-soft">
                  {t('mtdVs', { then: show(pair[1]), delta: delta(pair) })}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <section className={section}>
          <p className={def}>{t('activeDef')}</p>
          <BarChart
            title={t('activeTitle')}
            bars={active.map((m) => ({
              label: month(m.month),
              value: m.value,
              display: formatNumber(m.value, locale),
            }))}
          />
        </section>
        <section className={section}>
          <p className={def}>{t('revenueDef')}</p>
          <BarChart
            title={t('revenueTitle')}
            color="var(--accent)"
            bars={revenue.map((m) => ({
              label: month(m.month),
              value: Math.max(0, m.value),
              display: formatEuro(m.value, locale),
            }))}
          />
        </section>
      </div>

      <section className={section} aria-labelledby="risk-h">
        <h2 id="risk-h" className="text-h4 font-bold text-ink">
          {t('atRiskTitle')}
        </h2>
        <p className={def}>{t('atRiskDef', { days: AT_RISK_DAYS })}</p>
        {atRisk.length === 0 ? (
          <p className="text-body-sm text-text-muted">{t('atRiskNone')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {atRisk.map((member) => (
              <li
                key={member.memberId}
                className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-body-sm"
              >
                <Link
                  href={`/klub/${slug}/chlenove/${member.memberId}`}
                  className="font-medium text-link hover:text-link-hover"
                >
                  {member.displayName}
                </Link>
                <span className="text-caption text-text-muted">
                  {member.planName} · {t('atRiskEnds', { date: formatDate(member.endsOn, locale) })}{' '}
                  ·{' '}
                  {member.lastVisit
                    ? t('atRiskLast', { date: formatDate(member.lastVisit, locale) })
                    : t('atRiskNever')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={section} aria-labelledby="fill-h">
        <h2 id="fill-h" className="text-h4 font-bold text-ink">
          {t('fillTitle')}
        </h2>
        <p className={def}>{t('fillDef')}</p>
        {fill.length === 0 ? (
          <p className="text-body-sm text-text-muted">{t('fillNone')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] text-body-sm">
              <thead>
                <tr className="border-b border-line text-left text-caption text-text-muted">
                  {(['class', 'occurrences', 'avgBooked', 'fill', 'attendance'] as const).map(
                    (col) => (
                      <th
                        key={col}
                        scope="col"
                        className={`py-1.5 pr-3 font-medium ${col === 'class' ? '' : 'text-right'}`}
                      >
                        {t(`col.${col}`)}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {fill.map((row) => (
                  <tr key={row.classId} className="border-b border-line last:border-0">
                    <td className="py-1.5 pr-3">{row.title}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{row.occurrences}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {formatNumber(row.avgBooked, locale, { maximumFractionDigits: 1 })}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{percent(row.fill)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {row.attendance === null ? '—' : percent(row.attendance)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {advanced ? (
        <>
          <section className={section} aria-labelledby="peak-h">
            <h2 id="peak-h" className="text-h4 font-bold text-ink">
              {t('peakTitle')}
            </h2>
            <p className={def}>{t('peakDef')}</p>
            <div className="overflow-x-auto">
              <table className="text-caption tabular-nums">
                <thead>
                  <tr>
                    <th scope="col" className="sr-only">
                      {t('peakDay')}
                    </th>
                    {peakHoursShown.map((hour) => (
                      <th key={hour} scope="col" className="px-1 font-medium text-text-muted">
                        {hour}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[1, 2, 3, 4, 5, 6, 7].map((weekday) => (
                    <tr key={weekday}>
                      <th scope="row" className="pr-2 text-left font-medium text-ink-soft">
                        {tClub(`weekday.${WEEKDAY_CODES[weekday - 1] ?? 'MO'}`)}
                      </th>
                      {peakHoursShown.map((hour) => {
                        const count = peakAt(weekday, hour);
                        return (
                          <td
                            key={hour}
                            className={`h-7 min-w-7 rounded-sm text-center ${shade(count)}`}
                          >
                            {count > 0 ? count : ''}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="grid gap-5 lg:grid-cols-2">
            <section className={section} aria-labelledby="coh-h">
              <h2 id="coh-h" className="text-h4 font-bold text-ink">
                {t('cohortTitle')}
              </h2>
              <p className={def}>{t('cohortDef')}</p>
              {cohorts.length === 0 ? (
                <p className="text-body-sm text-text-muted">{t('cohortNone')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-body-sm tabular-nums">
                    <thead>
                      <tr className="border-b border-line text-left text-caption text-text-muted">
                        <th scope="col" className="py-1.5 pr-3 font-medium">
                          {t('cohortMonth')}
                        </th>
                        <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                          {t('cohortSize')}
                        </th>
                        {[1, 2, 3, 4, 5].map((k) => (
                          <th key={k} scope="col" className="py-1.5 pr-3 text-right font-medium">
                            {t('cohortAfter', { months: k })}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {cohorts.map((cohort) => (
                        <tr key={cohort.month} className="border-b border-line last:border-0">
                          <td className="py-1.5 pr-3">{month(cohort.month)}</td>
                          <td className="py-1.5 pr-3 text-right">{cohort.size}</td>
                          {cohort.kept.map((share, i) => (
                            <td key={i} className="py-1.5 pr-3 text-right">
                              {share === null ? '—' : formatPercent(share * 100, locale, 0)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <section className={section}>
              <p className={def}>{t('churnDef')}</p>
              <BarChart
                title={t('churnTitle')}
                color="var(--accent)"
                bars={churn.map((m) => ({
                  label: month(m.month),
                  value: m.value * 100,
                  display: formatPercent(m.value * 100, locale, 0),
                }))}
              />
            </section>
          </div>

          <div className="grid gap-5 lg:grid-cols-3">
            <section className={section} aria-labelledby="plan-h">
              <h2 id="plan-h" className="text-h4 font-bold text-ink">
                {t('byPlanTitle')}
              </h2>
              <p className={def}>{t('byPlanDef')}</p>
              <ul className="divide-y divide-line text-body-sm">
                {byPlan.map((line) => (
                  <li
                    key={`${line.kind}:${line.label}`}
                    className="flex justify-between gap-2 py-1.5"
                  >
                    <span>
                      {line.kind === 'plan' ? line.label : tClub(`chargeKind.${line.kind}`)}
                    </span>
                    <span className="tabular-nums">{formatEuro(line.cents, locale)}</span>
                  </li>
                ))}
              </ul>
            </section>
            {(['byVisits', 'bySpend'] as const).map((which) => (
              <section key={which} className={section} aria-labelledby={`top-${which}`}>
                <h2 id={`top-${which}`} className="text-h4 font-bold text-ink">
                  {t(`top.${which}`)}
                </h2>
                <p className={def}>{t(`top.${which}Def`)}</p>
                <ol className="divide-y divide-line text-body-sm">
                  {top[which].map((client) => (
                    <li key={client.memberId} className="flex justify-between gap-2 py-1.5">
                      <Link
                        href={`/klub/${slug}/chlenove/${client.memberId}`}
                        className="text-link hover:text-link-hover"
                      >
                        {client.displayName}
                      </Link>
                      <span className="tabular-nums">
                        {which === 'bySpend'
                          ? formatEuro(client.value, locale)
                          : formatNumber(client.value, locale)}
                      </span>
                    </li>
                  ))}
                </ol>
              </section>
            ))}
          </div>

          {bands && (
            <section className={section} aria-labelledby="eng-h">
              <h2 id="eng-h" className="text-h4 font-bold text-ink">
                {t('engagementTitle')}
              </h2>
              <p className={def}>
                {t('engagementDef', {
                  fresh: ENGAGEMENT_WEIGHTS.freshDays,
                  stale: ENGAGEMENT_WEIGHTS.staleDays,
                  perVisit: ENGAGEMENT_WEIGHTS.pointsPerVisit,
                  perMonth: ENGAGEMENT_WEIGHTS.pointsPerMonth,
                })}
              </p>
              <dl className="grid grid-cols-3 gap-3">
                {(['high', 'medium', 'low'] as const).map((band) => (
                  <div key={band} className="rounded-card border border-line p-3">
                    <dt className="text-caption text-text-muted">{t(`band.${band}`)}</dt>
                    <dd className="text-h4 font-bold tabular-nums text-ink">{bands[band]}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
        </>
      ) : (
        <section className={section}>
          <h2 className="text-h4 font-bold text-ink">{t('advancedTitle')}</h2>
          <p className="text-body-sm text-ink-soft">
            {t('advancedUpsell', { tier: tClub(`tier.${lowestTierWith('reports_advanced')}`) })}
          </p>
        </section>
      )}

      {withPay && (
        <section className={section} aria-labelledby="pay-h">
          <h2 id="pay-h" className="text-h4 font-bold text-ink">
            {t('payTitle')}
          </h2>
          <p className={def}>{t('payDef')}</p>
          <form className="flex flex-wrap items-end gap-2">
            <label className="text-caption text-ink-soft">
              {t('payMonth')}
              <input
                type="month"
                name="mesec"
                defaultValue={payMonth}
                className="mt-1 block min-h-11 rounded-input border border-line-strong bg-surface px-3 text-body-sm text-ink"
              />
            </label>
            <button type="submit" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
              {t('payShow')}
            </button>
          </form>
          {pay.length === 0 ? (
            <p className="text-body-sm text-text-muted">{t('payNone')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[32rem] text-body-sm tabular-nums">
                <thead>
                  <tr className="border-b border-line text-left text-caption text-text-muted">
                    {(['name', 'classes', 'attendees', 'sales', 'pay'] as const).map((col) => (
                      <th
                        key={col}
                        scope="col"
                        className={`py-1.5 pr-3 font-medium ${col === 'name' ? '' : 'text-right'}`}
                      >
                        {t(`payCol.${col}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pay.map((line) => (
                    <tr key={line.userId} className="border-b border-line last:border-0">
                      <td className="py-1.5 pr-3">{line.name}</td>
                      <td className="py-1.5 pr-3 text-right">{line.classes}</td>
                      <td className="py-1.5 pr-3 text-right">{line.attendees}</td>
                      <td className="py-1.5 pr-3 text-right">
                        {formatEuro(line.salesCents, locale)}
                      </td>
                      <td className="py-1.5 pr-3 text-right">
                        {line.payCents === null ? '—' : formatEuro(line.payCents, locale)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {datasets.length > 0 && (
        <section className={section} aria-labelledby="csv-h">
          <h2 id="csv-h" className="text-h4 font-bold text-ink">
            {t('csvTitle')}
          </h2>
          <p className={def}>{t('csvHint')}</p>
          <ul className="flex flex-wrap gap-2">
            {datasets.map((dataset) => (
              <li key={dataset}>
                <a
                  href={`/api/clubs/${slug}/eksport/${dataset}.csv`}
                  className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                  download
                >
                  {tSettings('export')} · {dataset}.csv
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
