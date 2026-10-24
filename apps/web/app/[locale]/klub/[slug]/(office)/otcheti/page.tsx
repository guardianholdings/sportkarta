import { formatEuro } from '@sportkarta/lib/clubs';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { BarChart } from '@/components/stats/bar-chart';
import { buttonVariants } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { actorCan, requireClubStaff } from '@/lib/clubs/club-session';
import { CLUB_EXPORT_DATASETS, exportPermission } from '@/lib/clubs/export';
import {
  AT_RISK_DAYS,
  activeByMonth,
  atRiskMembers,
  classFillRates,
  revenueByMonth,
} from '@/lib/clubs/reports';
import { formatDate, formatMonthYear, formatNumber, formatPercent } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * Отчети: four figures with their definitions printed under their titles
 * (lib/clubs/reports.ts), and the club's data as CSV. Server-rendered bars,
 * no chart library, no client JavaScript.
 */
export default async function ClubReportsPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const { actor } = await requireClubStaff(slug, 'reports.view');
  const [t, tSettings, active, revenue, atRisk, fill] = await Promise.all([
    getTranslations('ClubReports'),
    getTranslations('ClubSettings'),
    activeByMonth(actor),
    revenueByMonth(actor),
    atRiskMembers(actor),
    classFillRates(actor),
  ]);
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
