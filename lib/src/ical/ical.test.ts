import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { escapeText, foldLine, formatUtc, renderCalendar, type IcalEvent } from './index.js';

const encoder = new TextEncoder();

const EVENT: IcalEvent = {
  uid: 'occurrence-11111111-1111-4111-8111-111111111111@pops.bg',
  startsAt: new Date('2026-07-23T15:00:00Z'),
  endsAt: new Date('2026-07-23T16:30:00Z'),
  summary: 'Футбол в Борисовата градина',
  description: 'Свободна тренировка; всички са добре дошли.',
  location: 'Игрище „Борисова градина“, София',
  url: 'https://pops.bg/sesiya/11111111-1111-4111-8111-111111111111',
  lat: 42.685,
  lon: 23.3423,
};

function render(events: IcalEvent[] = [EVENT]): string {
  return renderCalendar({
    name: 'POPS',
    prodId: '-//POPS//Play sessions//BG',
    events,
    now: new Date('2026-07-20T08:00:00Z'),
  });
}

describe('foldLine', () => {
  it('leaves a short line alone', () => {
    expect(foldLine('SUMMARY:hello')).toBe('SUMMARY:hello');
  });

  it('folds on octets, not characters', () => {
    // 60 Cyrillic letters = 120 octets: under the 75-character limit a naive
    // implementation would use, well over the 75-OCTET limit that is the rule.
    const line = `SUMMARY:${'я'.repeat(60)}`;
    const folded = foldLine(line);
    expect(folded).toContain('\r\n ');
    for (const part of folded.split('\r\n')) {
      expect(encoder.encode(part).length).toBeLessThanOrEqual(75);
    }
  });

  it('never splits a multi-byte character', () => {
    // Round-tripping through the encoder would produce U+FFFD if a code point
    // had been cut in half — the mojibake this rule exists to prevent.
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 250, unit: 'binary' }), (text) => {
        const unfolded = foldLine(`X-TEST:${text}`).replace(/\r\n /g, '');
        expect(unfolded).toBe(`X-TEST:${text}`);
      }),
      // Kept modest on purpose: the whole workspace suite runs these files in
      // parallel, and a property test that only fails under load is worse than
      // no property test at all.
      { numRuns: 150 },
    );
  });

  it('keeps every folded segment within the octet limit, for any input', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 250, unit: 'binary' }), (text) => {
        for (const part of foldLine(`X-TEST:${text}`).split('\r\n')) {
          expect(encoder.encode(part).length).toBeLessThanOrEqual(75);
        }
      }),
      { numRuns: 150 },
    );
  });

  it('starts every continuation line with exactly one space', () => {
    const folded = foldLine(`SUMMARY:${'a'.repeat(300)}`);
    const parts = folded.split('\r\n');
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts.slice(1)) {
      expect(part.startsWith(' ')).toBe(true);
      expect(part.startsWith('  ')).toBe(false);
    }
  });
});

describe('escapeText', () => {
  it('escapes backslash, semicolon, comma and newline', () => {
    expect(escapeText('a\\b;c,d\ne')).toBe('a\\\\b\\;c\\,d\\ne');
  });

  it('escapes the backslash first, so nothing is double-escaped', () => {
    // Naively replacing ';' before '\' would turn "\;" into "\\\\;" here.
    expect(escapeText('\\;')).toBe('\\\\\\;');
  });

  it('normalises CRLF to a single escaped newline', () => {
    expect(escapeText('a\r\nb')).toBe('a\\nb');
  });
});

describe('formatUtc', () => {
  it('emits the RFC 5545 UTC form', () => {
    expect(formatUtc(new Date('2026-07-23T15:00:00Z'))).toBe('20260723T150000Z');
  });

  it('is the instant, so a Sofia summer session lands three hours earlier in UTC', () => {
    // 18:00 EEST = 15:00Z. The site shows the wall clock; the calendar carries
    // the instant, and the reader's client renders it back.
    expect(formatUtc(new Date('2026-07-23T18:00:00+03:00'))).toBe('20260723T150000Z');
  });

  it('and a Sofia winter session two hours earlier', () => {
    expect(formatUtc(new Date('2026-01-15T18:00:00+02:00'))).toBe('20260115T160000Z');
  });
});

describe('renderCalendar', () => {
  it('uses CRLF everywhere, including after the last line', () => {
    const ics = render();
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    // No bare LF anywhere.
    expect(ics.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('opens and closes the calendar and the event', () => {
    const ics = render();
    expect(ics).toContain('BEGIN:VCALENDAR\r\n');
    expect(ics).toContain('BEGIN:VEVENT\r\n');
    expect(ics).toContain('END:VEVENT\r\n');
    expect(ics).toContain('END:VCALENDAR\r\n');
  });

  it('ships no VTIMEZONE — the instants are absolute', () => {
    // A second copy of Bulgaria's DST rules is exactly what Stage 4.1 exists to
    // avoid. If this ever starts failing, the fix is not to update the rules.
    expect(render()).not.toContain('VTIMEZONE');
  });

  it('publishes rather than inviting', () => {
    // METHOD:REQUEST would make clients show an RSVP dialogue that goes nowhere.
    expect(render()).toContain('METHOD:PUBLISH');
    expect(render()).not.toContain('METHOD:REQUEST');
  });

  it('marks a cancelled occurrence CANCELLED instead of dropping it', () => {
    const ics = render([{ ...EVENT, cancelled: true, sequence: 1 }]);
    expect(ics).toContain('STATUS:CANCELLED');
    // The bump is what makes a conforming client accept the cancellation.
    expect(ics).toContain('SEQUENCE:1');
  });

  it('defaults a live occurrence to CONFIRMED at sequence 0', () => {
    const ics = render();
    expect(ics).toContain('STATUS:CONFIRMED');
    expect(ics).toContain('SEQUENCE:0');
  });

  it('carries coordinates as GEO:lat;lon', () => {
    expect(render()).toContain('GEO:42.685000;23.342300');
  });

  it('omits GEO entirely when either coordinate is missing', () => {
    const ics = render([{ ...EVENT, lat: undefined, lon: undefined }]);
    expect(ics).not.toContain('GEO:');
  });

  it('escapes the commas in a location so it stays one property', () => {
    const ics = render();
    expect(ics).toContain('Борисова градина“\\, София');
  });

  it('renders every event in the feed', () => {
    const ics = render([
      EVENT,
      { ...EVENT, uid: 'second@pops.bg', summary: 'Баскетбол' },
      { ...EVENT, uid: 'third@pops.bg', summary: 'Тенис' },
    ]);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(3);
    expect(ics).toContain('second@pops.bg');
  });

  it('produces an empty but valid calendar when nothing is scheduled', () => {
    const ics = render([]);
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('END:VCALENDAR');
    expect(ics).not.toContain('BEGIN:VEVENT');
  });

  it('never emits an unfolded over-long line, whatever the title', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 200, unit: 'binary' }), (summary) => {
        const ics = renderCalendar({
          name: 'POPS',
          prodId: '-//POPS//Play sessions//BG',
          events: [{ ...EVENT, summary }],
          now: new Date('2026-07-20T08:00:00Z'),
        });
        for (const part of ics.split('\r\n')) {
          expect(encoder.encode(part).length).toBeLessThanOrEqual(75);
        }
      }),
      { numRuns: 200 },
    );
  });
});
