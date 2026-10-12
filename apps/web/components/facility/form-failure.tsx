'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import type { ActionFailure } from '@/lib/form-action-failure';

/**
 * What a contribution form says when its call got no usable answer (B2,
 * lib/form-action-failure.ts), in place of the error page it used to end on.
 *
 * - `no_answer`: the form's own line (`noAnswer`). The action may have run, and
 *   sending again is safe: the add action refuses a second copy of the same
 *   facility, and a contribution doesn't count its points twice.
 * - `stale_form`: the site was deployed while the form was open. Nothing ran,
 *   and only a reload brings the new action ids, so the line comes with a
 *   reload button.
 */
export function FormFailure({
  failure,
  noAnswer,
}: {
  failure: ActionFailure | null;
  noAnswer: string;
}) {
  const t = useTranslations('FormRecovery');
  if (failure === 'no_answer') {
    return (
      <p role="alert" className="text-body-sm text-danger">
        {noAnswer}
      </p>
    );
  }
  if (failure === 'stale_form') {
    return (
      <div role="alert" className="flex flex-col items-start gap-2">
        <p className="text-body-sm text-danger">{t('staleForm')}</p>
        <Button type="button" variant="secondary" onClick={() => window.location.reload()}>
          {t('reload')}
        </Button>
      </div>
    );
  }
  return null;
}
