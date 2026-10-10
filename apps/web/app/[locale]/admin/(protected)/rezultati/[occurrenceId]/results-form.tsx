'use client';

import { useState } from 'react';

import { useLabels, type LabelTranslator, type Labels } from '@/components/admin/use-labels';
import { useFormAction } from '@/lib/use-form-action';

import {
  commitResultsCsvAction,
  parseResultsCsvAction,
  previewResultsCsvAction,
  saveResultsAction,
  type ResultsState,
} from '../actions';

/**
 * Per-occurrence result entry (docs/ROADMAP.md §6, Stage 4.6).
 *
 * A repeating-row form, because that is what entering a scoreline is: type,
 * tab, type. Rows are added locally with no round trip, and the CSV path reuses
 * the mapping + preview flow from /admin/sesii so an operator learns it once.
 *
 * Every step holds useFormAction, not useActionState: React 19 resets a form
 * after any result, so a refused row used to wipe the whole scoresheet (A-2).
 * The copy arrives as ICU templates (useLabels), so «1 резултат» agrees.
 */

const EMPTY: ResultsState = { step: 'input', error: null };
const BLANK_ROWS = 4;

export function ResultsEditor({
  occurrenceId,
  existing,
  labels,
}: {
  occurrenceId: string;
  existing: { participant: string; team: string; position: string; score: string; note: string }[];
  labels: Labels;
}) {
  const t = useLabels(labels);
  const [tab, setTab] = useState<'form' | 'csv'>('form');

  return (
    <div className="space-y-4">
      <div role="tablist" className="flex gap-2 border-b border-line">
        {(['form', 'csv'] as const).map((key) => (
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
                : 'px-3 py-2 text-body-sm text-text-muted'
            }
          >
            {/* «Ръчно въвеждане», not «Запази»: a tab is a place, and three
                different things on this screen were all called «Запази» (A-15). */}
            {key === 'form' ? t('manualTab') : t('csvImport')}
          </button>
        ))}
      </div>
      {tab === 'form' ? (
        <ManualForm occurrenceId={occurrenceId} existing={existing} labels={labels} />
      ) : (
        <CsvFlow occurrenceId={occurrenceId} labels={labels} />
      )}
    </div>
  );
}

const COLUMNS = ['participant', 'team', 'position', 'score', 'note'] as const;

