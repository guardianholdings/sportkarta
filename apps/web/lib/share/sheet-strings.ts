import type { ShareKind } from '@sportkarta/lib/share';
import { getTranslations } from 'next-intl/server';

import type { ShareSheetStrings } from '@/components/share/share-sheet';

/**
 * The share sheet's copy, resolved on the SERVER.
 *
 * Every string the sheet renders arrives as a prop rather than being looked up
 * in the browser. Two reasons, and the second is the load-bearing one:
 *
 *  1. `ShareSheet` is a client component, and a client component must import
 *     `@sportkarta/lib/<subpath>` and never the barrel — the barrel re-exports
 *     the mailer, which drags nodemailer and `node:fs` into the browser bundle
 *     (`tests/client-imports.test.ts` fails the build on it). Keeping the
 *     translation lookup here keeps that surface small.
 *  2. The trigger label is PER-MOMENT. "Сподели тренировката" and "Покани
 *     приятели" are different invitations, and a single "Share" on nine surfaces
 *     is how a share button becomes furniture nobody presses.
 */

const TRIGGER_KEY: Record<ShareKind, string> = {
  training: 'triggerTraining',
  week: 'triggerWeek',
  badge: 'triggerPassport',
  passport: 'triggerPassport',
  division: 'triggerDivision',
  legend: 'triggerLegend',
  facility: 'triggerFacility',
  session: 'triggerSession',
  campaign: 'triggerCampaign',
};

export async function shareSheetStrings(kind: ShareKind): Promise<ShareSheetStrings> {
  const t = await getTranslations('ShareSheet');
  return {
    trigger: t(TRIGGER_KEY[kind]),
    panelTitle: t('panelTitle'),
    copyLink: t('copyLink'),
    copyText: t('copyText'),
    copied: t('copied'),
    downloadStory: t('downloadStory'),
    storyHint: t('storyHint'),
    facebookNote: t('facebookNote'),
    networks: {
      viber: t('networks.viber'),
      facebook: t('networks.facebook'),
      telegram: t('networks.telegram'),
      whatsapp: t('networks.whatsapp'),
      x: t('networks.x'),
    },
  };
}
