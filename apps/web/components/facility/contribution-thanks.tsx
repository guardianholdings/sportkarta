'use client';

import { useTranslations } from 'next-intl';

import { type ContributionOutcome, thanksMessage } from '@/lib/contributions/feedback';

/**
 * The one status line after a verification or condition report — see
 * lib/contributions/feedback.ts for why it has four answers rather than two.
 *
 * A condition report sent from away adds one sentence, because what it does
 * NOT do is the part a member would otherwise assume: it is kept in the
 * facility's history, but only an on-site report repaints the map
 * (lib/contributions/condition-report.ts).
 */
export function ContributionThanks({
  state,
  kind,
}: {
  state: ContributionOutcome;
  kind: 'verify' | 'condition';
}) {
  const t = useTranslations('Contribute');
  const message = thanksMessage(state);
  const text =
    message.key === 'thanksWithPoints'
      ? t('thanksWithPoints', { points: message.points })
      : message.key === 'offSiteNotice'
        ? t('offSiteNotice', { km: message.km })
        : t(message.key);

  return (
    <p role="status" className="text-body-sm text-success">
      {text}
      {kind === 'condition' && state.onSite === false && ` ${t('conditionOffSiteNote')}`}
    </p>
  );
}
