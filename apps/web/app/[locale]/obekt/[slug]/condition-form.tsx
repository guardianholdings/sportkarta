'use client';

import { CANONICAL_CONDITION_TAGS, CONDITION_STATES } from '@sportkarta/lib/condition';
import { useTranslations } from 'next-intl';
import { useActionState } from 'react';

import { Button } from '@/components/ui/button';

import { reportConditionAction, type ContributionState } from './contribution-actions';

const INITIAL: ContributionState = { status: 'idle' };

/**
 * Condition report: one required state, optional tags, optional photo. Kept
 * deliberately short — this is the contribution someone makes standing on the
 * pitch with one hand free.
 */
export function ConditionForm({ slug }: { slug: string }) {
  const t = useTranslations('Contribute');
  const tState = useTranslations('Condition');
  const tTag = useTranslations('ConditionTag');
  const [state, action, pending] = useActionState<ContributionState, FormData>(
    reportConditionAction,
    INITIAL,
  );

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="slug" value={slug} />

      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">{t('stateLegend')}</legend>
        {CONDITION_STATES.map((value) => (
          <label key={value} className="mr-4 inline-flex items-center gap-2 text-sm">
            <input type="radio" name="state" value={value} required />
            {tState(value)}
          </label>
        ))}
      </fieldset>

      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">{t('tagsLegend')}</legend>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          {CANONICAL_CONDITION_TAGS.map((tag) => (
            <label key={tag} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="tags" value={tag} />
              {tTag(tag)}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="block space-y-1">
        <span className="text-sm font-medium">{t('photoOptionalLabel')}</span>
        <input
          type="file"
          name="photo"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          className="w-full rounded border border-neutral-300 px-3 py-2"
        />
        <span className="block text-xs text-neutral-500">{t('photoOptionalHint')}</span>
      </label>

      {state.status === 'error' && (
        <p role="alert" className="text-sm text-red-600">
          {t(`error_${state.error ?? 'unknown'}`)}
        </p>
      )}
      {state.status === 'ok' && (
        <p role="status" className="text-sm text-green-700">
          {state.awarded ? t('thanksWithPoints', { points: state.awarded }) : t('thanksNoPoints')}
        </p>
      )}

      <Button type="submit" disabled={pending}>
        {t('conditionSubmit')}
      </Button>
    </form>
  );
}
