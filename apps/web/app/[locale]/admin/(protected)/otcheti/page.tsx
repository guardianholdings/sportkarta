import { allMetrics, GRANT_REPORT, isSuppressed } from '@sportkarta/lib/reports';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { requireRole } from '@/lib/auth-session';
import { municipalityOptions } from '@/lib/admin-data';
import {
  buildGrantReport,
  MAX_PERIOD_DAYS,
  parseGrantScope,
  ReportScopeError,
} from '@/lib/reports';

/**
 * The grant-report screen (docs/ROADMAP.md §8, Stage 6.2).
 *
 * A GET FORM, not a server action, and that is the right shape here: the scope
 * lives in the URL, so an operator can bookmark "Sofia, last quarter", send the
 * link to a colleague, and get the same annex back. Nothing is written, so
 * there is nothing to protect against a replay — and the download links can be
 * plain anchors carrying the same query string rather than a second copy of the
 * form's state.
 *
 * The preview renders from the SAME catalogue and the same runner as the
 * downloads, so what the operator checks on screen is what lands in the file.
 */

type PageParams = Promise<{ locale: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const dynamic = 'force-dynamic';

function firstValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

export default async function AdminReportsPage({
  params,
  searchParams,
}: {
  params: PageParams;
  searchParams: SearchParams;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  // Admin only: an annex is grant accounting, not a moderation tool.
  await requireRole('admin');

  const t = await getTranslations('AdminReports');
  const raw = await searchParams;
  const query = new URLSearchParams({
    from: firstValue(raw.from),
    to: firstValue(raw.to),
    municipality: firstValue(raw.municipality),
  });

  const municipalities = await municipalityOptions();

  let error: string | null = null;
  let data = null;
  let scopeQuery = '';
  if (query.get('from') && query.get('to')) {
    try {
      const scope = parseGrantScope(query);
      data = await buildGrantReport(scope);
      scopeQuery = new URLSearchParams({
        from: scope.from,
        to: scope.to,
        municipality: scope.municipalityId === null ? 'all' : String(scope.municipalityId),
      }).toString();
    } catch (caught) {
      if (caught instanceof ReportScopeError) error = caught.code;
      else throw caught;
    }
  }

  const selectedMunicipality = query.get('municipality') ?? 'all';

  return (
    <main className="space-y-6">
      <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
      <p className="max-w-prose text-body-sm text-ink-soft">{t('intro')}</p>

      <form method="get" className="flex flex-wrap items-end gap-3 rounded-card border border-line bg-surface p-4 shadow-sm">
        <label className="flex flex-col gap-1 text-body-sm">
          <span className="font-medium">{t('from')}</span>
          <input
            type="date"
            name="from"
            required
            defaultValue={query.get('from') ?? ''}
            className="rounded-md border border-line-strong bg-surface px-2 py-1"
          />
        </label>
        <label className="flex flex-col gap-1 text-body-sm">
          {/* Said explicitly: the operator types an inclusive last day, and the
              runner converts it to an exclusive bound. */}
          <span className="font-medium">{t('toInclusive')}</span>
          <input
            type="date"
            name="to"
            required
            defaultValue={query.get('to') ?? ''}
            className="rounded-md border border-line-strong bg-surface px-2 py-1"
          />
        </label>
        <label className="flex flex-col gap-1 text-body-sm">
          <span className="font-medium">{t('municipality')}</span>
          <select
            name="municipality"
            defaultValue={selectedMunicipality}
            className="rounded-md border border-line-strong bg-surface px-2 py-1"
          >
            <option value="all">{t('allMunicipalities')}</option>
            {municipalities.map((option) => (
              <option key={option.id} value={option.id}>
                {option.nameBg}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="rounded-pill bg-brand px-3 py-1.5 text-body-sm font-semibold text-on-brand shadow-xs hover:bg-brand-hover">
          {t('generate')}
        </button>
      </form>

      {error && (
        <p role="alert" className="text-body-sm text-danger">
          {t(`error${error.charAt(0).toUpperCase()}${error.slice(1)}` as 'errorInvalidPeriod', {
            max: MAX_PERIOD_DAYS,
          })}
        </p>
      )}

      {data && (
        <>
          <div className="flex flex-wrap gap-3">
            <a
              className="rounded border border-line-strong px-3 py-1.5 text-body-sm"
              href={`/api/admin/otcheti?${scopeQuery}&format=csv`}
            >
              {t('downloadCsv')}
            </a>
            <a
              className="rounded border border-line-strong px-3 py-1.5 text-body-sm"
              href={`/api/admin/otcheti?${scopeQuery}&format=html`}
              target="_blank"
              rel="noreferrer"
            >
              {t('openHtml')}
            </a>
          </div>
          <p className="text-body-sm text-ink-soft">{t('printHint')}</p>

          {GRANT_REPORT.sections.map((section) => (
            <section key={section.id} className="space-y-2">
              <h2 className="text-h4 font-bold text-ink">{section.titleBg}</h2>
              <div className="overflow-x-auto rounded-card border border-line bg-surface">
                <table className="w-full text-body-sm">
                  <tbody>
                    {(section.metrics ?? []).map((metric) => {
                      const value =
                        data.metrics.find((m) => m.metricId === metric.id)?.value ?? null;
                      return (
                        <tr key={metric.id} className="border-t border-line first:border-t-0">
                          <td className="px-3 py-2">
                            {metric.labelBg}
                            {!metric.additive && (
                              <span className="ml-2 text-caption text-text-muted">
                                {t('notAdditive')}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {isSuppressed(GRANT_REPORT, metric, value)
                              ? '—'
                              : value === null
                                ? '—'
                                : value.toLocaleString('bg-BG')}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ))}

          <p className="max-w-prose text-caption text-text-muted">
            {t('metricCount', { count: allMetrics(GRANT_REPORT).length })}
          </p>
        </>
      )}
    </main>
  );
}
