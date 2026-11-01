import { describe, expect, it } from 'vitest';

import { mailPlace } from './place.js';

/**
 * Where a game is, as the worker's mail says it. 91% of places have no name,
 * and both mails printed a blank where the place should be: «Къде:  —
 * баскетбол» in a reminder, «баскетбол,  (5 от 12 места)» in the digest.
 */

const LOZENETS = {
  facilityName: null,
  facilityQuarter: 'Лозенец',
  facilityMunicipality: 'Столична',
};

describe('mailPlace', () => {
  it('uses the facility’s own name whenever it has one', () => {
    expect(mailPlace({ ...LOZENETS, facilityName: 'Южен парк' }, 'bg')).toBe('Южен парк');
  });

  it('names an unnamed place by its area, as the site does — «Столична» reads «София»', () => {
    expect(mailPlace(LOZENETS, 'bg')).toBe('Лозенец, София');
    expect(mailPlace(LOZENETS, 'en')).toBe('Лозенец, Sofia');
  });

  it('drops the municipality for a mail about one city', () => {
    expect(mailPlace(LOZENETS, 'bg', { municipality: false })).toBe('Лозенец');
    expect(
      mailPlace({ ...LOZENETS, facilityQuarter: null }, 'bg', { municipality: false }),
    ).toBeNull();
  });

  it('is null when nothing is known, so the template says so in its own words', () => {
    const nothing = { facilityName: '  ', facilityQuarter: null, facilityMunicipality: null };
    expect(mailPlace(nothing, 'bg')).toBeNull();
  });
});
