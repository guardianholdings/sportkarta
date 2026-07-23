'use client';

import { useActionState, useState } from 'react';

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
 */

export type Labels = Readonly<Record<string, string>>;

function labelOf(labels: Labels, key: string): string {
  return labels[key] ?? key;
}

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
  const L = (key: string): string => labelOf(labels, key);
  const [tab, setTab] = useState<'form' | 'csv'>('form');

  return (
    <div className="space-y-4">
      <div role="tablist" className="flex gap-2 border-b border-neutral-200">
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
                ? 'border-b-2 border-neutral-900 px-3 py-2 text-sm font-medium'
                : 'px-3 py-2 text-sm text-neutral-500'
            }
          >
            {key === 'form' ? L('save') : L('csvImport')}
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

function ManualForm({
  occurrenceId,
  existing,
  labels,
}: {
  occurrenceId: string;
  existing: { participant: string; team: string; position: string; score: string; note: string }[];
  labels: Labels;
}) {
  const L = (key: string): string => labelOf(labels, key);
  const [state, action, pending] = useActionState(saveResultsAction, EMPTY);
  const [rowCount, setRowCount] = useState(Math.max(existing.length + 1, BLANK_ROWS));

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="occurrenceId" value={occurrenceId} />

      {state.step === 'done' && (
        <p className="rounded bg-green-50 px-3 py-2 text-sm text-green-800">
          {L('saved')} ({state.saved ?? 0})
        </p>
      )}
      {state.error && (
        <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-800">
          {L(`error_${state.error}`)}
        </p>
      )}
      {(state.skipped ?? []).length > 0 && (
        <SkippedTable rows={state.skipped ?? []} labels={labels} />
      )}

      <div className="overflow-x-auto rounded border border-neutral-200">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50">
            <tr>
              <th className="px-2 py-1 text-left font-medium">{L('participant')}</th>
              <th className="px-2 py-1 text-left font-medium">{L('team')}</th>
              <th className="px-2 py-1 text-left font-medium">{L('position')}</th>
              <th className="px-2 py-1 text-left font-medium">{L('score')}</th>
              <th className="px-2 py-1 text-left font-medium">{L('note')}</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rowCount }, (_, i) => {
              const row = existing[i];
              return (
                <tr key={i} className="border-t border-neutral-100">
                  <td className="p-1">
                    <input
                      name="participant"
                      defaultValue={row?.participant ?? ''}
                      placeholder={L('participantHint')}
                      className="w-full rounded border border-neutral-300 p-1.5"
                    />
                  </td>
                  <td className="p-1">
                    <input
                      name="team"
                      defaultValue={row?.team ?? ''}
                      className="w-full rounded border border-neutral-300 p-1.5"
                    />
                  </td>
                  <td className="p-1">
                    <input
                      name="position"
                      type="number"
                      min={1}
                      defaultValue={row?.position ?? ''}
                      className="w-20 rounded border border-neutral-300 p-1.5"
                    />
                  </td>
                  <td className="p-1">
                    <input
                      name="score"
                      defaultValue={row?.score ?? ''}
                      placeholder={L('scoreHint')}
                      className="w-full rounded border border-neutral-300 p-1.5"
                    />
                  </td>
                  <td className="p-1">
                    <input
                      name="note"
                      defaultValue={row?.note ?? ''}
                      placeholder={L('noteHint')}
                      className="w-full rounded border border-neutral-300 p-1.5"
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
          className="rounded border border-neutral-300 px-3 py-2 text-sm"
        >
          {L('addRow')}
        </button>
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-neutral-900 px-4 py-2 font-medium text-white disabled:opacity-50"
        >
          {L('save')}
        </button>
      </div>
    </form>
  );
}

const MAPPABLE = ['participant', 'team', 'position', 'score', 'note'] as const;

