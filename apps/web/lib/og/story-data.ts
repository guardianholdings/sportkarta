import {
  getDb,
  memberDivision,
  memberParticipation,
  memberTrainings,
  passportTotals,
  weekStandings,
} from '@sportkarta/db';
import { tierSlug, divisionWeekStart } from '@sportkarta/lib/divisions';
import { formatKm, formatMinutes } from '@sportkarta/lib/share';
import type { StoryCardInput } from '@/lib/og/story';

/**
 * The data behind each person-scoped story, resolved from the SIGNED-IN
 * member's own id.
 *
 * NOTHING HERE TAKES A HANDLE, AN ACCOUNT ID OR ANY OTHER SUBJECT FROM THE
 * REQUEST. Every function takes the id `requireUser()` returned, so a member can
 * only ever render a story about themselves. That is why these stories need no
 * consent check of their own and no `leaderboard_eligible_members` join: they
 * are not a publication, they are a member's own screen — and the file they
 * produce goes straight into their own OS share sheet.
 *
 * The member decides what happens next. Which is also why these routes must be
 * `no-store` and session-gated: a URL that renders a named image without a
 * cookie is a URL somebody can guess.
 */

export interface StoryStrings {
  eyebrow: string;
  heroLabel: string;
  title: string;
  subtitle?: string | null;
  statLabels: string[];
  callToAction: string;
  wordmark: string;
}

export type StoryData = Pick<
  StoryCardInput,
  'eyebrow' | 'hero' | 'heroLabel' | 'title' | 'subtitle' | 'stats' | 'callToAction'
> | null;

/** One logged training, by row id, scoped to its owner. */
export async function trainingStory(
  userId: string,
  trainingId: string,
  strings: {
    eyebrow: string;
    heroKm: string;
    heroMin: string;
    title: (sport: string) => string;
    labelMinutes: string;
    labelKm: string;
    labelElevation: string;
    callToAction: string;
  },
): Promise<StoryData> {
  // `memberTrainings` is already scoped by user id, so a row belonging to
  // somebody else simply is not in the result — no ownership branch to forget.
  const rows = await memberTrainings(getDb(), userId, 200);
  const row = rows.find((r) => r.id === trainingId);
  if (!row) return null;

  const km = formatKm(row.distanceM);
  const minutes = formatMinutes(row.durationS);

  // The hero is the distance when there is one and the duration otherwise: a
  // climb has no kilometres, and "0.0 km" as the biggest thing on the screen is
  // a story about failing.
  const hero = km ?? String(minutes);
  const heroLabel = km ? strings.heroKm : strings.heroMin;

  // The hero is never repeated in the stat row. Printing 9.4 as both the giant
  // number and a supporting figure reads as a rendering bug, and it spends one
  // of only three stat slots saying something already said in 260px type.
  const stats = [
    ...(km ? [{ value: String(minutes), label: strings.labelMinutes }] : []),
    ...(row.elevationM && row.elevationM > 0
      ? [{ value: String(row.elevationM), label: strings.labelElevation }]
      : []),
  ];

  return {
    eyebrow: strings.eyebrow,
    hero,
    heroLabel,
    title: strings.title(row.sport),
    // The PLACE, never the time. A facility is a public place the member chose
    // to name; a timestamp beside it is a pattern-of-life record, and the
    // check-in path already refuses to store one.
    subtitle: row.facilityName,
    stats,
    callToAction: strings.callToAction,
  };
}

/** The member's own 30-day training summary. */
export async function weekStory(
  userId: string,
  strings: {
    eyebrow: string;
    heroLabel: string;
    title: string;
    labelMinutes: string;
    labelSports: string;
    callToAction: string;
  },
): Promise<StoryData> {
  const totals = await memberParticipation(getDb(), userId, { days: 30 });
  if (totals.sessions === 0) return null;

  return {
    eyebrow: strings.eyebrow,
    hero: String(totals.sessions),
    heroLabel: strings.heroLabel,
    title: strings.title,
    subtitle: null,
    stats: [
      { value: String(totals.minutes), label: strings.labelMinutes },
      { value: String(totals.sports), label: strings.labelSports },
    ],
    callToAction: strings.callToAction,
  };
}

/** Points and contributions — the member's own passport, without their name. */
export async function passportStory(
  userId: string,
  strings: {
    eyebrow: string;
    heroLabel: string;
    title: string;
    labelContributions: string;
    labelBadges: string;
    callToAction: string;
  },
): Promise<StoryData> {
  const totals = await passportTotals(getDb(), userId);
  if (totals.points === 0) return null;

  const contributions =
    totals.facilitiesAdded + totals.facilitiesVerified + totals.conditionsReported;

  return {
    eyebrow: strings.eyebrow,
    hero: String(totals.points),
    heroLabel: strings.heroLabel,
    title: strings.title,
    subtitle: null,
    stats: [
      { value: String(contributions), label: strings.labelContributions },
      ...(totals.checkins > 0
        ? [{ value: String(totals.checkins), label: strings.labelBadges }]
        : []),
    ],
    callToAction: strings.callToAction,
  };
}

/** The member's current division standing. */
export async function divisionStory(
  userId: string,
  strings: {
    eyebrow: string;
    heroLabel: string;
    title: (tier: string) => string;
    tierName: (slug: string) => string;
    labelPoints: string;
    labelOf: string;
    callToAction: string;
  },
): Promise<StoryData> {
  const week = divisionWeekStart();
  const group = await memberDivision(getDb(), userId, week);
  if (!group) return null;

  const rows = await weekStandings(getDb(), week, { groupId: group.groupId });
  const mine = rows.find((r) => r.userId === userId);
  if (!mine) return null;

  return {
    eyebrow: strings.eyebrow,
    hero: String(mine.rank),
    heroLabel: strings.heroLabel,
    title: strings.title(strings.tierName(tierSlug(group.tier))),
    subtitle: null,
    stats: [
      { value: String(mine.score), label: strings.labelPoints },
      { value: String(mine.groupSize), label: strings.labelOf },
    ],
    callToAction: strings.callToAction,
  };
}
