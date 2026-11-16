/**
 * A cron expression as a shape the health page can put into words
 * (/admin/zdrave, UX audit 2026-10-31 V-04: «7 * * * *» means nothing to the
 * operator). Only the shapes the worker actually schedules are recognised —
 * every minute, every N minutes, hourly, daily, weekly and monthly at a
 * time — and anything else returns null, so the page prints the raw
 * expression alone rather than guessing. Pure, so tests can hold every
 * schedule in apps/worker/src/index.ts to «describable».
 */
export type CronWords =
  | { kind: 'everyMinute' }
  | { kind: 'everyMinutes'; n: number }
  | { kind: 'hourly'; minute: string }
  | { kind: 'daily'; time: string }
  /** `weekday`: 0 = Sunday … 6 = Saturday, as cron and Date agree. */
  | { kind: 'weekly'; weekday: number; time: string }
  | { kind: 'monthly'; day: number; time: string };

const NUMBER = /^\d{1,2}$/;

function pad(value: string): string {
  return value.padStart(2, '0');
}

export function describeCron(cron: string): CronWords | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  if (month !== '*') return null;

  if (minute === '*' && hour === '*' && day === '*' && weekday === '*') {
    return { kind: 'everyMinute' };
  }
  const every = /^\*\/(\d{1,2})$/.exec(minute);
  if (every && hour === '*' && day === '*' && weekday === '*') {
    const n = Number(every[1]);
    return n > 0 && n < 60 ? { kind: 'everyMinutes', n } : null;
  }
  if (!NUMBER.test(minute) || Number(minute) > 59) return null;
  if (hour === '*' && day === '*' && weekday === '*')
    return { kind: 'hourly', minute: pad(minute) };
  if (!NUMBER.test(hour) || Number(hour) > 23) return null;
  const time = `${pad(hour)}:${pad(minute)}`;
  if (day === '*' && weekday === '*') return { kind: 'daily', time };
  if (day === '*' && /^[0-7]$/.test(weekday)) {
    return { kind: 'weekly', weekday: Number(weekday) % 7, time };
  }
  if (weekday === '*' && NUMBER.test(day) && Number(day) >= 1 && Number(day) <= 31) {
    return { kind: 'monthly', day: Number(day), time };
  }
  return null;
}

/** The weekday's name in `locale` — 2024-01-07 was a Sunday. */
export function weekdayName(weekday: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2024, 0, 7 + weekday)),
  );
}
