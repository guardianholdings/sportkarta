import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { CANONICAL_SPORTS } from '../sports.js';
import {
  CLUB_ACTIVITIES,
  CLUB_AUDIT_ACTIONS,
  CLUB_AUDIT_ACTOR_KINDS,
  CLUB_CANCEL_REASONS,
  CLUB_CHARGE_KINDS,
  CLUB_CHECKIN_METHODS,
  CLUB_NOTIFICATION_KINDS,
  CLUB_PERMISSIONS,
  CLUB_PLAN_AUDIENCES,
  CLUB_PLAN_KINDS,
  CLUB_ROLES,
  addDaysIso,
  addMonthsIso,
  can,
  canWrite,
  clubAccessState,
  clubSlugFrom,
  daysBetween,
  dedupeKey,
  formatEuro,
  grantableRoles,
  isClubSport,
  isIsoDate,
  isUsableClubSlug,
  isoWeekKey,
  isoWeekMonday,
  membershipEndsOn,
  nextFreeClubSlug,
  parseEuroCents,
  rolesWith,
  sofiaToday,
  trainingSportFor,
  type ClubAccessInput,
} from './index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.join(HERE, '..', '..', '..', 'db', 'migrations');

function migrationText(): string {
  return readdirSync(MIGRATIONS)
    .filter((name) => /^004[0-4]_|^0039_/.test(name))
    .sort()
    .map((name) => readFileSync(path.join(MIGRATIONS, name), 'utf8').replace(/^--.*$/gm, ''))
    .join('\n');
}

/** The quoted values of `"<constraint>" CHECK (... IN (...))`. */
function checkValues(constraint: string): string[] {
  const text = migrationText();
  const at = text.indexOf(`"${constraint}" CHECK`);
  expect(at, constraint).toBeGreaterThan(-1);
  const open = text.indexOf(' IN (', at);
  const close = text.indexOf(')', open + 5);
  return [...text.slice(open + 5, close).matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1] as string);
}

describe('the vocabularies equal their SQL CHECKs', () => {
  it.each([
    ['club_audit_action_known', CLUB_AUDIT_ACTIONS],
    ['club_audit_actor_kind_known', CLUB_AUDIT_ACTOR_KINDS],
    ['club_checkins_method_known', CLUB_CHECKIN_METHODS],
    ['club_charges_kind_known', CLUB_CHARGE_KINDS],
    ['club_plans_kind_known', CLUB_PLAN_KINDS],
    ['club_plans_audience_known', CLUB_PLAN_AUDIENCES],
    ['club_memberships_cancel_reason_known', CLUB_CANCEL_REASONS],
    ['club_notifications_kind_known', CLUB_NOTIFICATION_KINDS],
    ['club_staff_role_known', CLUB_ROLES],
  ] as const)('%s', (constraint, values) => {
    expect(checkValues(constraint).sort()).toEqual([...values].sort());
  });
});

describe('permissions', () => {
  it('is total: every permission is held by at least one role', () => {
    for (const permission of CLUB_PERMISSIONS) {
      expect(rolesWith(permission).length, permission).toBeGreaterThan(0);
    }
  });

  it('gives the owner everything a club can do except the trainer-own variants', () => {
    for (const permission of CLUB_PERMISSIONS) {
      if (permission.endsWith('_own')) continue;
      expect(can('owner', permission), permission).toBe(true);
    }
  });

  it('keeps the trainer away from contact details, money and exports', () => {
    for (const permission of [
      'members.view',
      'payments.view',
      'payments.record',
      'data.export',
      'roster.view',
    ] as const) {
      expect(can('trainer', permission), permission).toBe(false);
    }
    expect(can('trainer', 'roster.view_own')).toBe(true);
    expect(can('trainer', 'attendance.record_own')).toBe(true);
  });

  it('reserves erasure, owner changes and billing to the owner', () => {
    for (const permission of ['members.erase', 'staff.manage_owners', 'billing.view'] as const) {
      expect(rolesWith(permission)).toEqual(['owner']);
    }
  });

  it('lets only an owner create owners', () => {
    expect(grantableRoles('owner')).toContain('owner');
    expect(grantableRoles('manager')).not.toContain('owner');
    expect(grantableRoles('desk')).toEqual([]);
  });
});

