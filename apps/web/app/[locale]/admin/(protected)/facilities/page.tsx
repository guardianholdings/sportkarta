import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import { MapEmbed } from '@/components/admin/map-embed';
import { StatusBadge } from '@/components/admin/status-badge';
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

  const [t, tStatus, tSource, tSport, { rows, total }, municipalities] = await Promise.all([
    getTranslations('AdminFacilities'),
    getTranslations('AdminStatus'),
    getTranslations('Source'),
    getTranslations('Sport'),
    listFacilities(filters),
    municipalityOptions(),
  ]);
  const pages = Math.max(1, Math.ceil(total / FACILITIES_PAGE_SIZE));

  return (
    <main className="space-y-4">
      <h1 className="text-xl font-semibold">{t('title')}</h1>

      <form method="get" className="flex flex-wrap items-end gap-2 text-sm">
        <input
          type="search"
          name="q"
          defaultValue={filters.q ?? ''}
          placeholder={t('searchPlaceholder')}
          className="w-56 rounded border border-neutral-300 px-3 py-2"
        />
        <select
          name="municipality"
          defaultValue={filters.municipality === 'none' ? 'none' : (filters.municipality ?? '')}
          className="rounded border border-neutral-300 px-2 py-2"
        >
          <option value="">{t('allMunicipalities')}</option>
          <option value="none">{t('noMunicipality')}</option>
          {municipalities.map((m) => (
            <option key={m.id} value={m.id}>
              {m.nameBg}
            </option>
          ))}
        </select>
        <select
          name="status"
          defaultValue={filters.status ?? ''}
          className="rounded border border-neutral-300 px-2 py-2"
        >
          <option value="">{t('allStatuses')}</option>
          {STATUS_VALUES.map((s) => (
            <option key={s} value={s}>
              {tStatus(s)}
            </option>
          ))}
        </select>
        <select
          name="source"
          defaultValue={filters.source ?? ''}
          className="rounded border border-neutral-300 px-2 py-2"
        >
          <option value="">{t('allSources')}</option>
          {SOURCE_VALUES.map((s) => (
            <option key={s} value={s}>
              {tSource(s)}
            </option>
          ))}
        </select>
        <button type="submit" className="rounded bg-neutral-900 px-4 py-2 font-medium text-white">
          {t('search')}
        </button>
      </form>

      {rows.length === 0 ? (
        <p className="text-neutral-500">{t('empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-300 text-left text-xs text-neutral-500">
                <th className="py-2 pr-3">{t('colName')}</th>
                <th className="py-2 pr-3">{t('colMunicipality')}</th>
                <th className="py-2 pr-3">{t('colSports')}</th>
                <th className="py-2 pr-3">{t('colStatus')}</th>
                <th className="py-2 pr-3">{t('colSource')}</th>
                <th className="py-2 pr-3">{t('colUpdated')}</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-neutral-100 align-top">
                  <td className="py-2 pr-3">
                    {row.name ?? <span className="text-neutral-400">{t('unnamed')}</span>}
                    {row.quarter && <div className="text-xs text-neutral-500">{row.quarter}</div>}
                  </td>
                  <td className="py-2 pr-3">{row.municipalityName ?? '—'}</td>
                  <td className="py-2 pr-3">
                    {row.sportTypes.map((s) => (tSport.has(s) ? tSport(s) : s)).join(', ') || '—'}
                  </td>
                  <td className="py-2 pr-3">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="py-2 pr-3">{tSource(row.source)}</td>
                  <td className="py-2 pr-3 text-xs whitespace-nowrap text-neutral-500">
                    {row.updatedAt.slice(0, 10)}
                  </td>
                  <td className="py-2">
                    <details>
                      <summary className="cursor-pointer text-xs underline">{t('preview')}</summary>
                      <div className="w-80 py-2">
                        <MapEmbed lon={row.lon} lat={row.lat} heightClass="h-48" />
                      </div>
                    </details>
                    <Link href={`/admin/facilities/${row.id}`} className="text-xs underline">
                      {t('edit')}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center gap-3 text-sm">
        {filters.page > 1 && (
          <Link href={pageHref(sp, filters.page - 1)} className="underline">
            ← {t('prev')}
          </Link>
        )}
        <span className="text-neutral-500">
          {t('pageOf', { page: filters.page, pages, total })}
        </span>
        {filters.page < pages && (
          <Link href={pageHref(sp, filters.page + 1)} className="underline">
            {t('next')} →
          </Link>
        )}
      </div>
    </main>
  );
}
