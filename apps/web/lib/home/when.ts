import { addDaysIso, sofiaToday } from '@sportkarta/lib/clubs';

/**
 * A session's wall-clock start ('YYYY-MM-DDTHH:MM:SS', Sofia) as the front
 * page says it: «днес», «утре» or a short weekday-and-date, plus the time.
 * Civil Sofia days, never elapsed milliseconds (CLAUDE.md, streaks): 23:30
 * tonight is «днес» whatever the viewer's clock says.
 */
export type DayWord = 'today' | 'tomorrow' | null;

export function dayWord(startsAtLocal: string, now: Date = new Date()): DayWord {
  const date = startsAtLocal.slice(0, 10);
  const today = sofiaToday(now);
  if (date === today) return 'today';
  if (date === addDaysIso(today, 1)) return 'tomorrow';
  return null;
}

/** [short date, HH:MM] — en-GB for English, as on /sesii. */
export function whenParts(startsAtLocal: string, locale: string): [string, string] {
  const [date, time] = startsAtLocal.split('T');
  const label = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'bg-BG', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
  return [label, (time ?? '').slice(0, 5)];
}
