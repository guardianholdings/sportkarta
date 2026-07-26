import { bucketKeyFor, type PassportEvent } from '@sportkarta/lib/badges';
import { addDays, instantToWall, isoWeekday, SOFIA_TZ } from '@sportkarta/lib/recurrence';

/**
 * The Viber-native week (docs/ENGAGEMENT.md C3).
 *
 * ENGAGEMENT.md ranks this SECOND overall — above image cards — and the reason
 * is the format, not the content. Wordle spread because its result was
 * plain text: a spoiler-free grid with no app, no link preview, no account,
 * which crossed every messenger at once. Bulgaria's primary sharing surface is
 * Viber, followed by Facebook; both carry pasted text perfectly and neither
 * needs an image to do it.
 *
 * EVERY MEMBER MAY SHARE THIS, including one whose passport is private
 * (operator decision 2026-07-26). It carries no name, no handle, no facility, no
 * time and no link to a person — it is a member's own text about their own week,
 * and the link goes to the site rather than to a profile. That is why it is the
 * one share artifact that does not require the public opt-in.
 *
 * WHY "ANY ACTIVITY" RATHER THAN CHECK-INS. The week STREAK counts participation
 * only, but a grid that is empty for almost everybody is not worth pasting: at
 * launch there is barely any session volume, while mapping and verifying are
 * real and frequent. Showing up for the map is showing up. The copy says
 * "activity", never "sessions", so the two definitions cannot be confused.
 *
 * TWO STATES, NOT THREE. Active or rest. A third state (mapped vs played) is
 * more informative and less on-message — the whole framing is that turning up
 * counts, not what kind of turning up — and two glyphs render identically on
 * every device, which a third would not reliably do.
 *
 * NO CYRILLIC HERE. The grid is emoji and numbers; every word around it comes
 * from `messages/*.json` (the hardcoded-Cyrillic gate scans this directory with
 * an empty allowlist). Emoji are not Cyrillic and do not trip it, so the glyphs
 * may live in code as data — which is right, because they are a rendering
 * decision rather than a translatable string.
 */

/** Deliberately plain: no ZWJ sequences, no skin tones, no regional flags. */
const ACTIVE = '🟩';
const REST = '⬜';

export interface WeekGrid {
  /** Monday → Sunday, in civil Sofia days. */
  cells: ('active' | 'rest')[];
  /** How many of the seven had anything at all. */
  activeDays: number;
  /** The Monday that starts the week, `YYYY-MM-DD`. */
  weekStart: string;
}

/**
 * A member's current Sofia week.
 *
 * The week boundary comes from `bucketKeyFor`, the one place an instant becomes
 * a calendar position — the same function the streaks, the badges and the digest
 * use, so a grid can never disagree with the streak printed beside it about
 * which days count or when the week began.
 */
export function weekGrid(
  events: readonly PassportEvent[],
  now: Date = new Date(),
  timeZone: string = SOFIA_TZ,
): WeekGrid {
  const weekStart = bucketKeyFor(now, 'week', timeZone);

  // The seven civil day keys of this week, stepped with civil arithmetic —
  // never `+ 86_400_000`, which lands an hour out on the two DST days a year.
  const [year, month, day] = weekStart.split('-').map(Number) as [number, number, number];
  const monday = { year, month, day, hour: 0, minute: 0 };
  const dayKeys: string[] = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const wall = addDays(monday, offset);
    dayKeys.push(
      `${String(wall.year).padStart(4, '0')}-${String(wall.month).padStart(2, '0')}-${String(
        wall.day,
      ).padStart(2, '0')}`,
    );
  }

  const active = new Set(events.map((event) => bucketKeyFor(event.at, 'day', timeZone)));
  const cells = dayKeys.map((key) => (active.has(key) ? 'active' : 'rest') as 'active' | 'rest');

  return {
    cells,
    activeDays: cells.filter((cell) => cell === 'active').length,
    weekStart,
  };
}

/** The grid as pasteable text. Emoji only — no words, no locale. */
export function renderWeekGrid(grid: WeekGrid): string {
  return grid.cells.map((cell) => (cell === 'active' ? ACTIVE : REST)).join('');
}

/** Exposed so a test can assert the glyphs rather than hardcode them twice. */
export const WEEK_GLYPHS = { active: ACTIVE, rest: REST } as const;

/** Today's index within the week (0 = Monday), for "so far this week" framing. */
export function dayIndexInWeek(now: Date = new Date(), timeZone: string = SOFIA_TZ): number {
  return isoWeekday(instantToWall(now.getTime(), timeZone)) - 1;
}
