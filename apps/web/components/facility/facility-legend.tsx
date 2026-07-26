import { facilityLegend, getDb } from '@sportkarta/db';
import { Crown } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

/**
 * «Господар на игрището» on the facility page (B1).
 *
 * NAMES NOBODY, by operator decision of 2026-07-26. `/obekt/[slug]` is indexed —
 * ~6,600 of them are in the sitemap and it cannot be noindex, because it IS the
 * SEO product. A name here would publish a named person tied to one place with a
 * 90-day frequency count: a pattern-of-life disclosure on the one page where the
 * usual escape hatch is unavailable, and the opposite of the call `/pasport`
 * made when it chose noindex.
 *
 * So this states a fact about the PLACE — "the most regular person here has come
 * 12 days" — which is also an invitation, and an identity attached to a pitch
 * rather than to a person. The one exception is telling the HOLDER that it is
 * theirs, which is not disclosure: it is telling someone about themselves.
 *
 * Renders NOTHING when nobody qualifies, and nothing on a query failure — the
 * same discipline as AdSlot. A broken decoration must never break a facility
 * page, and ~6,600 facilities showing "be the first!" would make the feature
 * look like a failure everywhere at once.
 */
export async function FacilityLegendBlock({
  facilityId,
  viewerId,
}: {
  facilityId: string;
  viewerId: string | null;
}) {
  let legend: Awaited<ReturnType<typeof facilityLegend>> = null;
  try {
    legend = await facilityLegend(getDb(), facilityId);
  } catch {
    return null;
  }
  if (!legend) return null;

  const t = await getTranslations('Legend');
  const yours = viewerId !== null && viewerId === legend.holderUserId;

  return (
    <section className="flex items-center gap-3 rounded-card border border-line bg-surface p-4 shadow-sm">
      <span className="grid size-11 shrink-0 place-items-center rounded-full bg-accent-active text-on-brand">
        <Crown size={22} />
      </span>
      <div className="min-w-0">
        <h2 className="font-mono text-overline uppercase tracking-overline text-text-secondary">
          {t('title')}
        </h2>
        <p className="mt-0.5 text-h4 font-bold text-ink">{t('days', { count: legend.days })}</p>
        <p className="text-caption text-text-muted">
          {t('window')}
          {yours ? ` · ${t('yours')}` : ''}
        </p>
      </div>
    </section>
  );
}
