'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';

import { Link } from '@/i18n/navigation';
import { submitReport, type ReportState } from '@/app/[locale]/obekt/[slug]/report-actions';

const ISSUES = [
  'broken_equipment',
  'no_lighting',
  'bad_surface',
  'does_not_exist',
  'other',
] as const;

const MAX_BODY = 500;
const initialState: ReportState = { status: 'idle' };

interface ReportFormProps {
  slug: string;
  /** HMAC-signed, server-issued token for the min-time-on-form anti-spam check. */
  formToken: string;
}

export function ReportForm({ slug, formToken }: ReportFormProps) {
  const t = useTranslations('Report');
  const [open, setOpen] = useState(false);
  const [bodyLen, setBodyLen] = useState(0);
  const [state, formAction, pending] = useActionState(submitReport, initialState);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
        className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50"
      >
        {t('open')}
      </button>
    );
  }

  if (state.status === 'ok') {
    return (
      <p role="status" className="rounded-md bg-green-50 px-4 py-3 text-sm text-green-800">
        {t('success')}
      </p>
    );
  }

  return (
    <form action={formAction} className="space-y-4 text-sm">
      <h2 className="text-lg font-semibold">{t('title')}</h2>

      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="ts" value={formToken} />
      {/* Honeypot: off-screen, hidden from AT + tab order. Bots fill it. */}
      <div aria-hidden="true" className="absolute left-[-9999px] h-0 w-0 overflow-hidden">
        <label>
          Website
          <input type="text" name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>

      <fieldset className="space-y-1">
        <legend className="font-medium">{t('issueLabel')}</legend>
        <div className="space-y-1">
          {ISSUES.map((issue, i) => (
            <label key={issue} className="flex items-center gap-2">
              <input type="radio" name="issue" value={issue} defaultChecked={i === 0} required />
              {t(`issue.${issue}`)}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="block space-y-1">
        <span className="font-medium">{t('bodyLabel')}</span>
        <textarea
          name="body"
          maxLength={MAX_BODY}
          rows={3}
          placeholder={t('bodyPlaceholder')}
          onChange={(e) => {
            setBodyLen(e.target.value.length);
          }}
          className="w-full rounded border border-neutral-300 px-3 py-2"
        />
        <span className="text-xs text-neutral-500">
          {t('charCount', { n: bodyLen, max: MAX_BODY })}
        </span>
      </label>

      <label className="block space-y-1">
        <span className="font-medium">{t('photoLabel')}</span>
        <input
          type="file"
          name="photo"
          accept="image/jpeg,image/png,image/webp"
          className="block text-sm"
        />
        <span className="block text-xs font-medium text-amber-700">{t('photoHint')}</span>
      </label>

      {state.status === 'error' && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
          {t(`error.${state.error ?? 'invalid'}`)}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-neutral-900 px-5 py-2 font-medium text-white disabled:opacity-50"
        >
          {pending ? t('submitting') : t('submit')}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
          }}
          className="text-neutral-600 underline"
        >
          {t('cancel')}
        </button>
      </div>

      <p className="text-xs text-neutral-500">
        {t('privacyNote')}{' '}
        <Link href="/privacy" className="underline">
          {t('privacyLink')}
        </Link>
      </p>
    </form>
  );
}
