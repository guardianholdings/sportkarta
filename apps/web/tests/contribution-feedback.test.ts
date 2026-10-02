import { describe, expect, it } from 'vitest';

import bg from '../messages/bg.json';
import en from '../messages/en.json';
import { displayKm, thanksMessage } from '../lib/contributions/feedback';

/**
 * What a contributor is told before and after sending (pre-launch audit,
 * 2026-09).
 *
 * Two lies by omission, both about proximity — the one thing that decides
 * whether a contribution publishes and pays (lib/contributions/proximity.ts):
 *
 * 1. Any browser fix at all made the form promise «ще се публикува веднага,
 *    защото сте на място» — to a member sitting at home. Having a position is
 *    not being on site; the server measures that after the submit.
 * 2. After the submit, "recorded" covered three different truths: already paid
 *    today, too far away, or no position shared. A member at home never
 *    learned why nothing was paid and reasonably believed it went live.
 */

const CATALOGUES = [
  ['bg', bg],
  ['en', en],
] as const;

describe('thanksMessage — says why a contribution earned nothing', () => {
  it('names the figure when points were paid', () => {
    expect(thanksMessage({ awarded: 3, onSite: true, distanceM: 40 })).toEqual({
      key: 'thanksWithPoints',
      points: 3,
    });
  });

  it('names the distance when the member was too far away', () => {
    expect(thanksMessage({ awarded: 0, onSite: false, distanceM: 4_200 })).toEqual({
      key: 'offSiteNotice',
      km: 4.2,
    });
  });

  it('says a contribution without a position cannot pay', () => {
    expect(thanksMessage({ awarded: 0, onSite: false, distanceM: null })).toEqual({
      key: 'offSiteNoLocation',
    });
    expect(thanksMessage({ awarded: 0, onSite: false })).toEqual({ key: 'offSiteNoLocation' });
  });

  it('on site but already paid today is a plain thanks, never "+0"', () => {
    expect(thanksMessage({ awarded: 0, onSite: true, distanceM: 30 })).toEqual({
      key: 'thanksNoPoints',
    });
  });

  it('a flow that never measured (a "facility is gone" report) is a plain thanks', () => {
    expect(thanksMessage({ awarded: 0 })).toEqual({ key: 'thanksNoPoints' });
  });
});

describe('displayKm', () => {
  it('one decimal under 10 km, whole kilometres above', () => {
    expect(displayKm(260)).toBe(0.3);
    expect(displayKm(4_249)).toBe(4.2);
    expect(displayKm(9_940)).toBe(9.9);
    expect(displayKm(12_600)).toBe(13);
  });
});

describe('the copy', () => {
  it('a position in hand promises nothing about publishing', () => {
    for (const [locale, messages] of CATALOGUES) {
      const granted = messages.Contribute.locationGranted;
      expect(granted, locale).not.toMatch(/публикува|publish/i);
      expect(granted, locale).not.toMatch(/защото сте на място|because you are on site/i);
    }
  });

  it('every thanks key the helper can return exists, with the placeholder it is given', () => {
    for (const [locale, messages] of CATALOGUES) {
      const c = messages.Contribute;
      expect(c.thanksNoPoints, locale).toBeTruthy();
      expect(c.offSiteNoLocation, locale).toBeTruthy();
      expect(c.thanksWithPoints, locale).toContain('{points}');
      // `{km, number}` so the reader's locale formats the decimal («4,2»).
      expect(c.offSiteNotice, locale).toContain('{km, number}');
      expect(c.conditionOffSiteNote, locale).toBeTruthy();
    }
  });

  it('a blocked site is told how to undo it, not just that it is off', () => {
    for (const [locale, messages] of CATALOGUES) {
      expect(messages.Contribute.locationDenied, locale).toMatch(/настройките|settings/i);
      expect(messages.Report.location.denied, locale).toMatch(/настройките|settings/i);
      expect(messages.Checkin.locationDenied, locale).toMatch(/настройките|settings/i);
    }
  });

  it('an expired report form is not told it was "too fast"', () => {
    for (const [locale, messages] of CATALOGUES) {
      expect(messages.Report.error.expired, locale).toBeTruthy();
      expect(messages.Report.error.expired, locale).not.toBe(messages.Report.error.tooFast);
    }
  });
});
