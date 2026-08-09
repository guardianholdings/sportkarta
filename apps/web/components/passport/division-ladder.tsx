import type { DivisionStandingRow } from '@sportkarta/db';
import { divisionSections, tierSlug, zoneCounts, type DivisionZone } from '@sportkarta/lib/divisions';
import { getTranslations } from 'next-intl/server';

import { Badge } from '@/components/ui/badge';
import { Link } from '@/i18n/navigation';

/**
 * One week's division ladder — docs/ENGAGEMENT-IMPLEMENTATION.md D6.
 *
 * NOT a fifth column on `LeaderboardTable`. That component is a four-column
 * ranked index of public passports with a contributions column a division does
 * not have and no zone semantics at all; bolting zones onto it would leave one
 * component answering two different questions. This is an ordered list with
 * three regions.
 *
 * ZONES ARE STATED IN WORDS, in a header above each region, and never carried by
 * tint alone. A member using a screen reader, or reading in bright sun, or with
 * any of the several kinds of colour blindness, gets the same information as
 * everyone else — and the tint is doing decoration rather than load-bearing
 * work, which is the only way it is allowed to be there.
 *
 * RELEGATION IS DELIBERATELY NOT `--danger`. ENGAGEMENT §1.3 exists BECAUSE
 * absolute boards demoralise the bottom, which here is most of the addressable
 * population; painting the bottom five rows red is that failure rendered in CSS.
 * The relegation zone is recessed paper and muted ink — quieter than the rest of
 * the list, not louder.
 *
 * EVERY NAME HERE IS ALREADY PUBLIC. `weekStandings` inner-joins
 * `leaderboard_eligible_members`, so a row exists only for a member whose
 * passport a visitor could already open, and the name links to it. This
 * component makes no visibility decision of its own — there is deliberately no
 * prop that could hide or reveal a row, because that is the JSX-decides shape
 * the consent rule forbids.
 */
export async function DivisionLadder({
  rows,
  viewerUserId,
}: {
  rows: DivisionStandingRow[];
  /** Highlights the viewer's own row. Never rendered, never used to filter. */
  viewerUserId?: string | null;
}) {
  const t = await getTranslations('Division');

  // Renders NOTHING when there is no ladder — below the floor, or before the
  // first rollover has run. The same discipline `AdSlot` and the Local Legend
  // crest follow: an absent feature must look absent, never broken, and a
  // "divisions open at 10 members" placeholder is a promise with a date on it.
  const first = rows[0];
  if (!first) return null;

  const { promote, relegate } = zoneCounts(first.groupSize);

  /**
   * The bands come from the pure core, NOT from a copy kept here.
   *
   * This component's first version recomputed them, and the entry tier caught
   * it out: the bottom rows were tinted as a relegation zone on a ladder where
   * relegation cannot happen, with the heading suppressed because announcing it
   * would have been untrue — a recessed band whose only carrier was colour,
   * saying something false. `divisionSections` delegates to `zoneFor`, which
   * already makes both ends of the ladder terminal, so at the entry tier those
   * rows are not a zone at all and there is nothing to tint or explain.
   */
  const sections = divisionSections(rows, { size: first.groupSize, tier: first.tier });

  const headingFor = (zone: DivisionZone): string | null => {
    if (zone === 'promote') return t('zonePromote', { count: promote });
    if (zone === 'relegate') return t('zoneRelegate', { count: relegate });
    return null;
  };

  return (
    <section className="space-y-3" aria-labelledby="division-heading">
      <header className="space-y-1">
        <h2 id="division-heading" className="text-h3 font-extrabold tracking-tight text-ink">
          {t(`tier.${tierSlug(first.tier)}`)}
        </h2>
        <p className="text-body-sm text-ink-soft">
          {t('groupSummary', { members: first.groupSize })}
        </p>
      </header>

      <ol className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
        {sections.map((section) => {
          const heading = headingFor(section.zone);
          return (
            <li key={`${section.zone}-${section.rows[0]?.rank ?? 0}`}>
              {heading && (
                <p
                  className={
                    section.zone === 'promote'
                      ? 'border-b border-line bg-success-bg px-4 py-1.5 text-caption font-semibold text-success'
                      : 'border-b border-line bg-paper-sunk px-4 py-1.5 text-caption font-semibold text-text-muted'
                  }
                >
                  {heading}
                </p>
              )}
              <ol className="divide-y divide-line">
                {section.rows.map((row) => {
                  const mine = viewerUserId !== undefined && row.userId === viewerUserId;
                  return (
                    <li
                      key={row.userId}
                      className={[
                        'flex items-center gap-3 px-4 py-2.5 text-body-sm',
                        section.zone === 'relegate' ? 'bg-paper-sunk' : '',
                        mine ? 'font-semibold' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      aria-current={mine ? 'true' : undefined}
                    >
                      <span className="w-6 shrink-0 tabular-nums text-text-muted">{row.rank}</span>
                      <span className="min-w-0 flex-1 truncate">
                        <Link
                          href={`/pasport/${row.handle}`}
                          className="font-medium text-link hover:text-link-hover"
                        >
                          {row.displayName}
                        </Link>
                        {mine && (
                          <Badge tone="brand" className="ml-2">
                            {t('you')}
                          </Badge>
                        )}
                      </span>
                      <span className="shrink-0 tabular-nums font-medium">{row.score}</span>
                    </li>
                  );
                })}
              </ol>
            </li>
          );
        })}
      </ol>

      <p className="text-caption text-text-muted">{t('ladderNote')}</p>
    </section>
  );
}
