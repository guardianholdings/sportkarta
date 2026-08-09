'use client';

import { useActionState, useState } from 'react';

import { commitCsvAction, parseCsvAction, previewCsvAction, type MunicipalState } from './actions';

// Subpath, never the barrel: the barrel re-exports the mailer, which drags
// nodemailer and node:fs into the browser bundle (client-imports.test.ts).
import { MUNICIPAL_FIELDS } from '@sportkarta/lib/import-municipal';

/**
 * The municipal CSV inbox screens (docs/ROADMAP.md §8, Stage 6.3).
 *
 * upload/paste → map columns → preview (resolve conflicts) → done. A client
 * component only because the flow carries state between server actions; every
 * action still runs on the server and re-derives from the CSV, so nothing here
 * is trusted. `L` renders an unknown key as itself, so a missing translation is
 * visible rather than silently blank.
 */

export type Labels = Readonly<Record<string, string>>;

function L(labels: Labels, key: string): string {
  return labels[key] ?? key;
}

const EMPTY: MunicipalState = { step: 'input', error: null };

export function MunicipalImport(props: {
  labels: Labels;
  /** Bulgarian display name per mappable field. */
  fieldLabels: Labels;
  sampleCsv: string;
}) {
  // "Import another" cannot be a navigation: a Link to the SAME URL is a soft
  // navigation, React keeps this component mounted and commitState stays
  // {step:'done'} — the link visibly does nothing (proven by driving). There
  // is also no reset API on useActionState, so the wizard is remounted
  // wholesale by bumping a key, which returns all three action states to EMPTY.
  const [epoch, setEpoch] = useState(0);
  return (
    <MunicipalImportWizard
      key={epoch}
      {...props}
      onReset={() => {
        setEpoch((current) => current + 1);
      }}
    />
  );
}

