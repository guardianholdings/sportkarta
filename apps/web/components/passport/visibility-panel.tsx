import { getTranslations } from 'next-intl/server';

import { VisibilityForm } from '@/components/passport/visibility-form';
import { ANALYTICS_EVENTS } from '@/lib/analytics-events';
import type { OwnPassport } from '@/lib/passport';

/**
 * Passport visibility controls.
 *
 * Each button posts the TARGET state rather than "flip it", so a double tap
 * settles instead of flapping — which matters more here than for a digest,
 * because the flapping value is whether a page about somebody is publicly
 * readable. The buttons are small client forms (VisibilityForm) only so a
 * refusal can be said beside them; they still post before hydration.
 *
 * Every member gets the same controls. A minors-only explanatory branch stood
 * here (the feature did not apply to them at all) until the operator decision
 * of 2026-07-25 — minors are treated as adults, so there is nothing left to
 * explain and no member for whom publishing is unavailable.
 *
 * ONE PRECONDITION: a name. A member who signed up with an email code has none,
 * and a passport published without one was an empty heading and an empty link
 * on every board (S-1). They are told so, and sent to the profile, instead of
 * being offered a button the server refuses.
 */
export async function VisibilityPanel({
  visibility,
  publicUrl,
}: {
  visibility: OwnPassport['visibility'];
  publicUrl: string | null;
}) {
  const t = await getTranslations('Passport');

  return (
    <section className="space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm">
      <h2 className="text-h4 font-bold text-ink">{t('visibilityTitle')}</h2>
      <p className="text-body-sm text-ink-soft">
        {visibility.isPublic ? t('visibilityPublicExplainer') : t('visibilityPrivateExplainer')}
      </p>

      <VisibilityForm
        isPublic={!visibility.isPublic}
        showActivity={visibility.showActivity}
        label={visibility.isPublic ? t('makePrivate') : t('makePublic')}
        variant={visibility.isPublic ? 'secondary' : 'primary'}
        nameHelp={{
          required: !visibility.isPublic && !visibility.hasName,
          text: t('publishNeedsName'),
          link: t('publishNeedsNameLink'),
        }}
      />

      {visibility.isPublic && publicUrl && (
        <p className="break-all text-body-sm">
          {/* C1: the only share-shaped affordance that exists today. This is
              THE number that decides whether the passport share card (C4) is
              worth building — it measures the desire path before anything paves
              it (docs/ENGAGEMENT.md §0). */}
          <a
            href={publicUrl}
            className="font-medium text-link hover:text-link-hover"
            data-umami-event={ANALYTICS_EVENTS.passportPublicLink}
          >
            {publicUrl}
          </a>
        </p>
      )}

      {visibility.isPublic && (
        <div className="space-y-2">
          <p className="text-body-sm text-ink-soft">{t('activityExplainer')}</p>
          <VisibilityForm
            isPublic
            showActivity={!visibility.showActivity}
            label={visibility.showActivity ? t('hideActivity') : t('showActivity')}
            variant="secondary"
          />
        </div>
      )}
    </section>
  );
}