describe('access state', () => {
  const today = '2026-10-24';
  const paid = (over: Partial<ClubAccessInput>): ClubAccessInput => ({
    status: 'active',
    tier: 'standard',
    trialEndsOn: null,
    paidUntil: null,
    ...over,
  });

  it('never lapses a community club', () => {
    expect(clubAccessState(paid({ tier: 'community' }), today)).toBe('active');
  });

  it('walks trial → past_due → lapsed with a 14-day grace', () => {
    expect(clubAccessState(paid({ trialEndsOn: '2026-10-24' }), today)).toBe('trial');
    expect(clubAccessState(paid({ trialEndsOn: '2026-10-23' }), today)).toBe('past_due');
    expect(clubAccessState(paid({ trialEndsOn: '2026-10-10' }), today)).toBe('past_due');
    expect(clubAccessState(paid({ trialEndsOn: '2026-10-09' }), today)).toBe('lapsed');
    expect(clubAccessState(paid({}), today)).toBe('lapsed');
  });

  it('prefers paid over trial, and the later of the two for the grace', () => {
    expect(
      clubAccessState(paid({ trialEndsOn: '2026-11-01', paidUntil: '2026-12-31' }), today),
    ).toBe('active');
    expect(
      clubAccessState(paid({ trialEndsOn: '2026-10-01', paidUntil: '2026-10-20' }), today),
    ).toBe('past_due');
  });

  it('lets the status win over any date', () => {
    for (const status of ['pending', 'suspended', 'archived'] as const) {
      const state = clubAccessState(paid({ status, paidUntil: '2030-01-01' }), today);
      expect(state).toBe(status);
      expect(canWrite(state)).toBe(false);
    }
  });
});

describe('civil dates', () => {
  it('ends a month on the day before the same date, or the month end when clamped', () => {
    expect(membershipEndsOn('2026-01-15', { months: 1 })).toBe('2026-02-14');
    expect(membershipEndsOn('2026-01-31', { months: 1 })).toBe('2026-02-28');
    expect(membershipEndsOn('2026-01-30', { months: 1 })).toBe('2026-02-28');
    expect(membershipEndsOn('2028-01-31', { months: 1 })).toBe('2028-02-29');
    expect(membershipEndsOn('2026-03-31', { months: 1 })).toBe('2026-04-30');
    expect(membershipEndsOn('2026-11-30', { months: 3 })).toBe('2027-02-28');
    expect(membershipEndsOn('2026-10-24', { months: 12 })).toBe('2027-10-23');
  });

  it('counts a day pass as its own day', () => {
    expect(membershipEndsOn('2026-10-24', { days: 1 })).toBe('2026-10-24');
    expect(membershipEndsOn('2026-10-24', { days: 30 })).toBe('2026-11-22');
  });

  it('is DST-proof: day arithmetic never moves across the October fold', () => {
    expect(addDaysIso('2026-10-24', 1)).toBe('2026-10-25');
    expect(addDaysIso('2026-10-25', 1)).toBe('2026-10-26');
    expect(addDaysIso('2026-03-28', 2)).toBe('2026-03-30');
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
  });

  it('round-trips addDays and daysBetween for any offset', () => {
    fc.assert(
      fc.property(fc.integer({ min: -2000, max: 2000 }), (offset) => {
        expect(daysBetween('2026-06-15', addDaysIso('2026-06-15', offset))).toBe(offset);
      }),
    );
  });

  it('clamps addMonths and says so', () => {
    expect(addMonthsIso('2026-01-31', 1)).toEqual(['2026-02-28', true]);
    expect(addMonthsIso('2026-12-15', 2)).toEqual(['2027-02-15', false]);
  });

  it('reads Sofia today, not UTC today', () => {
    // 22:30 UTC on 24 Oct 2026 is already 25 Oct in Sofia (UTC+3 before the fold).
    expect(sofiaToday(new Date('2026-10-24T22:30:00Z'))).toBe('2026-10-25');
    expect(sofiaToday(new Date('2026-10-24T20:30:00Z'))).toBe('2026-10-24');
  });

  it('validates ISO dates strictly', () => {
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('26-01-01')).toBe(false);
  });

  it('keys ISO weeks Monday-first and inverts them', () => {
    expect(isoWeekKey('2026-10-24')).toBe('2026-W43');
    expect(isoWeekKey('2027-01-01')).toBe('2026-W53');
    expect(isoWeekMonday('2026-W43')).toBe('2026-10-19');
    expect(isoWeekMonday('2026-W54')).toBeNull();
    expect(isoWeekMonday('garbage')).toBeNull();
  });
});

