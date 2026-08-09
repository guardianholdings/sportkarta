import { ArrowLeft, ArrowRight } from 'lucide-react';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import { requireAdmin } from '@/lib/auth-session';
import { MapEmbed } from '@/components/admin/map-embed';
import { StatusBadge } from '@/components/admin/status-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  FACILITIES_PAGE_SIZE,
  listFacilities,
  municipalityOptions,
  SOURCE_VALUES,
  STATUS_VALUES,
  type FacilityFilters,
  type FacilitySource,
  type FacilityStatus,
} from '@/lib/admin-data';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function parseFilters(params: Record<string, string | string[] | undefined>): FacilityFilters {
  const municipalityRaw = first(params.municipality);
  const statusRaw = first(params.status);
  const sourceRaw = first(params.source);
  const page = Math.max(1, Number(first(params.page)) || 1);

  return {
    q: first(params.q) || undefined,
    municipality:
      municipalityRaw === 'none'
        ? 'none'
        : /^\d+$/.test(municipalityRaw)
          ? Number(municipalityRaw)
          : undefined,
    status: (STATUS_VALUES as readonly string[]).includes(statusRaw)
      ? (statusRaw as FacilityStatus)
      : undefined,
    source: (SOURCE_VALUES as readonly string[]).includes(sourceRaw)
      ? (sourceRaw as FacilitySource)
      : undefined,
    page,
  };
}

function pageHref(
  params: Record<string, string | string[] | undefined>,
  page: number,
): { pathname: '/admin/facilities'; query: Record<string, string> } {
  const query: Record<string, string> = {};
  for (const key of ['q', 'municipality', 'status', 'source'] as const) {
    const value = first(params[key]);
    if (value) query[key] = value;
  }
  if (page > 1) query.page = String(page);
  return { pathname: '/admin/facilities', query };
}

export default async function AdminFacilitiesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: SearchParams;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const sp = await searchParams;
  const filters = parseFilters(sp);

  // Scoped: the list links into the editor, so it must not advertise
  // facilities this account cannot open.
  const user = await requireAdmin();
  const [t, tStatus, tSource, tSport, { rows, total }, municipalities] = await Promise.all([
    getTranslations('AdminFacilities'),
    getTranslations('AdminStatus'),
    getTranslations('Source'),
    getTranslations('Sport'),
    listFacilities({ id: user.id, role: user.role }, filters),
    municipalityOptions(),
  ]);
  const pages = Math.max(1, Math.ceil(total / FACILITIES_PAGE_SIZE));

  return (
    <main className="space-y-4">
      <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>

      <form method="get" className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          name="q"
          size="sm"
          defaultValue={filters.q ?? ''}
          placeholder={t('searchPlaceholder')}
          className="w-56"
        />
        <div className="w-56">
        <Select
          name="municipality"
          size="sm"
          defaultValue={filters.municipality === 'none' ? 'none' : (filters.municipality ?? '')}
        >
          <option value="">{t('allMunicipalities')}</option>
          <option value="none">{t('noMunicipality')}</option>
          {municipalities.map((m) => (
            <option key={m.id} value={m.id}>
              {m.nameBg}
            </option>
          ))}
        </Select>
        </div>
        <div className="w-48">
        <Select name="status" size="sm" defaultValue={filters.status ?? ''}>
          <option value="">{t('allStatuses')}</option>
          {STATUS_VALUES.map((s) => (
            <option key={s} value={s}>
              {tStatus(s)}
            </option>
          ))}
        </Select>
        </div>
        <div className="w-48">
        <Select name="source" size="sm" defaultValue={filters.source ?? ''}>
          <option value="">{t('allSources')}</option>
          {SOURCE_VALUES.map((s) => (
            <option key={s} value={s}>
              {tSource(s)}
            </option>
          ))}
        </Select>
        </div>
        <Button type="submit" size="sm">
          {t('search')}
        </Button>
      </form>

      {rows.length === 0 ? (
        <p className="text-body-sm text-text-muted">{t('empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-card border border-line bg-surface shadow-sm">
          <table className="w-full text-body-sm">
            <thead>
              <tr className="border-b border-line bg-paper-sunk text-left">
                <th scope="col" className="t-overline px-3 py-2.5 font-semibold">{t('colName')}</th>
                <th scope="col" className="t-overline px-3 py-2.5 font-semibold">{t('colMunicipality')}</th>
                <th scope="col" className="t-overline px-3 py-2.5 font-semibold">{t('colSports')}</th>
                <th scope="col" className="t-overline px-3 py-2.5 font-semibold">{t('colStatus')}</th>
                <th scope="col" className="t-overline px-3 py-2.5 font-semibold">{t('colSource')}</th>
                <th scope="col" className="t-overline px-3 py-2.5 font-semibold">{t('colUpdated')}</th>
                <th scope="col" className="t-overline px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((row) => (
                <tr key={row.id} className="align-top">
                  <td className="px-3 py-2.5">
                    {row.name ?? <span className="text-text-faint">{t('unnamed')}</span>}
                    {row.quarter && <div className="text-caption text-text-muted">{row.quarter}</div>}
                  </td>
                  <td className="px-3 py-2.5">{row.municipalityName ?? '—'}</td>
                  <td className="px-3 py-2.5">
                    {row.sportTypes.map((s) => (tSport.has(s) ? tSport(s) : s)).join(', ') || '—'}
                  </td>
                  <td className="px-3 py-2.5">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="px-3 py-2.5">{tSource(row.source)}</td>
                  <td className="px-3 py-2.5 font-mono text-caption whitespace-nowrap text-text-muted tabular-nums">
                    {row.updatedAt.slice(0, 10)}
                  </td>
                  <td className="px-3 py-2.5">
                    <details>
                      <summary className="cursor-pointer text-caption font-medium text-link hover:text-link-hover">
                        {t('preview')}
                      </summary>
                      <div className="w-80 py-2">
                        <MapEmbed lon={row.lon} lat={row.lat} heightClass="h-48" />
                      </div>
                    </details>
                    <Link
                      href={`/admin/facilities/${row.id}`}
                      className="text-caption font-medium text-link hover:text-link-hover"
                    >
                      {t('edit')}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center gap-3 text-body-sm">
        {filters.page > 1 && (
          <Link
            href={pageHref(sp, filters.page - 1)}
            className="inline-flex items-center gap-1.5 rounded-pill border border-line-strong bg-surface px-3 py-1.5 text-caption font-semibold text-ink-soft hover:bg-surface-2"
          >
            <ArrowLeft size={15} />
            {t('prev')}
          </Link>
        )}
        <span className="font-mono text-caption text-text-muted tabular-nums">
          {t('pageOf', { page: filters.page, pages, total })}
        </span>
        {filters.page < pages && (
          <Link
            href={pageHref(sp, filters.page + 1)}
            className="inline-flex items-center gap-1.5 rounded-pill border border-line-strong bg-surface px-3 py-1.5 text-caption font-semibold text-ink-soft hover:bg-surface-2"
          >
            {t('next')}
            <ArrowRight size={15} />
          </Link>
        )}
      </div>
    </main>
  );
}
