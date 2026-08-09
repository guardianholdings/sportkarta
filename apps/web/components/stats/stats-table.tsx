'use client';

import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import { cityDisplayName } from '@/lib/city-names';
import type { MunicipalityStat } from '@/lib/stats-data';
import { pct } from '@/lib/stats-format';

interface Row {
  ekatteCode: string;
  name: string;
  total: number;
  per10k: number | null;
  freePct: number | null;
  litPct: number | null;
  needsPct: number | null;
}

// Sortable columns only (ekatteCode is the row key, never a sort column).
type SortKey = Exclude<keyof Row, 'ekatteCode'>;

function compare(a: Row, b: Row, key: SortKey, dir: 1 | -1): number {
  const av = a[key];
  const bv = b[key];
  if (typeof av === 'string' || typeof bv === 'string') {
    return String(av).localeCompare(String(bv), 'bg') * dir;
  }
  // Nulls always sort last, regardless of direction.
  if (av === null && bv === null) return 0;
  if (av === null) return 1;
  if (bv === null) return -1;
  return (av - bv) * dir;
}

export function StatsTable({
  municipalities,
  locale,
}: {
  municipalities: MunicipalityStat[];
  locale: string;
}) {
  const t = useTranslations('Stats');
  const [sortKey, setSortKey] = useState<SortKey>('total');
  const [dir, setDir] = useState<1 | -1>(-1);

  const rows = useMemo<Row[]>(
    () =>
      municipalities.map((m) => ({
        ekatteCode: m.ekatteCode,
        name: cityDisplayName(m.nameBg, m.nameEn, locale),
        total: m.total,
        per10k: m.per10k,
        freePct: pct(m.free, m.total),
        litPct: pct(m.litTrue, m.litKnown),
        needsPct: pct(m.needsVerification, m.total),
      })),
    [municipalities, locale],
  );

  const sorted = useMemo(
    () => [...rows].sort((a, b) => compare(a, b, sortKey, dir)),
    [rows, sortKey, dir],
  );

  function toggleSort(key: SortKey) {
    if (key === sortKey) setDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setDir(key === 'name' ? 1 : -1);
    }
  }

  const na = t('na');
  const fmtPct = (v: number | null) => (v === null ? na : `${v.toFixed(1)}%`);
  const fmtNum = (v: number | null) => (v === null ? na : v.toFixed(2));

  const columns: { key: SortKey; label: string; render: (r: Row) => string; numeric: boolean }[] = [
    { key: 'name', label: t('colMunicipality'), render: (r) => r.name, numeric: false },
    { key: 'total', label: t('colTotal'), render: (r) => String(r.total), numeric: true },
    { key: 'per10k', label: t('colPer10k'), render: (r) => fmtNum(r.per10k), numeric: true },
    { key: 'freePct', label: t('colFree'), render: (r) => fmtPct(r.freePct), numeric: true },
    { key: 'litPct', label: t('colLit'), render: (r) => fmtPct(r.litPct), numeric: true },
    {
      key: 'needsPct',
      label: t('colNeedsVerification'),
      render: (r) => fmtPct(r.needsPct),
      numeric: true,
    },
  ];

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-body-sm">
        <thead>
          <tr className="border-b border-line-strong text-left">
            {columns.map((c) => (
              <th
                key={c.key}
                aria-sort={sortKey === c.key ? (dir === 1 ? 'ascending' : 'descending') : 'none'}
                className={c.numeric ? 'text-right' : ''}
              >
                <button
                  type="button"
                  onClick={() => {
                    toggleSort(c.key);
                  }}
                  className={`px-2 py-2 font-medium hover:text-link-hover ${c.numeric ? 'w-full text-right' : ''}`}
                >
                  {c.label}
                  {sortKey === c.key ? (dir === 1 ? ' ▲' : ' ▼') : ''}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.ekatteCode} className="border-b border-line">
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={`px-2 py-1.5 ${c.numeric ? 'text-right font-mono tabular-nums' : ''}`}
                >
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
