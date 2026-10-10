import { CANONICAL_SPORTS } from '@sportkarta/lib/sports';
import { describe, expect, it } from 'vitest';

import {
  formatDate,
  formatDateTime,
  formatMonthYear,
  formatNumber,
  formatPercent,
  inReadingOrder,
} from '@/lib/format';

import bg from '../messages/bg.json';
import en from '../messages/en.json';

// 01:30 on 10 October in Sofia — still 9 October in UTC, the process zone.
const AFTER_SOFIA_MIDNIGHT = new Date('2026-10-09T22:30:00Z');

describe('dates are Sofia dates, whatever the process zone', () => {
  it('a contribution made at 01:30 in Sofia is dated that day, not the UTC day before', () => {
    expect(formatDate(AFTER_SOFIA_MIDNIGHT, 'bg')).toBe('10 октомври 2026 г.');
    expect(formatDate(AFTER_SOFIA_MIDNIGHT, 'en')).toBe('10 October 2026');
  });

  it('formats the time in Sofia too', () => {
    // CLDR's Bulgarian short time has no leading zero («1:30», «18:30»).
    expect(formatDateTime(AFTER_SOFIA_MIDNIGHT, 'bg')).toBe('10 октомври 2026 г. в 1:30');
    expect(formatDateTime(AFTER_SOFIA_MIDNIGHT, 'en')).toBe('10 October 2026 at 01:30');
  });

  it('reads a civil date as that calendar day, in summer and in winter', () => {
    expect(formatDate('2027-06-30', 'bg')).toBe('30 юни 2027 г.');
    expect(formatDate('2027-01-01', 'en')).toBe('1 January 2027');
  });

  it('names a YYYY-MM month in words, never as raw digits', () => {
    expect(formatMonthYear('2026-10', 'bg')).toBe('октомври 2026 г.');
    expect(formatMonthYear('2026-10', 'en')).toBe('October 2026');
  });

  it('writes English dates day-first, the European way', () => {
    expect(formatDate('2026-10-10', 'en', 'medium')).toBe('10 Oct 2026');
  });
});

describe('numbers use the reader’s separators', () => {
  it('a decimal comma and a no-break space for thousands in Bulgarian', () => {
    expect(formatNumber(12345.6, 'bg')).toBe('12\u00a0345,6');
    expect(formatNumber(12345.6, 'en')).toBe('12,345.6');
  });

  it('percentages on the 0–100 scale, one decimal by default', () => {
    expect(formatPercent(98.8, 'bg')).toBe('98,8%');
    expect(formatPercent(98.8, 'en')).toBe('98.8%');
    expect(formatPercent(0, 'bg')).toBe('0,0%');
    expect(formatPercent(12.46, 'bg', 0)).toBe('12%');
  });
});

describe('pickers list sports in the reader’s alphabetical order', () => {
  const labels = (catalogue: { Sport: Record<string, string> }) => (s: string) =>
    catalogue.Sport[s] ?? s;

  it('Bulgarian order by the Bulgarian label, not the English slug', () => {
    const ordered = inReadingOrder(CANONICAL_SPORTS, 'bg', labels(bg));
    const shown = ordered.map(labels(bg));
    // Cyrillic before Latin («BMX» last), alphabetical within.
    expect(shown[0]).toBe('бадминтон');
    expect(shown.indexOf('футбол')).toBeGreaterThan(shown.indexOf('волейбол'));
    expect(shown.at(-1)).toBe('BMX');
    expect([...shown].sort(new Intl.Collator('bg').compare)).toEqual(shown);
  });

  it('keeps every sport exactly once', () => {
    const ordered = inReadingOrder(CANONICAL_SPORTS, 'en', labels(en));
    expect(new Set(ordered)).toEqual(new Set(CANONICAL_SPORTS));
    expect(ordered).toHaveLength(CANONICAL_SPORTS.length);
  });
});
