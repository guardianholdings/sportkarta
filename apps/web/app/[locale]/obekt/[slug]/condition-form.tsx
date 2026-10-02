'use client';

import { CANONICAL_CONDITION_TAGS, CONDITION_STATES } from '@sportkarta/lib/condition';
import { useTranslations } from 'next-intl';
import { useActionState } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Radio } from '@/components/ui/radio';
import { ANALYTICS_EVENTS } from '@/lib/analytics-events';

import { reportConditionAction, type ContributionState } from './contribution-actions';
import { ContributionThanks } from '@/components/facility/contribution-thanks';
import { PhotoFieldStatus, usePhotoField } from '@/components/facility/photo-field';
import {
  PositionFields,
  PositionNotice,
  useContributeLocationLabels,
  usePosition,
} from '@/components/facility/position-fields';
import { PHOTO_ACCEPT } from '@/lib/photo-downscale';

const INITIAL: ContributionState = { status: 'idle' };

/**
 * Condition report: one required state, optional tags, optional photo. Kept
 * deliberately short — this is the contribution someone makes standing on the
 * pitch with one hand free.
 */
export function ConditionForm({ slug }: { slug: string }) {
  const t = useTranslations('Contribute');
  const { phase, latRef, lonRef, request } = usePosition();
  const locationLabels = useContributeLocationLabels();
  const photo = usePhotoField();
  const tState = useTranslations('Condition');
  const tTag = useTranslations('ConditionTag');
  const [state, action, pending] = useActionState<ContributionState, FormData>(
    reportConditionAction,
    INITIAL,
  );

  return (
    <form action={action} className="flex flex-col gap-5">
      <PositionFields latRef={latRef} lonRef={lonRef} />
      <PositionNotice phase={phase} labels={locationLabels} onRequest={request} />
      <input type="hidden" name="slug" value={slug} />

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-mono text-overline uppercase tracking-overline text-text-muted">
          {t('stateLegend')}
        </legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {CONDITION_STATES.map((value) => (
            <Radio key={value} name="state" value={value} label={tState(value)} required />
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-mono text-overline uppercase tracking-overline text-text-muted">
          {t('tagsLegend')}
        </legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {CANONICAL_CONDITION_TAGS.map((tag) => (
            <Checkbox key={tag} name="tags" value={tag} label={tTag(tag)} />
          ))}
        </div>
      </fieldset>

      <label className="flex flex-col gap-1.5">
        <span className="font-mono text-overline uppercase tracking-overline text-text-muted">
          {t('photoOptionalLabel')}
        </span>
        <input
          type="file"
          name="photo"
          accept={PHOTO_ACCEPT}
          onChange={photo.onChange}
          className="w-full rounded-input border border-line-strong bg-surface px-3 py-2 text-body-sm file:mr-3 file:rounded-pill file:border-0 file:bg-brand-subtle file:px-3 file:py-1 file:text-brand"
        />
        <span className="text-caption text-text-muted">{t('photoOptionalHint')}</span>
        <PhotoFieldStatus status={photo.status} />
      </label>

      {state.status === 'error' && (
        <p role="alert" className="text-body-sm text-danger">
          {t(`error_${state.error ?? 'unknown'}`)}
        </p>
      )}
      {state.status === 'ok' && <ContributionThanks state={state} kind="condition" />}

      <Button
        type="submit"
        disabled={pending}
        data-umami-event={ANALYTICS_EVENTS.contributionConditionSubmit}
      >
        {t('conditionSubmit')}
      </Button>
    </form>
  );
}
