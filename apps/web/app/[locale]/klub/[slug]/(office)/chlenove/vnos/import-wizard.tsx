'use client';

import { useState } from 'react';

import { useLabels, type Labels } from '@/components/admin/use-labels';
import { useFormAction } from '@/lib/use-form-action';

// Subpath, never the barrel: the barrel re-exports the mailer (client-imports.test.ts).
import { CLUB_IMPORT_FIELDS } from '@sportkarta/lib/clubs';

import { clubImportAction, type ClubImportState } from './actions';

/**
 * The member import screens: upload or paste → map columns → preview (choose
 * what to do with each conflict) → done. A client component only because the
 * steps carry state between server actions; the server re-derives everything.
 * Copy arrives as raw ICU templates (useLabels).
 */

const EMPTY: ClubImportState = { step: 'input', error: null };

const SUBMIT =
  'min-h-11 rounded-pill bg-brand px-4 py-1.5 text-body-sm font-semibold text-on-brand shadow-xs focus-visible:shadow-[var(--ring)] hover:bg-brand-hover disabled:opacity-50';
const SECONDARY =
  'min-h-11 rounded-pill border border-line-strong bg-surface px-4 py-1.5 text-body-sm font-semibold text-ink hover:bg-surface-2 focus-visible:shadow-[var(--ring)]';
const FIELD = 'rounded-input border border-line-strong bg-surface px-2 py-1.5 text-body-sm';

export function ClubImportWizard(props: {
  slug: string;
  labels: Labels;
  fieldLabels: Labels;
  sampleCsv: string;
}) {
  // A fresh wizard is a remount: useActionState has no reset (the obshtini lesson).
  const [epoch, setEpoch] = useState(0);
  return <Wizard key={epoch} {...props} onReset={() => setEpoch((n) => n + 1)} />;
}