function CsvFlow({ occurrenceId, labels }: { occurrenceId: string; labels: Labels }) {
  const L = (key: string): string => labelOf(labels, key);
  const [state, action, pending] = useActionState(parseResultsCsvAction, EMPTY);

  if (state.step === 'map') {
    return <MappingStep occurrenceId={occurrenceId} state={state} labels={labels} />;
  }

  return (
    <form action={action} className="space-y-3">
      <label className="block text-sm font-medium">
        {L('csvImport')}
        <textarea
          name="csv"
          rows={8}
          className="mt-1 w-full rounded border border-neutral-300 p-2 font-mono text-xs"
        />
      </label>
      <input type="file" name="file" accept=".csv,text/csv" className="block text-sm" />
      {state.error && (
        <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-800">
          {L(`error_${state.error}`)}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-neutral-900 px-4 py-2 font-medium text-white disabled:opacity-50"
      >
        {L('csvImport')}
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
  const L = (key: string): string => labelOf(labels, key);
  const [next, action, pending] = useActionState(previewResultsCsvAction, EMPTY);
  if (next.step === 'preview') {
    return <PreviewStep occurrenceId={occurrenceId} state={next} labels={labels} />;
  }

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="csv" value={state.csv ?? ''} />
      <div className="grid gap-3 sm:grid-cols-2">
        {MAPPABLE.map((field) => (
          <label key={field} className="block text-sm">
            <span className="font-medium">{L(field)}</span>
            <select
              name={`map.${field}`}
              defaultValue={state.mapping?.[field] ?? ''}
              className="mt-1 w-full rounded border border-neutral-300 p-2"
            >
              <option value="">—</option>
              {(state.headers ?? []).map((header, index) => (
                <option key={`${header}-${String(index)}`} value={index}>
                  {header || `#${String(index + 1)}`}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-neutral-900 px-4 py-2 font-medium text-white disabled:opacity-50"
      >
        {L('save')}
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
  const L = (key: string): string => labelOf(labels, key);
  const [done, action, pending] = useActionState(commitResultsCsvAction, EMPTY);

  if (done.step === 'done') {
    return (
      <div className="space-y-3">
        <p className="rounded bg-green-50 px-3 py-2 text-sm text-green-800">
          {L('saved')} ({done.saved ?? 0})
        </p>
        {(done.skipped ?? []).length > 0 && (
          <SkippedTable rows={done.skipped ?? []} labels={labels} />
        )}
      </div>
    );
  }

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="occurrenceId" value={occurrenceId} />
      <input type="hidden" name="csv" value={state.csv ?? ''} />
      {Object.entries(state.mapping ?? {}).map(([field, index]) => (
        <input key={field} type="hidden" name={`map.${field}`} value={index} />
      ))}
      <SkippedTable rows={state.preview ?? []} labels={labels} showOk />
      <button
        type="submit"
        disabled={pending || (state.validCount ?? 0) === 0}
        className="rounded bg-neutral-900 px-4 py-2 font-medium text-white disabled:opacity-50"
      >
        {L('save')} ({state.validCount ?? 0})
      </button>
    </form>
  );
}

function SkippedTable({
  rows,
  labels,
  showOk = false,
}: {
  rows: NonNullable<ResultsState['preview']>;
  labels: Labels;
  showOk?: boolean;
}) {
  const L = (key: string): string => labelOf(labels, key);
  const visible = showOk ? rows : rows.filter((row) => !row.ok);
  if (visible.length === 0) return null;

  return (
    <div className="overflow-x-auto rounded border border-neutral-200">
      <table className="w-full text-sm">
        <thead className="bg-neutral-50">
          <tr>
            <th className="px-2 py-1 text-left font-medium">#</th>
            <th className="px-2 py-1 text-left font-medium">{L('participant')}</th>
            <th className="px-2 py-1 text-left font-medium">{L('note')}</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((row) => (
            <tr key={row.rowNumber} className="border-t border-neutral-100">
              <td className="px-2 py-1 tabular-nums">{row.rowNumber}</td>
              <td className="px-2 py-1">{row.participant}</td>
              <td className="px-2 py-1 text-neutral-600">
                {row.error ? L(`error_${row.error}`) : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
