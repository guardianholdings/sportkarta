import { describe, expect, it } from 'vitest';

import { addedAway, addedLanding } from '@/lib/contributions/added-banner';
import { thanksMessage } from '@/lib/contributions/feedback';

/**
 * Where a member lands after adding a facility (UX audit 2026-10-10): never on
 * a 404, and never thanked for nothing without being told why.
 */
describe('addedLanding', () => {
  const base = { slug: 'novo-igrishte', awarded: true, visible: true, onSite: true };

  it('a visible facility lands on its own page with the real award', () => {
    expect(addedLanding(base)).toBe('/obekt/novo-igrishte?added=10');
  });

  it('a facility the public site hides (paid) is thanked on /dobavi, not on its 404', () => {
    const landing = addedLanding({ ...base, visible: false });
    expect(landing.startsWith('/dobavi?saved=hidden&')).toBe(true);
    expect(landing).not.toContain('/obekt/');
  });

  it('an add from away carries the distance in metres — never a coordinate', () => {
    const landing = addedLanding({ ...base, awarded: false, onSite: false, distanceM: 4321.6 });
    expect(landing).toBe('/obekt/novo-igrishte?added=0&away=4322');
  });

  it('an add without a shared location says so', () => {
    const landing = addedLanding({ ...base, awarded: false, onSite: false, distanceM: null });
    expect(landing).toBe('/obekt/novo-igrishte?added=0&away=none');
  });

  it('an on-site add the ledger had already paid gives no reason to explain', () => {
    expect(addedLanding({ ...base, awarded: false })).toBe('/obekt/novo-igrishte?added=0');
  });
});

describe('addedAway', () => {
  it('reads back exactly what addedLanding writes', () => {
    expect(addedAway('none')).toEqual({ onSite: false, distanceM: null });
    expect(addedAway('4322')).toEqual({ onSite: false, distanceM: 4322 });
  });

  it('ignores anything else — it only chooses a thank-you sentence', () => {
    for (const forged of [undefined, '', '-1', '1e3', '0x10', '12.5', ['none'], '12345678']) {
      expect(addedAway(forged)).toBeNull();
    }
  });

  it('turns into the same three answers the verify and condition thanks give', () => {
    expect(thanksMessage({ awarded: 0, ...addedAway('none') }).key).toBe('offSiteNoLocation');
    expect(thanksMessage({ awarded: 0, ...addedAway('4322') })).toEqual({
      key: 'offSiteNotice',
      km: 4.3,
    });
    expect(thanksMessage({ awarded: 0, ...addedAway(undefined) }).key).toBe('thanksNoPoints');
  });
});