describe('money', () => {
  it.each([
    ['50', 5000],
    ['50,5', 5050],
    ['50,50', 5050],
    ['50.05', 5005],
    ['1 200,00', 120000],
    ['1 200', 120000],
    ['35 €', 3500],
    ['EUR 12', 1200],
    ['0', 0],
  ])('parses %s', (input, cents) => {
    expect(parseEuroCents(input)).toBe(cents);
  });

  it.each(['', '-5', '1.200', '1,234', 'abc', '5,5,5', '100001', '12e3'])('refuses %s', (input) => {
    expect(parseEuroCents(input)).toBeNull();
  });

  it('formats by locale', () => {
    expect(formatEuro(5050, 'bg')).toMatch(/50,50\s?€/);
    expect(formatEuro(5050, 'en')).toMatch(/€50\.50/);
  });
});

describe('slugs', () => {
  it('transliterates the Bulgarian name and avoids reserved words', () => {
    expect(clubSlugFrom('Фитнес Изток')).toBe('fitnes-iztok');
    expect(clubSlugFrom('Киоск')).toBe('klub-kiosk');
    expect(clubSlugFrom('!!')).toBe('klub');
    expect(isUsableClubSlug('kiosk')).toBe(false);
    expect(isUsableClubSlug('ab')).toBe(false);
  });

  it('suffixes a taken slug', () => {
    expect(nextFreeClubSlug('fitnes', new Set(['fitnes', 'fitnes-2']))).toBe('fitnes-3');
  });
});

describe('activities', () => {
  it('never overlaps the canonical sports', () => {
    for (const activity of CLUB_ACTIVITIES) {
      expect((CANONICAL_SPORTS as readonly string[]).includes(activity), activity).toBe(false);
    }
  });

  it('fits both the class and the training-log sport shapes', () => {
    for (const activity of CLUB_ACTIVITIES) {
      expect(activity).toMatch(/^[a-z][a-z0-9_]{1,29}$/);
      expect(activity).toMatch(/^[a-z_]{2,40}$/);
    }
  });

  it('folds every activity into a canonical sport for the training log', () => {
    expect(trainingSportFor('yoga')).toBe('fitness');
    expect(trainingSportFor('spinning')).toBe('cycling');
    expect(trainingSportFor('bjj')).toBe('martial_arts');
    expect(trainingSportFor('football')).toBe('football');
    for (const activity of CLUB_ACTIVITIES) {
      expect(CANONICAL_SPORTS).toContain(trainingSportFor(activity));
    }
    expect(isClubSport('yoga')).toBe(true);
    expect(isClubSport('curling')).toBe(false);
  });
});

describe('notification dedupe keys', () => {
  const SHAPE = /^[a-z0-9_]+(:[A-Za-z0-9_-]+)*$/;
  const id = '0b6f5c56-2f0e-4f4e-9a4f-6f6b1a7f8e01';

  it('match club_notifications_dedupe_key_shape for every kind', () => {
    const keys = [
      dedupeKey({ kind: 'booking_confirmed', occurrenceId: id, memberId: id, seq: 42 }),
      dedupeKey({ kind: 'reminder_24h', occurrenceId: id, memberId: id }),
      dedupeKey({ kind: 'membership_expiring', membershipId: id }),
      dedupeKey({ kind: 'staff_invite', inviteId: id }),
      dedupeKey({ kind: 'application_received', clubId: id, userId: 'abcXYZ_09' }),
      dedupeKey({ kind: 'roster_daily', userId: 'abcXYZ_09', day: '2026-10-24' }),
      dedupeKey({ kind: 'owner_weekly', userId: 'abcXYZ_09', week: '2026-W43' }),
    ];
    for (const key of keys) {
      expect(key).toMatch(SHAPE);
      expect(key.length).toBeLessThanOrEqual(200);
    }
  });

  it('confirms a re-booking again: the arrival ticket is in the key', () => {
    const first = dedupeKey({ kind: 'booking_confirmed', occurrenceId: id, memberId: id, seq: 1 });
    const again = dedupeKey({ kind: 'booking_confirmed', occurrenceId: id, memberId: id, seq: 9 });
    expect(first).not.toBe(again);
  });
});