function MunicipalImportWizard({
  labels,
  fieldLabels,
  sampleCsv,
  onReset,
}: {
  labels: Labels;
  fieldLabels: Labels;
  sampleCsv: string;
  onReset: () => void;
}) {
  const [parseState, parse] = useActionState(parseCsvAction, EMPTY);
  const [previewState, preview] = useActionState(previewCsvAction, EMPTY);
  const [commitState, commit] = useActionState(commitCsvAction, EMPTY);

  // The furthest-along state drives the screen. Each action returns the whole
  // state, so the last one submitted is the truth.
  const state = pickState(parseState, previewState, commitState);

  return (
    <div className="space-y-6">
      {state.error && (
        <p
          role="alert"
          className="rounded-md border border-danger-border bg-danger-bg p-2 text-body-sm text-danger"
        >
          {L(labels, `error_${state.error}`)}
        </p>
      )}

      {state.step === 'input' && (
        <form action={parse} className="space-y-3">
          <label className="block space-y-1">
            <span className="text-body-sm font-medium">{L(labels, 'registryLabel')}</span>
            <input
              name="registryLabel"
              defaultValue={state.registryLabel ?? ''}
              required
              maxLength={120}
              placeholder={L(labels, 'registryPlaceholder')}
              className="w-full rounded-md border border-line-strong bg-surface px-2 py-1 text-body-sm"
            />
            <span className="block text-caption text-text-muted">{L(labels, 'registryHint')}</span>
          </label>
          <label className="block space-y-1">
            <span className="text-body-sm font-medium">{L(labels, 'upload')}</span>
            <input type="file" name="file" accept=".csv,text/csv" className="block text-body-sm" />
          </label>
          <label className="block space-y-1">
            <span className="text-body-sm font-medium">{L(labels, 'paste')}</span>
            <textarea
              name="csv"
              defaultValue={state.csv ?? ''}
              rows={6}
              className="w-full rounded-md border border-line-strong bg-surface p-2 font-mono text-caption"
              placeholder={sampleCsv}
            />
          </label>
          <details className="text-caption text-ink-soft">
            <summary className="cursor-pointer">{L(labels, 'templateHint')}</summary>
            <pre className="mt-2 overflow-x-auto rounded-md bg-paper-sunk p-2">{sampleCsv}</pre>
          </details>
          <button
            type="submit"
            className="min-h-11 rounded-pill bg-brand px-4 py-1.5 text-body-sm font-semibold text-on-brand shadow-xs focus-visible:shadow-[var(--ring)] hover:bg-brand-hover"
          >
            {L(labels, 'next')}
          </button>
        </form>
      )}

      {state.step === 'map' && state.headers && (
        <form action={preview} className="space-y-4">
          <input type="hidden" name="csv" value={state.csv ?? ''} />
          <input type="hidden" name="registryLabel" value={state.registryLabel ?? ''} />
          <p className="text-body-sm text-ink-soft">{L(labels, 'mapHint')}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {MUNICIPAL_FIELDS.map((field) => (
              <label key={field} className="flex items-center justify-between gap-2 text-body-sm">
                <span className="font-medium">{L(fieldLabels, field)}</span>
                <select
                  name={`map.${field}`}
                  defaultValue={state.mapping?.[field] ?? ''}
                  className="rounded-md border border-line-strong bg-surface px-2 py-1 text-body-sm"
                >
                  <option value="">{L(labels, 'ignoreColumn')}</option>
                  {state.headers?.map((header, index) => (
                    <option key={index} value={index}>
                      {header || `#${String(index + 1)}`}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          {state.sampleRows && state.sampleRows.length > 0 && (
            <div className="overflow-x-auto rounded-card border border-line bg-surface">
              <table className="w-full text-caption">
                <thead className="bg-paper-sunk">
                  <tr>
                    {state.headers.map((header, index) => (
                      <th key={index} className="t-overline px-2 py-1.5 text-left font-semibold">
                        {header || `#${String(index + 1)}`}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {state.sampleRows.map((sample, r) => (
                    <tr key={r} className="border-t border-line">
                      {sample.map((cell, c) => (
                        <td key={c} className="px-2 py-1">
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
            className="min-h-11 rounded-pill bg-brand px-4 py-1.5 text-body-sm font-semibold text-on-brand shadow-xs focus-visible:shadow-[var(--ring)] hover:bg-brand-hover"
          >
            {L(labels, 'preview')}
          </button>
        </form>
      )}

      {state.step === 'preview' && state.rows && state.counts && (
        <form action={commit} className="space-y-4">
          <input type="hidden" name="csv" value={state.csv ?? ''} />
          <input type="hidden" name="registryLabel" value={state.registryLabel ?? ''} />
          {Object.entries(state.mapping ?? {}).map(([field, index]) => (
            <input key={field} type="hidden" name={`map.${field}`} value={String(index)} />
          ))}

          <div className="flex flex-wrap gap-3 text-body-sm">
            <Badge label={L(labels, 'countNew')} value={state.counts.new} tone="green" />
            <Badge label={L(labels, 'countMatch')} value={state.counts.match} tone="blue" />
            <Badge label={L(labels, 'countConflict')} value={state.counts.conflict} tone="amber" />
            <Badge label={L(labels, 'countInvalid')} value={state.counts.invalid} tone="red" />
          </div>
          <p className="text-body-sm text-ink-soft">{L(labels, 'previewHint')}</p>

          <div className="overflow-x-auto rounded-card border border-line bg-surface">
            <table className="w-full text-body-sm">
              <thead className="bg-paper-sunk">
                <tr>
                  <th className="t-overline px-2 py-1 text-left">{L(labels, 'rowNumber')}</th>
                  <th className="t-overline px-2 py-1 text-left">{L(labels, 'name')}</th>
                  <th className="t-overline px-2 py-1 text-left">{L(labels, 'status')}</th>
                  <th className="t-overline px-2 py-1 text-left">{L(labels, 'resolution')}</th>
                </tr>
              </thead>
              <tbody>
                {state.rows.map((row) => (
                  <tr key={row.rowNumber} className="border-t border-line align-top">
                    <td className="px-2 py-1 tabular-nums">{row.rowNumber}</td>
                    <td className="px-2 py-1">{row.name ?? '—'}</td>
                    <td className="px-2 py-1">
                      <span className="font-medium">{L(labels, `status_${row.status}`)}</span>
                      {row.status === 'invalid' && row.error && (
                        <span className="block text-caption text-danger">
                          {L(labels, `rowError_${row.error}`)}
                        </span>
                      )}
                      {row.status === 'conflict' && (
                        <span className="block text-caption text-warning">
                          {L(labels, `conflict_${row.conflictReason ?? 'ambiguous'}`)}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1">
                      {row.status === 'conflict' && row.candidates ? (
                        <select
                          name={`resolve.${row.rowNumber}`}
                          defaultValue="skip"
                          className="rounded-md border border-line-strong bg-surface px-2 py-1 text-caption"
                        >
                          <option value="skip">{L(labels, 'resolveSkip')}</option>
                          <option value="new">{L(labels, 'resolveNew')}</option>
                          {row.candidates.map((candidate) => (
                            <option
                              key={candidate.facilityId}
                              value={`link:${candidate.facilityId}`}
                            >
                              {L(labels, 'resolveLink')}: {candidate.name ?? candidate.slug ?? '—'}{' '}
                              ({candidate.distanceM} m)
                            </option>
                          ))}
                        </select>
                      ) : row.status === 'invalid' ? (
                        <span className="text-caption text-text-muted">
                          {L(labels, 'willSkip')}
                        </span>
                      ) : (
                        <span className="text-caption text-text-muted">
                          {L(labels, 'willCommit')}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button
            type="submit"
            className="min-h-11 rounded-pill bg-brand px-4 py-1.5 text-body-sm font-semibold text-on-brand shadow-xs focus-visible:shadow-[var(--ring)] hover:bg-brand-hover"
          >
            {L(labels, 'confirmImport')}
          </button>
        </form>
      )}

      {state.step === 'done' && state.committed && (
        <div className="space-y-2 rounded-card border border-success-border bg-success-bg p-4 text-body-sm">
          <p className="font-medium">{L(labels, 'doneTitle')}</p>
          <ul className="space-y-0.5">
            <li>
              {L(labels, 'doneInserted')}: {state.committed.inserted}
            </li>
            <li>
              {L(labels, 'doneUpdated')}: {state.committed.updated}
            </li>
            <li>
              {L(labels, 'doneUnchanged')}: {state.committed.unchanged}
            </li>
            <li>
              {L(labels, 'doneSkipped')}: {state.committed.skipped + state.committed.invalid}
            </li>
          </ul>
          <button
            type="button"
            onClick={onReset}
            className="inline-block cursor-pointer font-medium text-link hover:text-link-hover"
          >
            {L(labels, 'importAnother')}
          </button>
        </div>
      )}
    </div>
  );
}

function Badge({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'green' | 'blue' | 'amber' | 'red';
}) {
  const tones = {
    green: 'bg-success-bg text-success',
    blue: 'bg-info-bg text-info',
    amber: 'bg-warning-bg text-warning',
    red: 'bg-danger-bg text-danger',
  };
  return (
    <span className={`rounded px-2 py-1 ${tones[tone]}`}>
      {label}: <strong className="tabular-nums">{value}</strong>
    </span>
  );
}

/**
 * The furthest-along state wins; ties break toward the LATER action in
 * argument order (a commit that re-renders the preview step with an error must
 * beat the preview state it came from). An action that has never run is still
 * the initial EMPTY object — useActionState keeps that identity until the
 * first dispatch, and a server action's result is deserialized so it can never
 * BE that object — and must be skipped entirely: letting it tie meant a failed
 * parse ({step:'input', error}) was displaced by the untouched preview/commit
 * EMPTYs, so the error never rendered and React 19's post-action form reset
 * restored `defaultValue={state.csv ?? ''}` from the EMPTY state, silently
 * wiping the operator's pasted CSV (AUDIT-F4).
 */
function pickState(...states: MunicipalState[]): MunicipalState {
  const order: MunicipalState['step'][] = ['input', 'map', 'preview', 'done'];
  let best = EMPTY;
  for (const state of states) {
    if (state === EMPTY) continue;
    if (order.indexOf(state.step) >= order.indexOf(best.step)) best = state;
  }
  return best;
}
