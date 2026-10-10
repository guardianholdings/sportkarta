'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { useFormAction } from '@/lib/use-form-action';

import { Button } from '@/components/ui/button';
import { Radio } from '@/components/ui/radio';
import { Textarea } from '@/components/ui/textarea';
import { Link } from '@/i18n/navigation';
import { submitReport, type ReportState } from '@/app/[locale]/obekt/[slug]/report-actions';
import { PhotoFieldStatus, usePhotoField } from '@/components/facility/photo-field';
import { PositionFields, PositionNotice, usePosition } from '@/components/facility/position-fields';
import { PHOTO_ACCEPT } from '@/lib/photo-downscale';

const ISSUES = [
  'broken_equipment',
  'no_lighting',
  'bad_surface',
  'does_not_exist',
  'other',
] as const;

const MAX_BODY = 500;
const initialState: ReportState = { status: 'idle' };

/**
 * The server hands out a replacement token only alongside `error: 'expired'`;
 * every later answer (a rate limit, a bad photo) comes without one. Carrying
 * the last one forward keeps the form on the fresh token instead of falling
 * back to the page's dead one and going round the expiry once more. Exported
 * for the tests.
 */
export async function submitKeepingToken(
  previous: ReportState,
  formData: FormData,
): Promise<ReportState> {
  const next = await submitReport(previous, formData);
  return next.formToken || !previous.formToken ? next : { ...next, formToken: previous.formToken };
}

interface ReportFormProps {
  slug: string;
  /** HMAC-signed, server-issued token for the min-time-on-form anti-spam check. */
  formToken: string;
}

/**
 * The anonymous «report a problem» flow. Collapsed to one button until tapped.
 *
 * THE COLLAPSED STATE MOUNTS NOTHING THAT TOUCHES LOCATION. This component sits
 * on every facility page for every visitor, so anything its first render does,
 * every search visitor gets. The position hook lives in the body below, which
 * exists only after the «Съобщи проблем» tap — and that tap is what asks.
 */
export function ReportForm({ slug, formToken }: ReportFormProps) {
  const t = useTranslations('Report');
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        {t('open')}
      </Button>
    );
  }

  return <ReportFormBody slug={slug} formToken={formToken} onCancel={() => setOpen(false)} />;
}

function ReportFormBody({
  slug,
  formToken,
  onCancel,
}: ReportFormProps & {
  onCancel: () => void;
}) {
  const t = useTranslations('Report');
  // Mounted by the open tap, so asking on mount IS asking from that tap: the
  // visitor has just said they want to report something about this place. And
  // literally so — React flushes the effects of a render caused by a click
  // synchronously, inside that click's dispatch, so the browser still sees
  // the call as the tap's. The button in PositionNotice stays as the fallback.
  const { phase, latRef, lonRef, request } = usePosition({ askOnMount: true });
  const photo = usePhotoField();
  const [bodyLen, setBodyLen] = useState(0);
  // An error (a stale token, a bad photo) keeps what the visitor wrote and the
  // photo they took; on success the form is replaced by the thanks line.
  const [state, formProps, pending] = useFormAction(submitKeepingToken, initialState);
  // A fresh token once the page's own has gone stale, so "send again" can
  // actually succeed instead of failing the same way forever (report-actions.ts).
  const token = state.formToken ?? formToken;

  if (state.status === 'ok') {
    return (
      <p role="status" className="rounded-md bg-success-bg px-4 py-3 text-body-sm text-success">
        {t('success')}
      </p>
    );
  }

  return (
    <form {...formProps} className="flex flex-col gap-4">
      <PositionFields latRef={latRef} lonRef={lonRef} />
      <h2 className="text-h4 font-bold text-ink">{t('title')}</h2>
      <PositionNotice
        phase={phase}
        labels={{
          idle: t('location.idle'),
          locating: t('location.locating'),
          granted: t('location.granted'),
          denied: t('location.denied'),
          unavailable: t('location.unavailable'),
          unsupported: t('location.unsupported'),
          insecure: t('location.insecure'),
          request: t('location.request'),
        }}
        onRequest={request}
      />

      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="ts" value={token} />
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
          accept={PHOTO_ACCEPT}
          onChange={photo.onChange}
          className="w-full rounded-input border border-line-strong bg-surface px-3 py-2 text-body-sm file:mr-3 file:rounded-pill file:border-0 file:bg-brand-subtle file:px-3 file:py-1 file:text-brand"
        />
        <span className="text-caption font-medium text-warning">{t('photoHint')}</span>
        <PhotoFieldStatus status={photo.status} />
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
        <Button type="button" variant="ghost" onClick={onCancel}>
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
