import { getDb } from '@sportkarta/db';
import { getTranslations } from 'next-intl/server';

import { ConfirmButton } from '@/components/ui/confirm-button';
import { AD_SLOTS, partnerPlacements } from '@/lib/ads';

import { createPlacementAction, deletePlacementAction, setPlacementVisibleAction } from './ad-actions';
import { PlacementForm, type PlacementFormLabels } from './placement-form';

/**
 * Ad placements for one partner (docs/MONETISATION.md M4), on the partner's own
 * admin screen — the plan's decision: an advertiser is a partner row, so their
 * slots belong on their page rather than in a separate section of the admin.
 *
 * The list shows the WINDOW and whether the placement is live, because those are
 * the two facts an operator gets wrong: publishing into a period somebody else
 * already bought (the database refuses — see ad-actions), and forgetting to take
 * a lapsed creative down. A placement whose window has passed is marked as such
 * rather than hidden: it still exists, and it is still occupying the operator's
 * attention until they delete it.
 */
export async function PlacementsPanel({
  partnerId,
  partnerSlug,
}: {
  partnerId: number;
  partnerSlug: string;
}) {
  const [t, placements] = await Promise.all([
    getTranslations('AdminPartners'),
    partnerPlacements(getDb(), partnerId),
  ]);

  const labels: PlacementFormLabels = {
    slot: t('adFieldSlot'),
    slots: Object.fromEntries(AD_SLOTS.map((slot) => [slot, t(`adSlot_${slot}`)])),
    creative: t('adFieldCreative'),
    creativeHint: t('adCreativeHint'),
    url: t('adFieldUrl'),
    altBg: t('adFieldAltBg'),
    altEn: t('adFieldAltEn'),
    altHint: t('adAltHint'),
    startsOn: t('fieldStartsOn'),
    endsOn: t('fieldEndsOn'),
    submit: t('adSubmit'),
    saved: t('saved'),
    errors: Object.fromEntries(
      (
        [
          'bad_partner',
          'bad_slot',
          'bad_url',
          'alt_required',
          'alt_too_long',
          'bad_date',
          'window_order',
          'slot_taken',
          'creative_required',
          'photo_too_large',
          'invalid_photo',
        ] as const
      ).map((code) => [code, t(`error_${code}`)]),
    ),
    genericError: t('error_generic'),
  };

  // Civil Sofia date, because the windows are civil dates: comparing against a
  // UTC "today" would call a placement lapsed for the last two hours of its
  // final day, which is a day the advertiser paid for.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Sofia' }).format(new Date());

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-h4 font-bold text-ink">{t('adsTitle')}</h2>
        <p className="text-body-sm text-text-muted">{t('adsIntro')}</p>
      </div>

      {placements.length === 0 ? (
        <p className="text-body-sm text-ink-soft">{t('adsEmpty')}</p>
      ) : (
        <ul className="space-y-2">
          {placements.map((placement) => {
            const lapsed = placement.endsOn < today;
            const upcoming = placement.startsOn > today;
            return (
              <li
                key={placement.id}
                className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface p-3 text-body-sm"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- our own
                    row-decides route; a 64px thumbnail needs no loader. Draft
                    creatives 404 here by design (the route repeats the
                    visibility predicate), which is why the alt text carries the
                    identifying information. */}
                <img
                  src={`/api/ads/creative/${String(placement.id)}`}
                  alt={placement.altBg}
                  width={64}
                  height={40}
                  className="h-10 w-16 shrink-0 rounded-md border border-line object-contain"
                />
                <span className="font-medium text-ink">{t(`adSlot_${placement.slot}`)}</span>
                <span className="tabular-nums text-text-muted">
                  {placement.startsOn} → {placement.endsOn}
                </span>
                <span className="text-caption text-text-muted">
                  {placement.visible
                    ? lapsed
                      ? t('adStateLapsed')
                      : upcoming
                        ? t('adStateScheduled')
                        : t('adStateLive')
                    : t('adStateDraft')}
                </span>
                <form
                  action={setPlacementVisibleAction.bind(
                    null,
                    partnerSlug,
                    placement.id,
                    !placement.visible,
                  )}
                  className="ml-auto"
                >
                  <button
                    type="submit"
                    className="rounded-md border border-line-strong px-3 py-1.5 text-body-sm"
                  >
                    {placement.visible ? t('adUnpublish') : t('adPublish')}
                  </button>
                </form>
                <form action={deletePlacementAction.bind(null, partnerSlug, placement.id)}>
                  <ConfirmButton
                    className="rounded-md border border-line-strong px-3 py-1.5 text-body-sm text-danger"
                    message={t('adDeleteConfirm')}
                  >
                    {t('adDelete')}
                  </ConfirmButton>
                </form>
              </li>
            );
          })}
        </ul>
      )}

      <details className="rounded-card border border-line bg-surface p-4">
        <summary className="cursor-pointer text-body-sm font-semibold text-ink">
          {t('adAddTitle')}
        </summary>
        <div className="pt-3">
          <PlacementForm
            action={createPlacementAction.bind(null, partnerSlug)}
            labels={labels}
            partnerId={partnerId}
            slots={AD_SLOTS}
          />
        </div>
      </details>
    </section>
  );
}
