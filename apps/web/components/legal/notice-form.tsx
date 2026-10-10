'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { submitNotice, type NoticeState } from '@/app/[locale]/signal/actions';
import { useFormAction } from '@/lib/use-form-action';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Radio } from '@/components/ui/radio';
import { Textarea } from '@/components/ui/textarea';
import { Link } from '@/i18n/navigation';
import {
  MAX_NOTICE_EMAIL,
  MAX_NOTICE_EXPLANATION,
  MAX_NOTICE_NAME,
  MAX_NOTICE_URL,
  NOTICE_CATEGORIES,
} from '@/lib/notice-input';

const initialState: NoticeState = { status: 'idle' };

/**
 * The server hands out a replacement token only alongside `expired`; carrying
 * it forward keeps a later answer (a rate limit, a bad address) from sending
 * the form back to the page's dead token — the report form's rule
 * (components/facility/report-form.tsx).
 */
async function submitKeepingToken(previous: NoticeState, formData: FormData): Promise<NoticeState> {
  const next = await submitNotice(previous, formData);
  return next.formToken || !previous.formToken ? next : { ...next, formToken: previous.formToken };
}

const LABEL = 'font-mono text-overline uppercase tracking-overline text-text-muted';

interface NoticeFormProps {
  /** A same-site path handed over by a "report this" link, or ''. */
  defaultUrl: string;
  /** HMAC-signed, server-issued token for the min-time-on-form anti-spam check. */
  formToken: string;
  /** How long a notifier's contact is kept after the decision (printed, not enforced, here). */
  retentionDays: number;
}

/**
 * The notice form (DSA Art. 16). Every field the article lists and nothing
 * more: where, why, optionally who, and the good-faith statement. The server
 * action re-validates all of it (lib/notice-input.ts) and 0034's CHECKs repeat
 * the bounds, so the attributes here are a courtesy, not the guard.
 */
export function NoticeForm({ defaultUrl, formToken, retentionDays }: NoticeFormProps) {
  const t = useTranslations('Notice');
  const [explanationLen, setExplanationLen] = useState(0);
  // An error keeps the explanation (up to 2,000 characters) and everything else
  // the notifier wrote — React used to reset the form on every answer.
  const [state, formProps, pending] = useFormAction(submitKeepingToken, initialState);
  const token = state.formToken ?? formToken;

  if (state.status === 'ok') {
    return (
      <p role="status" className="rounded-md bg-success-bg px-4 py-3 text-body-sm text-success">
        {t('success')}
      </p>
    );
  }

  return (
    <form {...formProps} className="flex flex-col gap-5">
      <input type="hidden" name="ts" value={token} />
      {/* Honeypot: off-screen, hidden from AT + tab order. Bots fill it. */}
      <div aria-hidden="true" className="absolute left-[-9999px] h-0 w-0 overflow-hidden">
        <label>
          Website
          <input type="text" name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className={LABEL}>{t('urlLabel')}</span>
        <Input
          name="url"
          type="text"
          inputMode="url"
          required
          maxLength={MAX_NOTICE_URL}
          defaultValue={defaultUrl}
          autoComplete="off"
          invalid={state.error === 'url'}
        />
        <span className="text-caption text-text-muted">{t('urlHint')}</span>
      </label>

      <fieldset className="flex flex-col gap-2">
        <legend className={`mb-1 ${LABEL}`}>{t('categoryLabel')}</legend>
        {NOTICE_CATEGORIES.map((category) => (
          <Radio
            key={category}
            name="category"
            value={category}
            label={t(`category.${category}`)}
            required
          />
        ))}
      </fieldset>

      <label className="flex flex-col gap-1.5">
        <span className={LABEL}>{t('explanationLabel')}</span>
        <Textarea
          name="explanation"
          required
          rows={5}
          maxLength={MAX_NOTICE_EXPLANATION}
          onChange={(e) => setExplanationLen(e.target.value.length)}
        />
        <span className="text-caption text-text-muted">{t('explanationHint')}</span>
        <span className="font-mono text-caption text-text-muted">
          {t('charCount', { n: explanationLen, max: MAX_NOTICE_EXPLANATION })}
        </span>
      </label>

      <fieldset className="flex flex-col gap-3">
        <legend className={`mb-1 ${LABEL}`}>{t('contactLegend')}</legend>
        <p className="text-caption text-text-muted">{t('contactHint', { days: retentionDays })}</p>
        <label className="flex flex-col gap-1.5">
          <span className="text-body-sm text-ink">{t('nameLabel')}</span>
          <Input
            name="name"
            type="text"
            maxLength={MAX_NOTICE_NAME}
            autoComplete="name"
            invalid={state.error === 'name'}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-body-sm text-ink">{t('emailLabel')}</span>
          <Input
            name="email"
            type="email"
            maxLength={MAX_NOTICE_EMAIL}
            autoComplete="email"
            invalid={state.error === 'email'}
          />
        </label>
      </fieldset>

      <Checkbox name="goodFaith" required className="items-start" label={t('goodFaith')} />

      {state.status === 'error' && (
        <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-body-sm text-danger">
          {t(`error.${state.error ?? 'unknown'}`)}
        </p>
      )}

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? t('submitting') : t('submit')}
        </Button>
      </div>

      <p className="text-caption text-text-muted">
        {t('privacyNote')}{' '}
        <Link href="/privacy" className="font-medium text-link hover:text-link-hover">
          {t('privacyLink')}
        </Link>
      </p>
    </form>
  );
}
