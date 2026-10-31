import { describe, expect, it } from 'vitest';

import { clubContractTerm, CLUB_CONTRACT_MONTHS, noticeDeadline } from './contract.js';
import { membershipEndsOn } from './dates.js';

const START = '2026-12-01';

describe('clubContractTerm', () => {
  it('is none until the operator records a start', () => {
    expect(clubContractTerm({ startsOn: null, noticeOn: null }, '2026-11-15')).toEqual({
      state: 'none',
    });
  });

  it('binds for a whole first term, with notice due a month before it ends', () => {
    expect(clubContractTerm({ startsOn: START, noticeOn: null }, '2026-12-01')).toEqual({
      state: 'running',
      boundUntil: '2027-11-30',
      renewsOn: '2027-12-01',
      noticeBy: '2027-11-01',
    });
  });

  it('counts the term from the start even before the start day', () => {
    // Signed in the trial, starting the day after it: still a whole year.
    expect(clubContractTerm({ startsOn: START, noticeOn: null }, '2026-11-20')).toMatchObject({
      boundUntil: '2027-11-30',
    });
  });

  it('keeps the running term through its notice deadline, then moves to the next', () => {
    const on = (today: string) => clubContractTerm({ startsOn: START, noticeOn: null }, today);
    expect(on('2027-11-01')).toMatchObject({ renewsOn: '2027-12-01', noticeBy: '2027-11-01' });
    // A day late: the renewal of 1 December 2027 can no longer be stopped.
    expect(on('2027-11-02')).toMatchObject({
      boundUntil: '2028-11-30',
      renewsOn: '2028-12-01',
      noticeBy: '2028-11-01',
    });
    expect(on('2030-06-15')).toMatchObject({ renewsOn: '2030-12-01' });
  });

  it('ends a noticed contract at the end of the term the notice still stops', () => {
    const noticed = (noticeOn: string, today = '2027-01-10') =>
      clubContractTerm({ startsOn: START, noticeOn }, today);
    // Notice in the first month still serves the whole minimum term.
    expect(noticed('2027-01-05')).toEqual({ state: 'ending', endsOn: '2027-11-30' });
    expect(noticed('2027-11-01')).toEqual({ state: 'ending', endsOn: '2027-11-30' });
    expect(noticed('2027-11-02', '2027-11-02')).toEqual({ state: 'ending', endsOn: '2028-11-30' });
    expect(noticed('2027-01-05', '2027-11-30')).toMatchObject({ state: 'ending' });
    expect(noticed('2027-01-05', '2027-12-01')).toEqual({ state: 'ended', endsOn: '2027-11-30' });
  });

  it('runs a term to the end of the month when its day does not exist (ЗЗД чл. 72)', () => {
    expect(clubContractTerm({ startsOn: '2028-02-29', noticeOn: null }, '2028-03-01')).toEqual({
      state: 'running',
      boundUntil: '2029-02-28',
      renewsOn: '2029-03-01',
      noticeBy: '2029-02-01',
    });
    expect(noticeDeadline('2027-03-31')).toBe('2027-02-28');
  });

  it('binds for exactly the minimum term when notice comes at once', () => {
    for (const startsOn of ['2026-01-31', '2026-06-15', '2027-02-28', '2028-02-29', '2028-12-31']) {
      expect(clubContractTerm({ startsOn, noticeOn: startsOn }, startsOn)).toEqual({
        state: 'ending',
        endsOn: membershipEndsOn(startsOn, { months: CLUB_CONTRACT_MONTHS }),
      });
    }
  });

  it('serves the whole first term when notice comes before the start', () => {
    // Signed in the trial, noticed before the contract even began.
    expect(clubContractTerm({ startsOn: START, noticeOn: '2026-11-10' }, '2026-11-10')).toEqual({
      state: 'ending',
      endsOn: '2027-11-30',
    });
  });
});
