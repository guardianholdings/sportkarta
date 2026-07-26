'use client';

import { useActionState, useState } from 'react';

import {
  commitCsvAction,
  createGridAction,
  parseCsvAction,
  previewCsvAction,
  type BulkState,
} from './actions';

/**
 * The bulk-create screens (docs/ROADMAP.md §6, Stage 4.5).
 *
 * Optimised for the thing that actually happens: one slot, thirty playgrounds.
 * The grid is the default tab, the slot is described once at the top, and the
 * facility list is filterable and tickable in bulk — no per-row dialogs and one
 * submit for the whole batch.
 */

const EMPTY: BulkState = { step: 'input', error: null };

export interface FacilityOption {
  id: string;
  name: string;
  cityName: string;
  sports: string[];
}

/**
 * Flat label bag passed from the server component — the page owns i18n, this
 * file owns interaction. `L` is the accessor: an unknown key renders as itself
 * rather than as "undefined", so a missing translation is visible, not silent.
 */
export type Labels = Readonly<Record<string, string>>;

function labelOf(labels: Labels, key: string): string {
  return labels[key] ?? key;
}

export function BulkCreateTabs({
  facilities,
  facilityTotal,
  sports,
  labels,
  fieldLabels,
}: {
  facilities: FacilityOption[];
  /** Named non-gone facilities in the DB — more than shipped means truncation. */
  facilityTotal: number;
  sports: string[];
  labels: Labels;
  fieldLabels: Labels;
}) {
  const L = (key: string): string => labelOf(labels, key);
  const [tab, setTab] = useState<'grid' | 'csv'>('grid');
  return (
    <div className="space-y-4">
      <div role="tablist" className="flex gap-2 border-b border-line">
        {(['grid', 'csv'] as const).map((key) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => {
              setTab(key);
            }}
            className={
              tab === key
                ? 'border-b-2 border-brand px-3 py-2 text-body-sm font-semibold text-brand'
                : 'px-3 py-2 text-body-sm text-text-muted hover:text-ink'
            }
          >
            {key === 'grid' ? L('gridTab') : L('csvTab')}
          </button>
        ))}
      </div>
      {tab === 'grid' ? (
        <GridForm
          facilities={facilities}
          facilityTotal={facilityTotal}
          sports={sports}
          labels={labels}
          fieldLabels={fieldLabels}
        />
      ) : (
        <CsvForm labels={labels} />
      )}
    </div>
  );
}

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

