import { getTranslations } from 'next-intl/server';

import { setPassportVisibilityAction } from '@/app/[locale]/pasport/actions';
import { ANALYTICS_EVENTS } from '@/lib/analytics-events';
import type { OwnPassport } from '@/lib/passport';

/**
 * Passport visibility controls.
 *
 * Plain forms rather than a client component, matching the digest panel: three
 * buttons that must work before hydration. Each button posts the TARGET state
 * rather than "flip it", so a double tap settles instead of flapping — which
 * matters more here than for a digest, because the flapping value is whether a
 * page about somebody is publicly readable.
 *
 * Every member gets the same controls. A minors-only explanatory branch stood
 * here (the feature did not apply to them at all) until the operator decision
 * of 2026-07-25 — minors are treated as adults, so there is nothing left to
 * explain and no member for whom publishing is unavailable.
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

      <form action={setPassportVisibilityAction} className="flex flex-wrap items-center gap-3">
        <input type="hidden" name="isPublic" value={visibility.isPublic ? 'false' : 'true'} />
        <input
          type="hidden"
          name="showActivity"
          value={visibility.showActivity ? 'true' : 'false'}
        />
        <button
          type="submit"
          className={
            visibility.isPublic
              ? 'rounded border border-line-strong px-3 py-1.5 text-sm'
              : 'rounded-pill bg-brand px-3 py-1.5 text-body-sm font-semibold text-on-brand shadow-xs hover:bg-brand-hover'
          }
        >
          {visibility.isPublic ? t('makePrivate') : t('makePublic')}
        </button>
      </form>

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
        <form action={setPassportVisibilityAction} className="space-y-2">
          <input type="hidden" name="isPublic" value="true" />
          <input
            type="hidden"
            name="showActivity"
            value={visibility.showActivity ? 'false' : 'true'}
          />
          <p className="text-body-sm text-ink-soft">{t('activityExplainer')}</p>
          <button type="submit" className="rounded border border-line-strong px-3 py-1.5 text-body-sm">
            {visibility.showActivity ? t('hideActivity') : t('showActivity')}
          </button>
        </form>
      )}
    </section>
  );
}