function Wizard({
  slug,
  labels,
  fieldLabels,
  sampleCsv,
  onReset,
}: {
  slug: string;
  labels: Labels;
  fieldLabels: Labels;
  sampleCsv: string;
  onReset: () => void;
}) {
  const t = useLabels(labels);
  const [state, formProps, pending] = useFormAction(clubImportAction, EMPTY);
  const carry = (
    <>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="csv" value={state.csv ?? ''} />
    </>
  );
  const mappingFields = Object.entries(state.mapping ?? {}).map(([field, index]) => (
    <input key={field} type="hidden" name={`map.${field}`} value={String(index)} />
  ));

  return (
    <div className="space-y-5">
      <div role="status" aria-live="polite">
        {state.error && (
          <p className="rounded-card border border-danger-border bg-danger-bg p-3 text-body-sm text-ink">
            {t(`error_${state.error}`)}
          </p>
        )}
      </div>

      {state.step === 'input' && (
        <form {...formProps} className="space-y-3">
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="do" value="parse" />
          <label className="block space-y-1">
            <span className="text-body-sm font-semibold text-ink">{t('upload')}</span>
            <input type="file" name="file" accept=".csv,text/csv" className="block text-body-sm" />
          </label>
          <label className="block space-y-1">
            <span className="text-body-sm font-semibold text-ink">{t('paste')}</span>
            <textarea
              name="csv"
              defaultValue={state.csv ?? ''}
              rows={6}
              className={`w-full font-mono text-caption ${FIELD}`}
              placeholder={sampleCsv}
            />
          </label>
          <details className="text-caption text-ink-soft">
            <summary className="cursor-pointer">{t('templateHint')}</summary>
            <pre className="mt-2 overflow-x-auto rounded-card bg-paper-sunk p-2">{sampleCsv}</pre>
          </details>
          <button type="submit" disabled={pending} aria-busy={pending} className={SUBMIT}>
            {t('next')}
          </button>
        </form>
      )}

      {state.step === 'map' && state.headers && (
        <form {...formProps} className="space-y-4">
          {carry}
          <input type="hidden" name="do" value="preview" />
          <p className="text-body-sm text-ink-soft">{t('mapHint')}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {CLUB_IMPORT_FIELDS.map((field) => (
              <label
                key={field}
                className="flex items-center justify-between gap-2 text-body-sm text-ink"
              >
                <span className="font-medium">{fieldLabels[field] ?? field}</span>
                <select
                  name={`map.${field}`}
                  defaultValue={state.mapping?.[field] ?? ''}
                  className={FIELD}
                >
                  <option value="">{t('ignoreColumn')}</option>
                  {state.headers?.map((header, index) => (
                    <option key={index} value={index}>
                      {header || `#${String(index + 1)}`}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          {state.sample && state.sample.length > 0 && (
            <div className="overflow-x-auto rounded-card border border-line bg-surface">
              <table className="w-full text-caption">
                <thead className="bg-paper-sunk">
                  <tr>
                    {state.headers.map((header, index) => (
                      <th key={index} scope="col" className="px-2 py-1.5 text-left font-semibold">
                        {header || `#${String(index + 1)}`}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {state.sample.map((row, r) => (
                    <tr key={r} className="border-t border-line">
                      {row.map((cell, c) => (
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
          <button type="submit" disabled={pending} aria-busy={pending} className={SUBMIT}>
            {t('preview')}
          </button>
        </form>
      )}

      {state.step === 'preview' && state.rows && state.counts && (
        <form {...formProps} className="space-y-4">
          {carry}
          {mappingFields}
          <ul className="flex flex-wrap gap-2 text-body-sm">
            {(['new', 'match', 'conflict', 'invalid'] as const).map((kind) => (
              <li key={kind} className="rounded-pill border border-line bg-surface px-3 py-1">
                {t(`count_${kind}`, { count: state.counts?.[kind] ?? 0 })}
              </li>
            ))}
          </ul>
          <p className="text-body-sm text-ink-soft">{t('previewHint')}</p>
          <div className="overflow-x-auto rounded-card border border-line bg-surface">
            <table className="w-full text-body-sm">
              <thead className="bg-paper-sunk">
                <tr>
                  <th scope="col" className="px-2 py-1.5 text-left">
                    {t('line')}
                  </th>
                  <th scope="col" className="px-2 py-1.5 text-left">
                    {t('name')}
                  </th>
                  <th scope="col" className="px-2 py-1.5 text-left">
                    {t('status')}
                  </th>
                  <th scope="col" className="px-2 py-1.5 text-left">
                    {t('plan')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {state.rows.map((row) => (
                  <tr key={row.line} className="border-t border-line align-top">
                    <td className="px-2 py-1.5 tabular-nums">{row.line}</td>
                    <td className="px-2 py-1.5">{row.status === 'invalid' ? '—' : row.name}</td>
                    <td className="px-2 py-1.5">
                      <span className="font-medium">{t(`status_${row.status}`)}</span>
                      {row.status === 'invalid' &&
                        row.errors.map((code) => (
                          <span key={code} className="block text-caption text-danger">
                            {t(`rowError_${code}`)}
                          </span>
                        ))}
                      {row.status === 'conflict' && (
                        <>
                          <span className="block text-caption text-ink-soft">
                            {t(`conflict_${row.reason ?? 'several_records'}`)}
                          </span>
                          <label className="mt-1 flex min-h-11 items-center gap-2 text-caption text-ink">
                            <input
                              type="checkbox"
                              name="asNew"
                              value={row.line}
                              className="size-4 accent-[var(--brand)]"
                            />
                            {t('createAnyway')}
                          </label>
                        </>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-caption">
                      {row.status !== 'invalid' && row.plan
                        ? row.planUnknown
                          ? t('planUnknown', { plan: row.plan })
                          : row.plan
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              name="do"
              value="commit"
              disabled={pending}
              aria-busy={pending}
              className={SUBMIT}
            >
              {t('commit')}
            </button>
            <button
              type="submit"
              name="do"
              value="map"
              formNoValidate
              disabled={pending}
              className={SECONDARY}
            >
              {t('backToMapping')}
            </button>
          </div>
        </form>
      )}

      {state.step === 'done' && state.result && (
        <section className="space-y-3 rounded-card border border-success-border bg-success-bg p-4">
          <h2 className="text-h4 font-bold text-ink">{t('doneTitle')}</h2>
          <ul className="text-body-sm text-ink">
            <li>{t('doneCreated', { count: state.result.created })}</li>
            <li>{t('doneUpdated', { count: state.result.updated })}</li>
            <li>{t('doneMemberships', { count: state.result.memberships })}</li>
            <li>{t('doneSkipped', { count: state.result.skipped + state.result.invalid })}</li>
          </ul>
          <button type="button" onClick={onReset} className={SECONDARY}>
            {t('importAnother')}
          </button>
        </section>
      )}
    </div>
  );
}
