import { getLocale, getTranslations } from 'next-intl/server';

import type { BadgeState } from '@sportkarta/lib/badges';

import { badgeArt } from '@/lib/design/badge-art';

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
 *
 * The coin art is the POPS set (lib/design/badge-art.ts): the locked variant is
 * the same shape in grey, and the coin's own dashed edge-track doubles as the
 * progress bar — a coral arc drawn over it at the same radius (r45 in the
 * coin's 100-unit box, per docs/design/pops-brand/LOGO-README.md).
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
      {badges.map((badge) => {
        const art = badgeArt(badge.slug, { locked: !badge.earned });
        const pct = badge.earned
          ? 100
          : Math.min(
              100,
              Math.round((badge.progress.have / Math.max(1, badge.progress.need)) * 100),
            );
        return (
          <li
            key={badge.slug}
            className={
              badge.earned
                ? 'relative rounded-card border border-brand-border bg-brand-subtle p-3'
                : 'relative rounded-card border border-dashed border-line-strong p-3 text-text-muted'
            }
          >
            {badge.earned && isNew.has(badge.slug) && (
              <span className="absolute right-2 top-2 rounded-pill bg-accent-active px-1.5 py-0.5 text-[10px] font-semibold uppercase text-on-accent">
                {t('new')}
              </span>
            )}
            {art && (
              <span className="relative mb-2 block size-16">
                {/* eslint-disable-next-line @next/next/no-img-element -- a 64px
                    static SVG from public/; next/image adds a loader round-trip
                    and cannot optimize SVG anyway */}
                <img src={art} alt="" className="block size-16" />
                {/* Partial progress rides the coin's own dashed edge-track. */}
                {!badge.earned && pct > 0 && (
                  <svg
                    viewBox="0 0 100 100"
                    className="absolute inset-0 size-16"
                    aria-hidden="true"
                  >
                    <circle
                      cx="50"
                      cy="50"
                      r="45"
                      fill="none"
                      stroke="var(--accent)"
                      strokeWidth="4"
                      strokeLinecap="round"
                      pathLength="100"
                      strokeDasharray={`${String(pct)} 100`}
                      transform="rotate(-90 50 50)"
                    />
                  </svg>
                )}
              </span>
            )}
            <h3 className="text-body-sm font-semibold">{t(`${badge.slug}.name`)}</h3>
            <p className="mt-1 text-caption">{t(`${badge.slug}.description`)}</p>
            {!badge.earned && (
              <p className="mt-2 text-caption tabular-nums text-text-muted">
                {t('progress', { have: badge.progress.have, need: badge.progress.need })}
              </p>
            )}
          </li>
        );
      })}
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
 *
 * The coin adds imagery only — no new data (the slug was already public here).
 */
export async function PublicBadgeGrid({ badges }: { badges: PublicBadgeView[] }) {
  const [t, locale] = await Promise.all([getTranslations('Badge'), getLocale()]);

  if (badges.length === 0) {
    return <p className="text-body-sm text-text-muted">{t('noneYet')}</p>;
  }

  // The privacy contract keeps month granularity; the READER still deserves
  // „август 2026", not the wire format.
  const monthFormat = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'bg-BG', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const monthLabel = (earnedMonth: string) =>
    monthFormat.format(new Date(`${earnedMonth}-01T00:00:00Z`));

  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {badges.map((badge) => {
        const art = badgeArt(badge.slug);
        return (
          <li
            key={badge.slug}
            className="rounded-card border border-brand-border bg-brand-subtle p-3"
          >
            {art && (
              // eslint-disable-next-line @next/next/no-img-element -- see BadgeGrid
              <img src={art} alt="" className="mb-2 block size-16" />
            )}
            <h3 className="text-body-sm font-semibold">{t(`${badge.slug}.name`)}</h3>
            <p className="mt-1 text-caption">{t(`${badge.slug}.description`)}</p>
            <p className="mt-2 text-caption text-text-muted">{monthLabel(badge.earnedMonth)}</p>
          </li>
        );
      })}
    </ul>
  );
}