function GridForm({
  facilities,
  facilityTotal,
  sports,
  labels,
  fieldLabels,
}: {
  facilities: FacilityOption[];
  facilityTotal: number;
  sports: string[];
  labels: Labels;
  fieldLabels: Labels;
}) {
  const L = (key: string): string => labelOf(labels, key);
  const F = (key: string): string => labelOf(fieldLabels, key);
  const [state, action, pending] = useActionState(createGridAction, EMPTY);
  const [city, setCity] = useState('');
  const [sportFilter, setSportFilter] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const cities = [...new Set(facilities.map((f) => f.cityName))].sort();
  const visible = facilities.filter(
    (f) =>
      (city === '' || f.cityName === city) &&
      (sportFilter === '' || f.sports.includes(sportFilter)) &&
      (search === '' || f.name.toLowerCase().includes(search.toLowerCase())),
  );

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (state.step === 'done') return <DonePanel state={state} labels={labels} />;

  return (
    <form action={action} className="space-y-6">
      <fieldset className="grid gap-3 sm:grid-cols-2">
        <Field label={L('sport')}>
          <select name="sport" required className="w-full rounded-md border border-line-strong bg-surface p-2">
            {sports.map((sport) => (
              <option key={sport} value={sport}>
                {F(sport)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={L('sessionTitle')}>
          <input
            name="title"
            required
            maxLength={120}
            className="w-full rounded-md border border-line-strong bg-surface p-2"
          />
        </Field>
        <Field label={L('startDate')}>
          <input
            type="date"
            name="date"
            required
            className="w-full rounded-md border border-line-strong bg-surface p-2"
          />
        </Field>
        <Field label={L('startTime')}>
          <input
            type="time"
            name="time"
            required
            step={60}
            className="w-full rounded-md border border-line-strong bg-surface p-2"
          />
        </Field>
        <Field label={L('duration')}>
          <input
            type="number"
            name="duration"
            defaultValue={90}
            min={15}
            max={480}
            className="w-full rounded-md border border-line-strong bg-surface p-2"
          />
        </Field>
        <Field label={L('capacity')}>
          <input
            type="number"
            name="capacity"
            min={1}
            max={500}
            className="w-full rounded-md border border-line-strong bg-surface p-2"
          />
        </Field>
        <Field label={L('skillLevel')}>
          <select name="skillLevel" className="w-full rounded-md border border-line-strong bg-surface p-2">
            {['any', 'beginner', 'intermediate', 'advanced'].map((level) => (
              <option key={level} value={level}>
                {F(level)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={L('visibility')}>
          <select name="visibility" className="w-full rounded-md border border-line-strong bg-surface p-2">
            {['public', 'unlisted'].map((value) => (
              <option key={value} value={value}>
                {F(value)}
              </option>
            ))}
          </select>
        </Field>
      </fieldset>

      <fieldset>
        <legend className="mb-1 text-caption font-medium text-ink-soft">{L('weekdays')}</legend>
        <div className="flex flex-wrap gap-2">
          {WEEKDAYS.map((day) => (
            <label
              key={day}
              className="flex items-center gap-1.5 rounded-pill border border-line-strong px-2.5 py-1 text-body-sm"
            >
              <input type="checkbox" name="weekday" value={day} />
              {F(`weekday${String(day)}`)}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-caption font-medium text-ink-soft">{L('facilities')}</legend>
        <div className="flex flex-wrap gap-2">
          <select
            value={city}
            onChange={(e) => {
              setCity(e.target.value);
            }}
            className="rounded-md border border-line-strong bg-surface p-2 text-body-sm"
          >
            <option value="">{L('filterCity')}</option>
            {cities.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <select
            value={sportFilter}
            onChange={(e) => {
              setSportFilter(e.target.value);
            }}
            className="rounded-md border border-line-strong bg-surface p-2 text-body-sm"
          >
            <option value="">{L('filterSport')}</option>
            {sports.map((sport) => (
              <option key={sport} value={sport}>
                {F(sport)}
              </option>
            ))}
          </select>
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
            }}
            placeholder={L('filterName')}
            className="min-w-40 flex-1 rounded-md border border-line-strong bg-surface p-2 text-body-sm"
          />
          {/* Bulk selection acts on what is FILTERED, which is the whole point:
              "every football pitch in Plovdiv" is two filters and one click. */}
          <button
            type="button"
            onClick={() => {
              setSelected((prev) => new Set([...prev, ...visible.map((f) => f.id)]));
            }}
            className="rounded-pill border border-line-strong bg-surface px-3 py-2 text-body-sm font-semibold text-ink-soft hover:bg-surface-2"
          >
            {L('selectAll')}
          </button>
          <button
            type="button"
            onClick={() => {
              setSelected(new Set());
            }}
            className="rounded-pill border border-line-strong bg-surface px-3 py-2 text-body-sm font-semibold text-ink-soft hover:bg-surface-2"
          >
            {L('clearAll')}
          </button>
        </div>

        <p className="text-body-sm text-ink-soft">
          {L('selectedCount').replace('{count}', String(selected.size))}
        </p>

        {/* The filters above act on the SHIPPED list, so if the server capped it
            the missing facilities are unfindable, not merely unlisted — say so
            instead of letting the list look complete (AUDIT-F1). */}
        {facilities.length < facilityTotal && (
          <p className="rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-body-sm text-warning">
            {L('facilityListTruncated')
              .replace('{shown}', String(facilities.length))
              .replace('{total}', String(facilityTotal))}
          </p>
        )}

        <ul className="max-h-80 divide-y divide-line overflow-y-auto rounded-card border border-line bg-surface">
          {visible.map((facility) => (
            <li key={facility.id}>
              <label className="flex cursor-pointer items-center gap-2 px-3 py-2 text-body-sm hover:bg-paper-sunk">
                <input
                  type="checkbox"
                  checked={selected.has(facility.id)}
                  onChange={() => {
                    toggle(facility.id);
                  }}
                />
                <span className="flex-1">{facility.name}</span>
                <span className="text-caption text-text-muted">{facility.cityName}</span>
              </label>
            </li>
          ))}
        </ul>
        {/* The submitted set is the ticked one, not the visible one — changing a
            filter must never silently change what is about to be created. */}
        {[...selected].map((id) => (
          <input key={id} type="hidden" name="facilityId" value={id} />
        ))}
      </fieldset>

      {state.error && <ErrorLine code={state.error} labels={labels} />}

      <button
        type="submit"
        disabled={pending || selected.size === 0}
        className="rounded-pill bg-brand px-5 py-3 text-body-sm font-semibold text-on-brand shadow-xs hover:bg-brand-hover disabled:opacity-50"
      >
        {L('create')} ({selected.size})
      </button>
    </form>
  );
}

function CsvForm({ labels }: { labels: Labels }) {
  const L = (key: string): string => labelOf(labels, key);
  const [state, action, pending] = useActionState(parseCsvAction, EMPTY);
  if (state.step === 'map') return <MappingForm state={state} labels={labels} />;

  return (
    <form action={action} className="space-y-3">
      <p className="text-body-sm text-ink-soft">{L('templateHint')}</p>
      <label className="block text-body-sm font-medium text-ink-soft">
        {L('csvPaste')}
        <textarea
          name="csv"
          rows={8}
          className="mt-1 w-full rounded-md border border-line-strong bg-surface p-2 font-mono text-caption"
        />
      </label>
      <label className="block text-body-sm font-medium text-ink-soft">
        {L('csvUpload')}
        <input type="file" name="file" accept=".csv,text/csv" className="mt-1 block text-body-sm" />
      </label>
      {state.error && <ErrorLine code={state.error} labels={labels} />}
      <button
        type="submit"
        disabled={pending}
        className="rounded-pill bg-brand px-5 py-3 text-body-sm font-semibold text-on-brand shadow-xs hover:bg-brand-hover disabled:opacity-50"
      >
        {L('csvParse')}
      </button>
    </form>
  );
}

const MAPPABLE = [
  'facility',
  'sport',
  'title',
  'description',
  'date',
  'time',
  'duration',
  'rrule',
  'capacity',
  'skillLevel',
  'visibility',
] as const;

function MappingForm({ state, labels }: { state: BulkState; labels: Labels }) {
  const L = (key: string): string => labelOf(labels, key);
  const [next, action, pending] = useActionState(previewCsvAction, EMPTY);
  if (next.step === 'preview') return <PreviewForm state={next} labels={labels} />;

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="csv" value={state.csv ?? ''} />
      <h2 className="text-h4 font-bold text-ink">{L('mapColumns')}</h2>
      <p className="text-body-sm text-ink-soft">{L('mapHint')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {MAPPABLE.map((field) => (
          <label key={field} className="block text-body-sm">
            <span className="text-caption font-medium text-ink-soft">{L(field) ?? field}</span>
            <select
              name={`map.${field}`}
              defaultValue={state.mapping?.[field] ?? ''}
              className="mt-1 w-full rounded-md border border-line-strong bg-surface p-2"
            >
              <option value="">{L('ignoreColumn')}</option>
              {(state.headers ?? []).map((header, index) => (
                <option key={`${header}-${String(index)}`} value={index}>
                  {header || `#${String(index + 1)}`}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>

      {(state.sampleRows ?? []).length > 0 && (
        <div className="overflow-x-auto rounded-card border border-line bg-surface">
          <table className="w-full text-caption">
            <thead className="bg-paper-sunk">
              <tr>
                {(state.headers ?? []).map((header, i) => (
                  <th key={`${header}-${String(i)}`} className="t-overline px-2 py-1.5 text-left font-semibold">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(state.sampleRows ?? []).map((row, i) => (
                <tr key={i} className="border-t border-line">
                  {row.map((cell, j) => (
                    <td key={j} className="px-2 py-1 whitespace-nowrap">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <button
        type="submit"
        disabled={pending}
        className="rounded-pill bg-brand px-5 py-3 text-body-sm font-semibold text-on-brand shadow-xs hover:bg-brand-hover disabled:opacity-50"
      >
        {L('preview')}
      </button>
    </form>
  );
}

function PreviewForm({ state, labels }: { state: BulkState; labels: Labels }) {
  const L = (key: string): string => labelOf(labels, key);
  const [done, action, pending] = useActionState(commitCsvAction, EMPTY);
  if (done.step === 'done') return <DonePanel state={done} labels={labels} />;

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="csv" value={state.csv ?? ''} />
      {Object.entries(state.mapping ?? {}).map(([field, index]) => (
        <input key={field} type="hidden" name={`map.${field}`} value={index} />
      ))}
      <h2 className="text-h4 font-bold text-ink">{L('preview')}</h2>
      <p className="text-body-sm text-ink-soft">{L('previewHint')}</p>
      <RowTable rows={state.preview ?? []} labels={labels} />
      <button
        type="submit"
        disabled={pending || (state.validCount ?? 0) === 0}
        className="rounded-pill bg-brand px-5 py-3 text-body-sm font-semibold text-on-brand shadow-xs hover:bg-brand-hover disabled:opacity-50"
      >
        {L('confirmImport').replace('{count}', String(state.validCount ?? 0))}
      </button>
    </form>
  );
}

function DonePanel({ state, labels }: { state: BulkState; labels: Labels }) {
  const L = (key: string): string => labelOf(labels, key);
  return (
    <div className="space-y-4">
      <p className="rounded-md border border-success-border bg-success-bg px-3 py-2 text-body-sm text-success">
        {L('createdCount').replace('{count}', String(state.created ?? 0))}
      </p>
      {(state.skipped ?? []).length > 0 && (
        <>
          <p className="rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-body-sm text-warning">
            {L('skippedCount').replace('{count}', String(state.skipped?.length ?? 0))}
          </p>
          <RowTable rows={state.skipped ?? []} labels={labels} />
        </>
      )}
    </div>
  );
}

function RowTable({ rows, labels }: { rows: BulkState['preview'] & object; labels: Labels }) {
  const L = (key: string): string => labelOf(labels, key);
  return (
    <div className="overflow-x-auto rounded-card border border-line bg-surface">
      <table className="w-full text-body-sm">
        <thead className="bg-paper-sunk">
          <tr>
            <th className="t-overline px-2 py-1.5 text-left font-semibold">{L('rowNumber')}</th>
            <th className="t-overline px-2 py-1.5 text-left font-semibold">{L('facility')}</th>
            <th className="t-overline px-2 py-1.5 text-left font-semibold">{L('sessionTitle')}</th>
            <th className="t-overline px-2 py-1.5 text-left font-semibold">{L('status')}</th>
            <th className="t-overline px-2 py-1.5 text-left font-semibold">{L('reason')}</th>
          </tr>
        </thead>
        <tbody>
          {(rows ?? []).map((row) => (
            <tr key={row.rowNumber} className="border-t border-line">
              <td className="px-2 py-1 font-mono tabular-nums">{row.rowNumber}</td>
              <td className="px-2 py-1">{row.facility}</td>
              <td className="px-2 py-1">{row.title}</td>
              <td className="px-2 py-1">
                <span className={row.ok ? 'text-success' : 'text-warning'}>
                  {row.ok ? L('rowOk') : L('rowError')}
                </span>
              </td>
              <td className="px-2 py-1 text-ink-soft">
                {row.error ? (L(`error_${row.error}`) ?? row.error) : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-body-sm">
      <span className="text-caption font-medium text-ink-soft">{label}</span>
      <span className="mt-1 block">{children}</span>
    </label>
  );
}

function ErrorLine({ code, labels }: { code: string; labels: Labels }) {
  const L = (key: string): string => labelOf(labels, key);
  return (
    <p className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-body-sm text-danger">
      {L(`error_${code}`) ?? L(code) ?? code}
    </p>
  );
}
