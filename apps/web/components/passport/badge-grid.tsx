import { getTranslations } from 'next-intl/server';

import type { BadgeState } from '@sportkarta/lib/badges';

/**
 * The badge grid.
 *
 * Names and descriptions come from the `Badge` namespace keyed by slug, so
 * adding a badge is a config entry plus two message keys and nothing here
 * changes (the i18n parity test catches a missing key at build time rather than
 * rendering a raw slug at a member).
 *
 * Unearned badges are SHOWN, with their progress. A locked tile that says what
 * it wants is an invitation; a hidden one is a surprise nobody was working
 * towards. Progress is only ever shown on a member's own passport — see
 * PublicBadgeGrid for why the public one omits it.
 */
export async function BadgeGrid({
  badges,
  newBadges = [],
}: {
  badges: BadgeState[];
  newBadges?: readonly string[];
}) {
  const t = await getTranslations('Badge');
  const isNew = new Set(newBadges);

  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {badges.map((badge) => (
        <li
          key={badge.slug}
          className={
            badge.earned
              ? 'relative rounded-card border border-brand-border bg-brand-subtle p-3'
              : 'relative rounded border border-dashed border-line-strong p-3 text-text-muted'
          }
        >
          {badge.earned && isNew.has(badge.slug) && (
            <span className="absolute right-2 top-2 rounded-pill bg-accent px-1.5 py-0.5 text-[10px] font-semibold uppercase text-on-accent">
              {t('new')}
            </span>
          )}
          <h3 className="text-body-sm font-semibold">{t(`${badge.slug}.name`)}</h3>
          <p className="mt-1 text-caption">{t(`${badge.slug}.description`)}</p>
          {!badge.earned && (
            <p className="mt-2 text-xs tabular-nums text-text-muted">
              {t('progress', { have: badge.progress.have, need: badge.progress.need })}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

export interface PublicBadgeView {
  slug: string;
  /** `YYYY-MM`. The public page never shows a finer date. */
  earnedMonth: string;
}

/**
 * The public badge grid: earned badges only, dated to the month.
 *
 * Two omissions, both deliberate. Progress on unearned badges is activity data
 * ("nine of ten games") that says how much somebody has been playing lately.
 * And an exact earn timestamp, cross-referenced against the public weekly
 * session listings, would identify which session a person attended — the page
 * would be publishing where a named individual was, and when.
 */
export async function PublicBadgeGrid({ badges }: { badges: PublicBadgeView[] }) {
  const t = await getTranslations('Badge');

  if (badges.length === 0) {
    return <p className="text-body-sm text-text-muted">{t('noneYet')}</p>;
  }

  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {badges.map((badge) => (
        <li key={badge.slug} className="rounded-card border border-brand-border bg-brand-subtle p-3">
          <h3 className="text-body-sm font-semibold">{t(`${badge.slug}.name`)}</h3>
          <p className="mt-1 text-caption">{t(`${badge.slug}.description`)}</p>
          <p className="mt-2 text-xs tabular-nums text-text-muted">{badge.earnedMonth}</p>
        </li>
      ))}
    </ul>
  );
}