function ManualForm({
  occurrenceId,
  existing,
  labels,
}: {
  occurrenceId: string;
  existing: { participant: string; team: string; position: string; score: string; note: string }[];
  labels: Labels;
}) {
  const t = useLabels(labels);
  // Never reset: after a save the fields hold what was saved, after a refusal
  // they hold what to correct.
  const [state, formProps, pending] = useFormAction(saveResultsAction, EMPTY);
  const [rowCount, setRowCount] = useState(Math.max(existing.length + 1, BLANK_ROWS));

  // Every cell is a bare input in a grid, so each carries its own name — the
  // column header is not its label for a screen reader (A-17).
  const cellLabel = (column: (typeof COLUMNS)[number], row: number): string =>
    t('cellLabel', { field: t(column), row });

  return (
    <form {...formProps} className="space-y-4">
      <input type="hidden" name="occurrenceId" value={occurrenceId} />

      {state.step === 'done' && (
        <p
          role="status"
          className="rounded-md border border-success-border bg-success-bg px-3 py-2 text-body-sm text-success"
        >
          {t('saved', { count: state.saved ?? 0 })}
        </p>
      )}
      {state.error && <ErrorLine code={state.error} t={t} />}
      {(state.skipped ?? []).length > 0 && <SkippedTable rows={state.skipped ?? []} t={t} />}

      <div className="overflow-x-auto rounded-card border border-line bg-surface">
        <table className="w-full text-body-sm">
          <thead className="bg-paper-sunk">
            <tr>
              {COLUMNS.map((column) => (
                <th key={column} className="t-overline px-2 py-1.5 text-left font-semibold">
                  {t(column)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rowCount }, (_, i) => {
              const row = existing[i];
              return (
                <tr key={i} className="border-t border-line">
                  <td className="p-1">
                    <input
                      name="participant"
                      defaultValue={row?.participant ?? ''}
                      placeholder={t('participantHint')}
                      aria-label={cellLabel('participant', i + 1)}
                      className="w-full rounded-md border border-line-strong p-1.5"
                    />
                  </td>
                  <td className="p-1">
                    <input
                      name="team"
                      defaultValue={row?.team ?? ''}
                      aria-label={cellLabel('team', i + 1)}
                      className="w-full rounded-md border border-line-strong p-1.5"
                    />
                  </td>
                  <td className="p-1">
                    <input
                      name="position"
                      type="number"
                      min={1}
                      defaultValue={row?.position ?? ''}
                      aria-label={cellLabel('position', i + 1)}
                      className="w-20 rounded-md border border-line-strong p-1.5"
                    />
                  </td>
                  <td className="p-1">
                    <input
                      name="score"
                      defaultValue={row?.score ?? ''}
                      placeholder={t('scoreHint')}
                      aria-label={cellLabel('score', i + 1)}
                      className="w-full rounded-md border border-line-strong p-1.5"
                    />
                  </td>
                  <td className="p-1">
                    <input
                      name="note"
                      defaultValue={row?.note ?? ''}
                      placeholder={t('noteHint')}
                      aria-label={cellLabel('note', i + 1)}
                      className="w-full rounded-md border border-line-strong p-1.5"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => {
            setRowCount((n) => n + 1);
          }}
          className="rounded-pill border border-line-strong bg-surface px-3 py-2 text-body-sm font-semibold text-ink-soft hover:bg-surface-2"
        >
          {t('addRow')}
        </button>
        <button
          type="submit"
          disabled={pending}
          className="rounded-pill bg-brand px-4 py-2 text-body-sm font-semibold text-on-brand shadow-xs focus-visible:shadow-[var(--ring)] hover:bg-brand-hover disabled:opacity-50"
        >
          {t('save')}
        </button>
      </div>
    </form>
  );
}

function CsvFlow({ occurrenceId, labels }: { occurrenceId: string; labels: Labels }) {
  const t = useLabels(labels);
  const [state, formProps, pending] = useFormAction(parseResultsCsvAction, EMPTY);

  if (state.step === 'map') {
    return <MappingStep occurrenceId={occurrenceId} state={state} labels={labels} />;
  }

  return (
    <form {...formProps} className="space-y-3">
      <label className="block text-body-sm font-medium text-ink-soft">
        {t('csvImport')}
        <textarea
          name="csv"
          rows={8}
          className="mt-1 w-full rounded-md border border-line-strong bg-surface p-2 font-mono text-caption"
        />
      </label>
      <label className="block text-body-sm font-medium text-ink-soft">
        {t('csvUpload')}
        <input type="file" name="file" accept=".csv,text/csv" className="mt-1 block text-body-sm" />
      </label>
      {state.error && <ErrorLine code={state.error} t={t} />}
      <button
        type="submit"
        disabled={pending}
        className="rounded-pill bg-brand px-4 py-2 text-body-sm font-semibold text-on-brand shadow-xs focus-visible:shadow-[var(--ring)] hover:bg-brand-hover disabled:opacity-50"
      >
        {t('csvImport')}
      </button>
    </form>
  );
}

function MappingStep({
  occurrenceId,
  state,
  labels,
}: {
  occurrenceId: string;
  state: ResultsState;
  labels: Labels;
}) {
  const t = useLabels(labels);
  // Never reset: a reset would put every column choice back to the guess.
  const [next, formProps, pending] = useFormAction(previewResultsCsvAction, EMPTY);
  if (next.step === 'preview') {
    return <PreviewStep occurrenceId={occurrenceId} state={next} labels={labels} />;
  }

  return (
    <form {...formProps} className="space-y-4">
      <input type="hidden" name="csv" value={state.csv ?? ''} />
      <div className="grid gap-3 sm:grid-cols-2">
        {COLUMNS.map((field) => (
          <label key={field} className="block text-body-sm">
            <span className="font-medium">{t(field)}</span>
            <select
              name={`map.${field}`}
              defaultValue={state.mapping?.[field] ?? ''}
              className="mt-1 w-full rounded-md border border-line-strong bg-surface p-2"
            >
              <option value="">{t('ignoreColumn')}</option>
              {(state.headers ?? []).map((header, index) => (
                <option key={`${header}-${String(index)}`} value={index}>
                  {header || `#${String(index + 1)}`}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      {next.error && <ErrorLine code={next.error} t={t} />}
      <button
        type="submit"
        disabled={pending}
        className="rounded-pill bg-brand px-4 py-2 text-body-sm font-semibold text-on-brand shadow-xs focus-visible:shadow-[var(--ring)] hover:bg-brand-hover disabled:opacity-50"
      >
        {/* The next step is a preview that writes nothing — not «Запази» (A-15). */}
        {t('preview')}
      </button>
    </form>
  );
}

function PreviewStep({
  occurrenceId,
  state,
  labels,
}: {
  occurrenceId: string;
  state: ResultsState;
  labels: Labels;
}) {
  const t = useLabels(labels);
  const [done, formProps, pending] = useFormAction(commitResultsCsvAction, EMPTY);

  if (done.step === 'done') {
    return (
      <div className="space-y-3">
        <p
          role="status"
          className="rounded-md border border-success-border bg-success-bg px-3 py-2 text-body-sm text-success"
        >
          {t('saved', { count: done.saved ?? 0 })}
        </p>
        {(done.skipped ?? []).length > 0 && <SkippedTable rows={done.skipped ?? []} t={t} />}
      </div>
    );
  }

  return (
    <form {...formProps} className="space-y-4">
      <input type="hidden" name="occurrenceId" value={occurrenceId} />
      <input type="hidden" name="csv" value={state.csv ?? ''} />
      {Object.entries(state.mapping ?? {}).map(([field, index]) => (
        <input key={field} type="hidden" name={`map.${field}`} value={index} />
      ))}
      <SkippedTable rows={state.preview ?? []} t={t} showOk />
      {done.error && <ErrorLine code={done.error} t={t} />}
      <button
        type="submit"
        disabled={pending || (state.validCount ?? 0) === 0}
        className="rounded-pill bg-brand px-4 py-2 text-body-sm font-semibold text-on-brand shadow-xs focus-visible:shadow-[var(--ring)] hover:bg-brand-hover disabled:opacity-50"
      >
        {t('save')} ({state.validCount ?? 0})
      </button>
    </form>
  );
}

function SkippedTable({
  rows,
  t,
  showOk = false,
}: {
  rows: NonNullable<ResultsState['preview']>;
  t: LabelTranslator;
  showOk?: boolean;
}) {
  const visible = showOk ? rows : rows.filter((row) => !row.ok);
  if (visible.length === 0) return null;

  return (
    <div className="overflow-x-auto rounded-card border border-line bg-surface">
      <table className="w-full text-body-sm">
        <thead className="bg-paper-sunk">
          <tr>
            <th className="t-overline px-2 py-1.5 text-left font-semibold">#</th>
            <th className="t-overline px-2 py-1.5 text-left font-semibold">{t('participant')}</th>
            <th className="t-overline px-2 py-1.5 text-left font-semibold">{t('note')}</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((row) => (
            <tr key={row.rowNumber} className="border-t border-line">
              <td className="px-2 py-1 tabular-nums">{row.rowNumber}</td>
              <td className="px-2 py-1">{row.participant}</td>
              <td className="px-2 py-1 text-ink-soft">
                {row.error ? t(`error_${row.error}`) : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ErrorLine({ code, t }: { code: string; t: LabelTranslator }) {
  return (
    <p
      role="alert"
      className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-body-sm text-danger"
    >
      {t(`error_${code}`)}
    </p>
  );
}
