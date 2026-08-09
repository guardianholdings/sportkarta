'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Radio } from '@/components/ui/radio';
import { Textarea } from '@/components/ui/textarea';
import { Link } from '@/i18n/navigation';
import { submitReport, type ReportState } from '@/app/[locale]/obekt/[slug]/report-actions';
import { PositionFields, PositionNotice, usePosition } from '@/components/facility/position-fields';

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
  const tContribute = useTranslations('Contribute');
  const { phase, latRef, lonRef, request } = usePosition();
  const [open, setOpen] = useState(false);
  const [bodyLen, setBodyLen] = useState(0);
  const [state, formAction, pending] = useActionState(submitReport, initialState);

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        {t('open')}
      </Button>
    );
  }

  if (state.status === 'ok') {
    return (
      <p role="status" className="rounded-md bg-success-bg px-4 py-3 text-body-sm text-success">
        {t('success')}
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <PositionFields latRef={latRef} lonRef={lonRef} />
      <PositionNotice
        phase={phase}
        labels={{
          locating: tContribute('locating'),
          granted: tContribute('locationGranted'),
          denied: tContribute('locationDenied'),
          insecure: tContribute('locationInsecure'),
          retry: tContribute('locationRetry'),
        }}
        onRequest={request}
      />
      <h2 className="text-h4 font-bold text-ink">{t('title')}</h2>

      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="ts" value={formToken} />
      {/* Honeypot: off-screen, hidden from AT + tab order. Bots fill it. */}
      <div aria-hidden="true" className="absolute left-[-9999px] h-0 w-0 overflow-hidden">
        <label>
          Website
          <input type="text" name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-mono text-overline uppercase tracking-overline text-text-muted">
          {t('issueLabel')}
        </legend>
        {ISSUES.map((issue, i) => (
          <Radio
            key={issue}
            name="issue"
            value={issue}
            label={t(`issue.${issue}`)}
            defaultChecked={i === 0}
            required
          />
        ))}
      </fieldset>

      <label className="flex flex-col gap-1.5">
        <span className="font-mono text-overline uppercase tracking-overline text-text-muted">
          {t('bodyLabel')}
        </span>
        <Textarea
          name="body"
          maxLength={MAX_BODY}
          rows={3}
          placeholder={t('bodyPlaceholder')}
          onChange={(e) => setBodyLen(e.target.value.length)}
        />
        <span className="font-mono text-caption text-text-muted">
          {t('charCount', { n: bodyLen, max: MAX_BODY })}
        </span>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="font-mono text-overline uppercase tracking-overline text-text-muted">
          {t('photoLabel')}
        </span>
        <input
          type="file"
          name="photo"
          accept="image/jpeg,image/png,image/webp"
          className="w-full rounded-input border border-line-strong bg-surface px-3 py-2 text-body-sm file:mr-3 file:rounded-pill file:border-0 file:bg-brand-subtle file:px-3 file:py-1 file:text-brand"
        />
        <span className="text-caption font-medium text-warning">{t('photoHint')}</span>
      </label>

      {state.status === 'error' && (
        <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-body-sm text-danger">
          {t(`error.${state.error ?? 'invalid'}`)}
        </p>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? t('submitting') : t('submit')}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          {t('cancel')}
        </Button>
      </div>

      <p className="text-caption text-text-muted">
        {t('privacyNote')}{' '}
        <Link href="/privacy" className="font-medium text-brand hover:text-brand-hover">
          {t('privacyLink')}
        </Link>
      </p>
    </form>
  );
}
