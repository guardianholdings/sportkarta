import { describe, expect, it } from 'vitest';

import { renderClubWidget, type ClubWidgetInput } from '@/lib/clubs/widget';

/**
 * The club's embeddable widgets (0045) render text a club typed — its name,
 * class titles, locations, plan names — into a document served inside other
 * people's websites. Every one of those strings must arrive escaped: the
 * route's `script-src 'none'` is the second line of defence, not the first.
 */

const HOSTILE = '"><script>alert(1)</script><img src=x onerror=alert(1)>';

function input(kind: ClubWidgetInput['kind']): ClubWidgetInput {
  return {
    kind,
    locale: 'bg',
    clubName: HOSTILE,
    pageUrl: 'https://pops.bg/klub/test-klub',
    classes: [
      {
        occurrenceId: '00000000-0000-4000-8000-000000000001',
        title: HOSTILE,
        sport: 'fitness',
        startsAt: '2026-10-26T16:00:00.000Z',
        endsAt: '2026-10-26T17:00:00.000Z',
        locationName: HOSTILE,
        instructorName: HOSTILE,
        capacity: 10,
        going: 3,
        waitlisted: 0,
        bookingOpensAt: '2026-10-20T16:00:00.000Z',
        trialAllowed: false,
        cancelDeadlineHours: 12,
        lateCancelFeeCents: null,
        noShowFeeCents: null,
        strikeLimit: null,
        strikeDays: null,
      },
    ],
    plans: [
      {
        id: 'p',
        name: HOSTILE,
        description: HOSTILE,
        kind: 'unlimited',
        audience: 'all',
        priceCents: 4500,
        validityDays: null,
        validityMonths: 1,
        visitsCount: null,
        autoRenew: false,
        noticeDays: 0,
        minTermMonths: null,
      },
    ],
    strings: {
      title: 'Седмицата',
      empty: 'Няма',
      spots: (going, capacity) => `${going}/${capacity ?? '∞'}`,
      full: 'Пълно',
      book: 'Запишете се',
      more: 'Още',
      validity: () => HOSTILE,
      poweredBy: 'POPS',
    },
  };
}

describe('club widget', () => {
  it.each(['grafik', 'ceni'] as const)('escapes everything a club typed (%s)', (kind) => {
    const html = renderClubWidget(input(kind));
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain('&lt;script&gt;');
  });

  it('links only to the club page on pops.bg, in a new tab', () => {
    const html = renderClubWidget(input('grafik'));
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(href?.startsWith('https://pops.bg/klub/test-klub')).toBe(true);
    expect(html.match(/<a /g)?.length).toBe(html.match(/target="_blank" rel="noopener"/g)?.length);
  });
});
