import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { CANONICAL_SPORTS } from '../sports.js';
import {
  CLUB_ACTIVITIES,
  CLUB_FEATURES,
  CLUB_TIERS,
  classifyImportRows,
  normalizeImportRow,
  parseImportDate,
  phoneKey,
  type ClubImportRow,
  SELF_PAUSE_MAX_DAYS,
  clubHasFeature,
  contractEndsOn,
  engagementBand,
  engagementScore,
  lowestTierWith,
  renewsInto,
  selfBookingBlocked,
  selfPauseRange,
  tierFeatures,
  CLUB_AUDIT_ACTIONS,
  CLUB_AUDIT_ACTOR_KINDS,
  CLUB_CANCEL_REASONS,
  CLUB_CHARGE_KINDS,
  CLUB_PAYMENT_METHODS_ALL,
  CLUB_CHECKIN_METHODS,
  CLUB_NOTIFICATION_KINDS,
  CLUB_PERMISSIONS,
  PASSPORT_CHECKIN_METHODS,
  CLUB_PLAN_AUDIENCES,
  CLUB_PLAN_KINDS,
  CLUB_ROLES,
  addDaysIso,
  addMonthsIso,
  can,
  canWrite,
  clubAccessState,
  daysUntilReadOnly,
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
  advertisedPrice,
  availableSlots,
  bestPromotion,
  normalizePromoCode,
  promotionDiscounts,
  type Promotion,
  parseClock,
  parseClosing,
  intersectSlots,
  priceFor,
  saturatedIntervals,
  serviceDurations,
  type PriceQuery,
  type PriceRule,
  type SlotQuery,
  compactCode,
  documentDate,
  documentRate,
  formatInvoiceNumber,
  invoiceLines,
  invoiceTotals,
  isBgVatNumber,
  isEik,
  isIban,
  isVatNumber,
  splitVat,
  AUDIENCE_FILTERS,
  AUDIENCE_KINDS,
  AUDIENCE_SEGMENTS,
  AUTOMATION_CHANNELS,
  AUTOMATION_TRIGGERS,
  BROADCAST_HOURS,
  BROADCAST_PURPOSES,
  INQUIRY_KINDS,
  LEAD_DESK_SOURCES,
  LEAD_LOST_REASONS,
  LEAD_SOURCES,
  LEAD_STAGES,
  THREAD_KINDS,
  isGoogleReviewUrl,
  publicRatingVisible,
  roundRating,
  BROADCAST_SHARE_OF_BULK,
  CLUB_API_SCOPES,
  gaScriptUrl,
  isTrackingCookie,
  TRACKING_CONSENT_VERSION,
  decodeTrackingConsent,
  encodeTrackingConsent,
  trackingAnswered,
  parseGaMeasurementId,
  parseMetaPixelId,
  trackingConsentKey,
  CLUB_API_SCOPE_PERMISSION,
  CLUB_WEBHOOK_DELIVERY_ERRORS,
  CLUB_WEBHOOK_DELIVERY_STATES,
  CLUB_WEBHOOK_EVENTS,
  CLUB_WEBHOOK_EVENT_SCOPE,
  DOOR_ACCESS_RULES,
  WEBHOOK_MAX_ATTEMPTS,
  webhookRetryAfterSeconds,
  BROADCAST_STATUSES,
  CLUB_CHANNELS,
  CLUB_CONTRACT_BILLING,
  SMS_NOTIFY_KINDS,
  automationChannels,
  automationDefaultDelay,
  automationMaxDelay,
  automationMinDelay,
  automationPurpose,
  composeSms,
  inBroadcastHours,
  personalise,
  EVENT_KINDS,
  EVENT_PAYMENTS,
  EVENT_STATUSES,
  REGISTRATION_STATES,
  MATCH_STATUSES,
  TOURNAMENT_FORMATS,
  DOCUMENT_KINDS,
  DOCUMENT_REQUIRED_FOR,
  SIGNATURE_METHODS,
  SIGNER_KINDS,
  BELT_COLOURS,
  RANK_AWARD_REASONS,
  RANK_TEMPLATES,
  RANK_TEMPLATE_KEYS,
  RANKS_PER_LADDER_MAX,
  RANK_STRIPES_MAX,
  isRankTemplateKey,
  audienceFits,
  lateCancellation,
  registrationOpen,
  ticketPrice,
} from './index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.join(HERE, '..', '..', '..', 'db', 'migrations');

/** Every club migration, 0039 onward, in order. */
function migrationText(): string {
  return readdirSync(MIGRATIONS)
    .filter((name) => /^\d{4}_/.test(name) && Number(name.slice(0, 4)) >= 39)
    .sort()
    .map((name) => readFileSync(path.join(MIGRATIONS, name), 'utf8').replace(/^--.*$/gm, ''))
    .join('\n');
}

/**
 * The quoted values of `"<constraint>" CHECK (... IN (...))` — the LAST
 * definition, since a later migration widens a list by re-creating the
 * constraint under the same name (0045).
 */
function checkValues(constraint: string): string[] {
  const text = migrationText();
  const at = text.lastIndexOf(`"${constraint}" CHECK`);
  expect(at, constraint).toBeGreaterThan(-1);
  const open = text.indexOf(' IN (', at);
  const close = text.indexOf(')', open + 5);
  return [...text.slice(open + 5, close).matchAll(/'([a-z0-9_.]+)'/g)].map((m) => m[1] as string);
}

/** The quoted values of `"<constraint>" CHECK (… <@ ARRAY[…])` — the LAST definition. */
function arrayValues(constraint: string): string[] {
  const text = migrationText();
  const at = text.lastIndexOf(`"${constraint}" CHECK`);
  expect(at, constraint).toBeGreaterThan(-1);
  const array = /ARRAY\[([^\]]*)\]/.exec(text.slice(at));
  return [...(array?.[1] ?? '').matchAll(/'([a-z0-9_.:]+)'/g)].map((m) => m[1] as string);
}

describe('the vocabularies equal their SQL CHECKs', () => {
  it.each([
    ['club_audit_action_known', CLUB_AUDIT_ACTIONS],
    ['club_audit_actor_kind_known', CLUB_AUDIT_ACTOR_KINDS],
    ['club_checkins_method_known', CLUB_CHECKIN_METHODS],
    ['club_charges_kind_known', CLUB_CHARGE_KINDS],
    ['club_payments_method_known', CLUB_PAYMENT_METHODS_ALL],
    ['club_plans_kind_known', CLUB_PLAN_KINDS],
    ['club_plans_audience_known', CLUB_PLAN_AUDIENCES],
    ['club_memberships_cancel_reason_known', CLUB_CANCEL_REASONS],
    ['club_notifications_kind_known', CLUB_NOTIFICATION_KINDS],
    ['clubs_contract_billing_known', CLUB_CONTRACT_BILLING],
    ['club_staff_role_known', CLUB_ROLES],
    ['club_notifications_channel_known', CLUB_CHANNELS],
    ['club_broadcasts_purpose_known', BROADCAST_PURPOSES],
    ['club_broadcasts_status_known', BROADCAST_STATUSES],
    // The first list in the audience CHECK is the segment list.
    ['club_broadcasts_audience_known', AUDIENCE_SEGMENTS],
    ['club_automations_trigger_known', AUTOMATION_TRIGGERS],
    ['club_automations_channel_known', AUTOMATION_CHANNELS],
    ['club_threads_kind_known', THREAD_KINDS],
    ['club_threads_inquiry_kind_known', INQUIRY_KINDS],
    ['club_members_lead_source_known', LEAD_SOURCES],
    ['club_members_lead_lost_reason_known', LEAD_LOST_REASONS],
    ['club_events_kind_known', EVENT_KINDS],
    ['club_events_status_known', EVENT_STATUSES],
    ['club_events_payment_known', EVENT_PAYMENTS],
    ['club_event_registrations_state_known', REGISTRATION_STATES],
    ['club_event_tickets_audience_known', CLUB_PLAN_AUDIENCES],
    ['club_events_tournament_format', TOURNAMENT_FORMATS],
    ['club_tournament_matches_status_known', MATCH_STATUSES],
    ['club_documents_kind_known', DOCUMENT_KINDS],
    ['club_documents_required_known', DOCUMENT_REQUIRED_FOR],
    ['club_document_signatures_signer_known', SIGNER_KINDS],
    ['club_document_signatures_method_known', SIGNATURE_METHODS],
    ['club_ranks_colour_known', BELT_COLOURS],
    ['club_ranks_accent_known', BELT_COLOURS],
    ['club_member_ranks_reason_known', RANK_AWARD_REASONS],
    ['club_webhook_deliveries_event_known', CLUB_WEBHOOK_EVENTS],
    ['club_webhook_deliveries_state_known', CLUB_WEBHOOK_DELIVERY_STATES],
    ['club_webhook_deliveries_error_known', CLUB_WEBHOOK_DELIVERY_ERRORS],
    ['club_kiosk_devices_rule_for_doors', DOOR_ACCESS_RULES],
  ] as const)('%s', (constraint, values) => {
    expect(checkValues(constraint).sort()).toEqual([...values].sort());
  });

  it.each([
    ['club_api_keys_scopes_known', CLUB_API_SCOPES],
    ['club_webhook_endpoints_events_known', CLUB_WEBHOOK_EVENTS],
  ] as const)('%s (an array CHECK)', (constraint, values) => {
    expect(arrayValues(constraint).sort()).toEqual([...values].sort());
  });

  it('the passport methods equal club_checkins_only_scans_reach_the_passport', () => {
    const text = migrationText();
    const at = text.lastIndexOf('"club_checkins_only_scans_reach_the_passport" CHECK');
    const list = /"method" IN \(([^)]*)\)/.exec(text.slice(at));
    expect([...(list?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()).toEqual(
      [...PASSPORT_CHECKIN_METHODS].sort(),
    );
  });

  it('club_broadcasts_audience_known: the filters, and the audience kinds', () => {
    const text = migrationText();
    const at = text.lastIndexOf('"club_broadcasts_audience_known" CHECK');
    const block = text.slice(at, text.indexOf('CONSTRAINT', at + 10));
    const filters = /'filter' AND "club_broadcasts"\."audience_value" IN \(([^)]*)\)/.exec(block);
    expect([...(filters?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()).toEqual(
      [...AUDIENCE_FILTERS].sort(),
    );
    const kinds = [...block.matchAll(/"audience_kind" (?:=|IN \() ?'([a-z]+)'(?:, '([a-z]+)')?/g)]
      .flatMap((m) => [m[1], m[2]])
      .filter(Boolean);
    expect([...new Set(kinds)].sort()).toEqual([...AUDIENCE_KINDS].sort());
  });

  it('club_lead_stages derives exactly LEAD_STAGES', () => {
    const text = migrationText();
    const at = text.lastIndexOf('CREATE VIEW "club_lead_stages"');
    const block = text.slice(at, text.indexOf('END AS stage', at));
    const stages = [...block.matchAll(/(?:THEN|ELSE) '([a-z_]+)'/g)].map((m) => m[1]);
    expect(stages.sort()).toEqual([...LEAD_STAGES].sort());
  });

  it('clubs_sms_notify_known equals SMS_NOTIFY_KINDS', () => {
    const text = migrationText();
    const at = text.lastIndexOf('"clubs_sms_notify_known" CHECK');
    const array = /ARRAY\[([^\]]*)\]/.exec(text.slice(at));
    expect([...(array?.[1] ?? '').matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]).sort()).toEqual(
      [...SMS_NOTIFY_KINDS].sort(),
    );
  });
});

describe('club messages (0051)', () => {
  it('fixes a purpose per trigger: only the welcome is service', () => {
    expect(AUTOMATION_TRIGGERS.filter((t) => automationPurpose(t) === 'service')).toEqual([
      'welcome',
    ]);
    // The request to rate is marketing: it waits for the member's consent.
    expect(automationPurpose('feedback_request')).toBe('marketing');
  });

  it('defaults every trigger to a delay its CHECK admits', () => {
    for (const trigger of AUTOMATION_TRIGGERS) {
      expect(automationDefaultDelay(trigger)).toBeGreaterThanOrEqual(automationMinDelay(trigger));
      expect(automationDefaultDelay(trigger)).toBeLessThanOrEqual(automationMaxDelay(trigger));
    }
  });

  it('holds the per-trigger delay and channel rules equal to their CHECKs (0052)', () => {
    const text = migrationText();
    const delay = text.slice(text.lastIndexOf('"club_automations_delay_sane" CHECK'));
    expect(delay).toMatch(/'win_back' OR "club_automations"\."delay_days" >= 14/);
    expect(delay).toMatch(/'feedback_request' OR "club_automations"\."delay_days" <= 7/);
    expect(automationMinDelay('win_back')).toBe(14);
    expect(automationMaxDelay('feedback_request')).toBe(7);
    expect(text).toContain(
      `"club_automations_feedback_by_email" CHECK ("club_automations"."trigger" <> 'feedback_request' OR "club_automations"."channel" = 'email')`,
    );
    expect(automationChannels('feedback_request')).toEqual(['email']);
    expect(automationChannels('welcome')).toEqual(AUTOMATION_CHANNELS);
  });

  it('keys a broadcast by the receiving record, an automation by the event', () => {
    expect(dedupeKey({ kind: 'broadcast', broadcastId: 'b1', recipientMemberId: 'm1' })).toBe(
      'broadcast:b1:m1',
    );
    expect(
      dedupeKey({ kind: 'automation', trigger: 'win_back', memberId: 'm1', anchor: '2026-10-01' }),
    ).toBe('automation:win_back:m1:2026-10-01');
  });

  it('puts the club first in an SMS and the way out last, for marketing only', () => {
    expect(composeSms({ clubName: 'Зала Сила', text: ' Затворено в понеделник. ' })).toBe(
      'Зала Сила: Затворено в понеделник.',
    );
    expect(
      composeSms({
        clubName: 'Зала Сила',
        text: '−20% този месец',
        optOut: { label: 'Отказ:', url: 'https://pops.bg/s/abc' },
      }),
    ).toBe('Зала Сила: −20% този месец\nОтказ: https://pops.bg/s/abc');
  });

  it('sends in Sofia’s day only, and leaves the automations a real part of the allowance', () => {
    // 07:59 and 21:00 in Sofia (EEST, UTC+3) are outside; 08:00 and 20:59 inside.
    expect(inBroadcastHours(new Date('2026-07-01T04:59:00Z'))).toBe(false);
    expect(inBroadcastHours(new Date('2026-07-01T05:00:00Z'))).toBe(true);
    expect(inBroadcastHours(new Date('2026-07-01T17:59:00Z'))).toBe(true);
    expect(inBroadcastHours(new Date('2026-07-01T18:00:00Z'))).toBe(false);
    // In winter (EET, UTC+2) the same wall clock.
    expect(inBroadcastHours(new Date('2026-12-01T06:00:00Z'))).toBe(true);
    expect(inBroadcastHours(new Date('2026-12-01T19:00:00Z'))).toBe(false);
    expect(BROADCAST_HOURS.from).toBeLessThan(BROADCAST_HOURS.until);
    expect(BROADCAST_SHARE_OF_BULK).toBeGreaterThan(0);
    expect(BROADCAST_SHARE_OF_BULK).toBeLessThanOrEqual(0.8);
  });

  it('fills {name} and {club} and nothing else', () => {
    expect(personalise('Здравейте, {name}! {club} {other}', { name: 'Ана', club: 'Сила' })).toBe(
      'Здравейте, Ана! Сила {other}',
    );
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

  it('treats the community tier like every other: paid, with a trial (2026-10-31)', () => {
    for (const tier of CLUB_TIERS) {
      expect(clubAccessState(paid({ tier }), today), tier).toBe('lapsed');
      expect(clubAccessState(paid({ tier, trialEndsOn: '2026-11-23' }), today), tier).toBe('trial');
      expect(clubAccessState(paid({ tier, paidUntil: '2026-10-31' }), today), tier).toBe('active');
      expect(daysUntilReadOnly(paid({ tier, trialEndsOn: '2026-10-30' }), today), tier).toBe(20);
    }
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

describe('the tier feature matrix', () => {
  it('only ever adds features going up a tier', () => {
    for (const feature of CLUB_FEATURES) {
      if (clubHasFeature('community', feature))
        expect(clubHasFeature('standard', feature)).toBe(true);
      if (clubHasFeature('standard', feature)) expect(clubHasFeature('pro', feature)).toBe(true);
    }
  });

  it('gives pro every feature and community none of the gated ones', () => {
    expect(tierFeatures('pro')).toEqual(CLUB_FEATURES);
    expect(tierFeatures('community')).toEqual([]);
  });

  it('keeps the integrations on pro and the shop on standard', () => {
    for (const feature of ['api', 'webhooks', 'mcp', 'door_access'] as const) {
      expect(lowestTierWith(feature), feature).toBe('pro');
    }
    expect(lowestTierWith('shop')).toBe('standard');
    expect(lowestTierWith('sms')).toBe('standard');
  });

  it('names a lowest tier that really has the feature', () => {
    for (const feature of CLUB_FEATURES) {
      expect(clubHasFeature(lowestTierWith(feature), feature)).toBe(true);
    }
    expect(CLUB_TIERS).toContain(lowestTierWith('pixels'));
  });
});

describe('membership policies', () => {
  it('keeps renewing the period that starts inside the notice', () => {
    const last = contractEndsOn('2026-10-25', {
      noticeDays: 30,
      minTermMonths: null,
      termStartedOn: null,
    });
    expect(last).toBe('2026-11-24');
    expect(renewsInto('2026-11-01', last)).toBe(true);
    expect(renewsInto('2026-12-01', last)).toBe(false);
  });

  it('runs to the end of the minimum term when that is later', () => {
    const last = contractEndsOn('2026-03-10', {
      noticeDays: 14,
      minTermMonths: 12,
      termStartedOn: '2026-01-01',
    });
    expect(last).toBe('2026-12-31');
  });

  it('renews forever while no notice was given', () => {
    expect(renewsInto('2099-01-01', null)).toBe(true);
  });

  it('never gives a contract end before today', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 120 }),
        fc.integer({ min: 0, max: 36 }),
        (notice, term) => {
          const today = '2026-06-15';
          const last = contractEndsOn(today, {
            noticeDays: notice,
            minTermMonths: term === 0 ? null : term,
            termStartedOn: '2026-01-31',
          });
          return last >= today;
        },
      ),
    );
  });

  it("bounds a member's own pause", () => {
    expect(selfPauseRange({ startsOn: '2026-10-26', days: 7 }, '2026-10-25')).toEqual({
      startsOn: '2026-10-26',
      endsOn: '2026-11-01',
    });
    expect(selfPauseRange({ startsOn: '2026-10-24', days: 7 }, '2026-10-25')).toBeNull();
    expect(
      selfPauseRange({ startsOn: '2026-10-25', days: SELF_PAUSE_MAX_DAYS + 1 }, '2026-10-25'),
    ).toBeNull();
    expect(selfPauseRange({ startsOn: '2026-10-25', days: 0 }, '2026-10-25')).toBeNull();
  });

  it('blocks self-booking only at the limit, and never without a rule', () => {
    expect(selfBookingBlocked(2, 3)).toBe(false);
    expect(selfBookingBlocked(3, 3)).toBe(true);
    expect(selfBookingBlocked(99, null)).toBe(false);
  });
});

describe('the engagement score', () => {
  it('is 100 for a fresh, frequent, long-standing member and 0 for a stranger', () => {
    expect(
      engagementScore({ daysSinceLastVisit: 1, visitsLast30Days: 12, monthsAsMember: 24 }),
    ).toBe(100);
    expect(
      engagementScore({ daysSinceLastVisit: null, visitsLast30Days: 0, monthsAsMember: 0 }),
    ).toBe(0);
  });

  it('stays within 0..100 and falls as the last visit ages', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 400 }),
        fc.integer({ min: 0, max: 60 }),
        fc.integer({ min: 0, max: 120 }),
        (days, visits, months) => {
          const score = engagementScore({
            daysSinceLastVisit: days,
            visitsLast30Days: visits,
            monthsAsMember: months,
          });
          const older = engagementScore({
            daysSinceLastVisit: days + 5,
            visitsLast30Days: visits,
            monthsAsMember: months,
          });
          return score >= 0 && score <= 100 && older <= score;
        },
      ),
    );
  });

  it('bands the score into words', () => {
    expect(engagementBand(70)).toBe('high');
    expect(engagementBand(69)).toBe('medium');
    expect(engagementBand(39)).toBe('low');
  });
});

describe('the member import', () => {
  const row = (fields: Record<string, string>, line = 2): ClubImportRow => {
    const result = normalizeImportRow(line, fields);
    if (!result.ok) throw new Error(result.errors.join(','));
    return result.row;
  };

  it('reads Bulgarian and ISO dates, and refuses impossible ones', () => {
    expect(parseImportDate('01.10.2026')).toBe('2026-10-01');
    expect(parseImportDate('5/3/2026')).toBe('2026-03-05');
    expect(parseImportDate('2026-10-01')).toBe('2026-10-01');
    expect(parseImportDate('31.02.2026')).toBeNull();
    expect(parseImportDate('утре')).toBeNull();
  });

  it('normalises a row and reports every problem at once', () => {
    const ok = row({
      name: '  Мария   Петрова ',
      email: 'MARIA@Example.org',
      tags: 'Сутрин; Йога|сутрин',
      plan: 'Месечен',
      startsOn: '01.10.2026',
      paid: '45,50 €',
      minor: 'не',
    });
    expect(ok).toMatchObject({
      displayName: 'Мария Петрова',
      email: 'maria@example.org',
      tags: ['Сутрин', 'Йога'],
      paidCents: 4550,
      isMinor: false,
    });
    const bad = normalizeImportRow(3, {
      name: '',
      email: 'no-at-sign',
      startsOn: '2026-10-05',
      endsOn: '2026-10-01',
      guardianEmail: 'p@example.org',
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors).toEqual(
        expect.arrayContaining([
          'name_required',
          'email_invalid',
          'dates_reversed',
          'plan_required',
          'guardian_only_for_minors',
        ]),
      );
    }
  });

  it('never reads a date of birth: a minor is a yes/no column', () => {
    expect(row({ name: 'Иван', minor: 'да' }).isMinor).toBe(true);
    expect(row({ name: 'Иван', minor: '2015-04-01' }).isMinor).toBe(false);
  });

  it('compares phones by digits, with 0 read as +359', () => {
    expect(phoneKey('0888 123 456')).toBe(phoneKey('+359 888 123 456'));
    expect(phoneKey('00359888123456')).toBe('359888123456');
  });

  it('matches only when one record is unambiguous, and prefers a conflict', () => {
    const adult = (id: string, email: string | null, phone: string | null) => ({
      id,
      displayName: `Член ${id}`,
      email,
      phone,
      isMinor: false,
      guardianEmail: null,
    });
    const existing = [
      adult('a', 'maria@example.org', '0888123456'),
      adult('b', 'ivan@example.org', null),
      adult('c', 'twin@example.org', null),
      adult('d', 'twin@example.org', null),
      adult('e', null, '0899000111'),
    ];
    const rows = [
      row({ name: 'Мария', email: 'maria@example.org', phone: '+359888123456' }),
      row({ name: 'Иван', email: 'ivan@example.org', phone: '0888123456' }),
      row({ name: 'Близнак', email: 'twin@example.org' }),
      row({ name: 'Без имейл', phone: '0899 000 111' }),
      row({ name: 'Нов', email: 'new@example.org', phone: '0899000111' }),
      row({ name: 'Съвсем нов', email: 'fresh@example.org' }),
      row({ name: 'Дете', minor: 'да', guardianEmail: 'maria@example.org' }),
    ];
    expect(classifyImportRows(rows, existing)).toEqual([
      { kind: 'match', memberId: 'a' },
      { kind: 'conflict', reason: 'email_phone_disagree' },
      { kind: 'conflict', reason: 'several_records' },
      { kind: 'match', memberId: 'e' },
      { kind: 'conflict', reason: 'email_phone_disagree' },
      { kind: 'new' },
      { kind: 'new' },
    ]);
  });

  it('matches a child by name under the guardian, and holds a known name for a human', () => {
    const existing = [
      {
        id: 'k1',
        displayName: 'Иван Петров',
        email: null,
        phone: null,
        isMinor: true,
        guardianEmail: 'maria@example.org',
      },
      {
        id: 'a1',
        displayName: 'Георги Георгиев',
        email: null,
        phone: null,
        isMinor: false,
        guardianEmail: null,
      },
    ];
    const rows = [
      row({ name: 'иван  петров', minor: 'да', guardianEmail: 'maria@example.org' }),
      row({ name: 'Иван Петров', minor: 'да', guardianEmail: 'other@example.org' }),
      row({ name: 'Георги Георгиев' }),
      row({ name: 'Нов Човек' }),
    ];
    expect(classifyImportRows(rows, existing)).toEqual([
      { kind: 'match', memberId: 'k1' },
      { kind: 'new' },
      { kind: 'conflict', reason: 'name_exists' },
      { kind: 'new' },
    ]);
  });

  it('refuses leva instead of reading them as euros', () => {
    const result = normalizeImportRow(2, { name: 'Мария', plan: 'Месечен', paid: '50 лв.' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain('currency_bgn');
    expect(row({ name: 'Мария', plan: 'Месечен', paid: '25,56 €' }).paidCents).toBe(2556);
  });

  it('holds both copies of a person repeated in one file', () => {
    const rows = [
      row({ name: 'Мария', email: 'maria@example.org' }),
      row({ name: 'Мария П.', email: 'maria@example.org' }, 3),
    ];
    expect(classifyImportRows(rows, []).map((c) => c.kind)).toEqual(['conflict', 'conflict']);
  });
});

describe('the slot engine (0048)', () => {
  const day = (overrides: Partial<SlotQuery> = {}): SlotQuery => ({
    date: '2026-11-02',
    timeZone: 'Europe/Sofia',
    hours: { opens: '09:00', closes: '12:00' },
    durationMinutes: 60,
    stepMinutes: 30,
    bufferMinutes: 0,
    busy: [],
    notBefore: 0,
    ...overrides,
  });
  const at = (local: string) => new Date(`2026-11-02T${local}:00+02:00`).getTime();

  it('steps through the opening hours and stops where a session would outrun closing', () => {
    expect(availableSlots(day()).map((s) => s.local)).toEqual([
      '09:00',
      '09:30',
      '10:00',
      '10:30',
      '11:00',
    ]);
  });

  it('skips what overlaps busy time, half-open, and honours the buffer', () => {
    const busy = [{ start: at('10:00'), end: at('11:00') }];
    expect(availableSlots(day({ busy })).map((s) => s.local)).toEqual(['09:00', '11:00']);
    // 15 minutes of turnover: 09:00–10:00 now runs into 10:00.
    expect(availableSlots(day({ busy, bufferMinutes: 15 })).map((s) => s.local)).toEqual(['11:00']);
  });

  it('never offers the past, nor a closed day', () => {
    expect(availableSlots(day({ notBefore: at('10:15') })).map((s) => s.local)).toEqual([
      '10:30',
      '11:00',
    ]);
    expect(availableSlots(day({ hours: null }))).toEqual([]);
  });

  it('never offers a start the spring-forward gap removes', () => {
    const slots = availableSlots(
      day({ date: '2026-03-29', hours: { opens: '01:00', closes: '06:00' } }),
    );
    expect(slots.some((s) => s.local.startsWith('03:'))).toBe(false);
    // 02:30 + 60 real minutes ends at 04:30 on the moved clock.
    const late = slots.find((s) => s.local === '02:30');
    expect(late && late.endsAt.getTime() - late.startsAt.getTime()).toBe(60 * 60_000);
  });

  it('offers an ambiguous autumn start once, at its first occurrence', () => {
    const slots = availableSlots(
      day({ date: '2026-10-25', hours: { opens: '02:00', closes: '06:00' } }),
    );
    expect(slots.filter((s) => s.local === '03:30')).toHaveLength(1);
  });

  it('finds when a pool is fully taken, not merely busy', () => {
    const h = (n: number) => n * 3_600_000;
    const taken = saturatedIntervals(
      [
        { start: h(9), end: h(11) },
        { start: h(11), end: h(13) },
        { start: h(10), end: h(12) },
      ],
      2,
    );
    // Two rackets: both out only 10–12 (9–11 hands over to 11–13 at 11).
    expect(taken).toEqual([{ start: h(10), end: h(12) }]);
    expect(saturatedIntervals([{ start: h(9), end: h(10) }], 2)).toEqual([]);
    // A closure takes every unit at once.
    expect(saturatedIntervals([{ start: h(9), end: h(10), units: 2 }], 2)).toEqual([
      { start: h(9), end: h(10) },
    ]);
  });

  it('sells the last hour before midnight, written 24:00 or 00:00', () => {
    expect(parseClosing('00:00')).toBe(24 * 60);
    expect(parseClosing('24:00')).toBe(24 * 60);
    expect(parseClosing('22:30')).toBe(22 * 60 + 30);
    expect(parseClock('24:00')).toBeNull();
    for (const closes of ['24:00', '00:00']) {
      const slots = availableSlots(day({ hours: { opens: '22:00', closes }, stepMinutes: 60 }));
      expect(slots.map((s) => s.local)).toEqual(['22:00', '23:00']);
      expect(slots.at(-1)?.endsAt.toISOString()).toBe('2026-11-02T22:00:00.000Z');
    }
  });

  it('intersects a trainer and a room by wall clock, and lists the durations sold', () => {
    const room = availableSlots(day({ busy: [{ start: at('09:00'), end: at('10:00') }] }));
    const trainer = availableSlots(day({ busy: [{ start: at('11:00'), end: at('12:00') }] }));
    expect(intersectSlots([room, trainer]).map((s) => s.local)).toEqual(['10:00']);
    expect(serviceDurations(60, 120, 30)).toEqual([60, 90, 120]);
  });
});

describe('booking prices (0048)', () => {
  const peak: PriceRule = {
    weekdays: [1, 2, 3, 4, 5],
    from: '18:00',
    to: '22:00',
    priceCents: 3000,
    memberPriceCents: 2500,
    priority: 1,
  };
  const query = (overrides: Partial<PriceQuery> = {}): PriceQuery => ({
    unit: 'hour',
    baseCents: 2000,
    memberBaseCents: null,
    rules: [peak],
    weekday: 1,
    startLocal: '17:30',
    durationMinutes: 90,
    member: false,
    ...overrides,
  });

  it('prices each minute by the rule covering it', () => {
    // 30 off-peak minutes at €20/h and 60 peak minutes at €30/h.
    expect(priceFor(query())).toBe(4000);
    expect(priceFor(query({ member: true }))).toBe(1000 + 2500);
    expect(priceFor(query({ weekday: 6 }))).toBe(3000);
  });

  it('sums whole rates and rounds once, and a rule may run to midnight', () => {
    // 7 minutes at €0.70/h: 70 × 7 / 60 = 8.1666… → 8 cents, not a float drift.
    expect(
      priceFor(query({ baseCents: 70, rules: [], startLocal: '10:00', durationMinutes: 7 })),
    ).toBe(8);
    const lateNight: PriceRule = { ...peak, from: '22:00', to: '24:00', priceCents: 1000 };
    expect(priceFor(query({ rules: [lateNight], startLocal: '23:00', durationMinutes: 60 }))).toBe(
      1000,
    );
  });

  it('prices a booking by its start, and the highest priority wins', () => {
    expect(priceFor(query({ unit: 'booking', startLocal: '18:30' }))).toBe(3000);
    expect(priceFor(query({ unit: 'booking' }))).toBe(2000);
    const happyHour: PriceRule = {
      ...peak,
      from: '18:00',
      to: '19:00',
      priceCents: 1500,
      priority: 5,
    };
    expect(
      priceFor(query({ unit: 'booking', startLocal: '18:15', rules: [peak, happyHour] })),
    ).toBe(1500);
  });

  it('refuses an unreadable start', () => {
    expect(priceFor(query({ startLocal: '25:00' }))).toBeNull();
  });
});

describe('club offers (0049)', () => {
  const offer = (overrides: Partial<Promotion> = {}): Promotion => ({
    id: 'p1',
    name: 'Оферта',
    code: null,
    kind: 'percent',
    value: 1000,
    target: 'all',
    targetIds: null,
    startsOn: '2026-11-01',
    endsOn: '2026-11-30',
    maxUses: null,
    perMemberMax: null,
    newMembersOnly: false,
    minVisits90d: null,
    uses: 0,
    ...overrides,
  });
  const plan = { kind: 'plan' as const, id: 'plan-1', unitPriceCents: 5000, quantity: 1 };
  const water = { kind: 'product' as const, id: 'water', unitPriceCents: 150, quantity: 3 };
  const bar = { kind: 'product' as const, id: 'bar', unitPriceCents: 299, quantity: 1 };
  const buyer = { isNew: false, visits90d: 12, usesByPromotion: {} };

  it('normalises a typed code, and refuses what cannot be one', () => {
    expect(normalizePromoCode('  summer-26 ')).toBe('SUMMER-26');
    expect(normalizePromoCode('ab')).toBeNull();
    expect(normalizePromoCode('лято')).toBeNull();
  });

  it('takes percent and fixed price per line, and an amount once, to the cent', () => {
    expect(promotionDiscounts(offer(), [plan, water])).toEqual([500, 45]);
    expect(
      promotionDiscounts(offer({ kind: 'fixed_price', value: 100, target: 'products' }), [
        plan,
        water,
      ]),
    ).toEqual([0, 150]);
    // €2 off 450 + 299: shared in proportion, adding up exactly.
    const shared = promotionDiscounts(offer({ kind: 'amount', value: 200, target: 'products' }), [
      water,
      bar,
    ]);
    expect(shared.reduce((a, b) => a + b, 0)).toBe(200);
    expect(shared).toEqual([120, 80]);
    // Never below zero: €100 off a €7.49 basket takes it to nothing.
    expect(
      promotionDiscounts(offer({ kind: 'amount', value: 10_000, target: 'products' }), [
        water,
        bar,
      ]),
    ).toEqual([450, 299]);
  });

  it('applies only within its window, its targets and its caps', () => {
    const today = '2026-11-10';
    const pick = (p: Promotion, who = buyer as typeof buyer | null, code: string | null = null) =>
      bestPromotion([p], [plan], who, today, code).applied?.totalDiscountCents ?? 0;
    expect(pick(offer())).toBe(500);
    expect(pick(offer({ endsOn: '2026-11-09' }))).toBe(0);
    expect(pick(offer({ target: 'products' }))).toBe(0);
    expect(pick(offer({ targetIds: ['plan-2'] }))).toBe(0);
    expect(pick(offer({ maxUses: 3, uses: 3 }))).toBe(0);
    expect(pick(offer({ perMemberMax: 1 }), { ...buyer, usesByPromotion: { p1: 1 } })).toBe(0);
    // Conditions about the buyer never open to a walk-in.
    expect(pick(offer({ perMemberMax: 1 }), null)).toBe(0);
    expect(pick(offer({ newMembersOnly: true }))).toBe(0);
    expect(pick(offer({ newMembersOnly: true }), { ...buyer, isNew: true })).toBe(500);
    expect(pick(offer({ minVisits90d: 20 }))).toBe(0);
    expect(pick(offer({ minVisits90d: 10 }))).toBe(500);
  });

  it('gives one offer — the best — and says when a typed code gave nothing', () => {
    const today = '2026-11-10';
    const auto = offer({ id: 'auto', value: 1000 });
    const coded = offer({ id: 'code', code: 'VIP', value: 2000 });
    expect(bestPromotion([auto, coded], [plan], buyer, today, 'VIP').applied?.promotion.id).toBe(
      'code',
    );
    expect(bestPromotion([auto, coded], [plan], buyer, today, null).applied?.promotion.id).toBe(
      'auto',
    );
    expect(bestPromotion([auto, coded], [plan], buyer, today, 'NOPE')).toMatchObject({
      codeRejected: true,
    });
    // A tie goes to the code the buyer typed.
    const same = offer({ id: 'same', code: 'SAME', value: 1000 });
    expect(bestPromotion([auto, same], [plan], buyer, today, 'SAME').applied?.promotion.id).toBe(
      'same',
    );
  });

  it('advertises only automatic offers open to a new visitor', () => {
    const today = '2026-11-10';
    expect(advertisedPrice([offer({ newMembersOnly: true })], plan, today)?.priceCents).toBe(4500);
    expect(advertisedPrice([offer({ minVisits90d: 5 })], plan, today)).toBeNull();
    expect(advertisedPrice([offer({ code: 'X12' })], plan, today)).toBeNull();
  });
});

describe('invoices (0050)', () => {
  it('splits gross into base and VAT that add up to the cent', () => {
    expect(splitVat(1200, 2000)).toEqual({ baseCents: 1000, vatCents: 200 });
    expect(splitVat(999, 2000)).toEqual({ baseCents: 833, vatCents: 166 });
    expect(splitVat(1090, 900)).toEqual({ baseCents: 1000, vatCents: 90 });
    expect(splitVat(500, 0)).toEqual({ baseCents: 500, vatCents: 0 });
    expect(splitVat(500, null)).toEqual({ baseCents: 500, vatCents: 0 });
    for (let total = 0; total < 3000; total += 7) {
      const { baseCents, vatCents } = splitVat(total, 2000);
      expect(baseCents + vatCents).toBe(total);
    }
  });

  it('prices lines by their own rate, the default, or none without registration', () => {
    const inputs = [
      { description: 'Вода', quantity: 2, unitPriceCents: 150, discountCents: 30, vatRateBp: 2000 },
      {
        description: 'Абонамент',
        quantity: 1,
        unitPriceCents: 4000,
        discountCents: 0,
        vatRateBp: null,
      },
    ] as const;
    const registered = invoiceLines(inputs, { vatRegistered: true, defaultVatBp: 900 });
    expect(registered.map((l) => [l.vatRateBp, l.totalCents, l.baseCents, l.vatCents])).toEqual([
      [2000, 270, 225, 45],
      [900, 4000, 3670, 330],
    ]);
    const totals = invoiceTotals(registered);
    expect(totals).toMatchObject({ totalCents: 4270, baseCents: 3895, vatCents: 375 });
    expect(totals.byRate.map((r) => r.vatRateBp)).toEqual([2000, 900]);
    const plain = invoiceLines(inputs, { vatRegistered: false, defaultVatBp: 2000 });
    expect(plain.every((l) => l.vatRateBp === null && l.vatCents === 0)).toBe(true);
    expect(invoiceTotals(plain)).toMatchObject({ totalCents: 4270, baseCents: 4270, vatCents: 0 });
  });

  it('numbers, identifiers and accounts', () => {
    expect(formatInvoiceNumber(42)).toBe('0000000042');
    expect(isEik('123456789')).toBe(true);
    expect(isEik('1234567890123')).toBe(true);
    expect(isEik('12345678')).toBe(false);
    expect(isBgVatNumber('BG123456789')).toBe(true);
    expect(isBgVatNumber('DE123456789')).toBe(false);
    expect(isVatNumber('DE123456789')).toBe(true);
    expect(compactCode(' bg80 bnbg-9661 1020 3456 78 ')).toBe('BG80BNBG96611020345678');
    expect(isIban('BG80BNBG96611020345678')).toBe(true);
    expect(isIban('GB82WEST12345698765432')).toBe(true);
    expect(isIban('BG81BNBG96611020345678')).toBe(false);
    expect(isIban('BG80BNBG9661')).toBe(false);
  });

  it('prints a document date and rate the Bulgarian way', () => {
    expect(documentDate('2026-10-25')).toBe('25.10.2026 г.');
    expect(documentRate(2000)).toBe('20 %');
    expect(documentRate(900)).toBe('9 %');
  });
});

describe('inbox, prospects and ratings (0052)', () => {
  it('lets the desk pick every source but the two the system writes', () => {
    expect(LEAD_DESK_SOURCES.every((source) => LEAD_SOURCES.includes(source))).toBe(true);
    expect(LEAD_SOURCES.filter((source) => !LEAD_DESK_SOURCES.includes(source as never))).toEqual([
      'inquiry',
      'trial',
    ]);
  });

  it('admits only the review-link shapes Google hands a business', () => {
    for (const ok of [
      'https://g.page/r/CbX1abc_-9/review',
      'https://maps.app.goo.gl/AbCdEf123',
      'https://search.google.com/local/writereview?placeid=ChIJ123abc',
    ]) {
      expect(isGoogleReviewUrl(ok), ok).toBe(true);
    }
    for (const bad of [
      'http://g.page/r/CbX1abc/review',
      'https://g.page/r/CbX1abc/review?x=1',
      'https://g.page.evil.example/r/CbX1abc/review',
      'https://www.google.com/amp/s/evil.example',
      'https://www.google.com/url?q=https://evil.example',
      'https://www.google.com/maps/place/x',
      'https://search.google.com/local/writereview?placeid=ChIJ1&next=https://evil.example',
      'https://maps.app.goo.gl/AbC/../x',
      'javascript:alert(1)',
      `https://g.page/r/${'x'.repeat(121)}/review`,
    ]) {
      expect(isGoogleReviewUrl(bad), bad).toBe(false);
    }
  });

  it('shows a public average only from five ratings, to one decimal', () => {
    expect(publicRatingVisible(4)).toBe(false);
    expect(publicRatingVisible(5)).toBe(true);
    expect(roundRating(4.449)).toBe(4.4);
    expect(roundRating(4.45)).toBe(4.5);
  });
});

describe('event places (0053)', () => {
  const at = (iso: string) => new Date(iso);

  it('charges the member price only to a client with a live abonnement, and only where set', () => {
    expect(ticketPrice({ priceCents: 3000, memberPriceCents: 2000 }, true)).toBe(2000);
    expect(ticketPrice({ priceCents: 3000, memberPriceCents: 2000 }, false)).toBe(3000);
    expect(ticketPrice({ priceCents: 3000, memberPriceCents: null }, true)).toBe(3000);
  });

  it('opens registration from its opening until it closes — by default, the start', () => {
    const event = {
      status: 'published' as const,
      startsAt: at('2030-06-01T08:00:00Z'),
      registrationOpensAt: at('2030-05-01T00:00:00Z'),
      registrationClosesAt: null,
    };
    expect(registrationOpen(event, at('2030-04-30T23:59:59Z'))).toBe(false);
    expect(registrationOpen(event, at('2030-05-01T00:00:00Z'))).toBe(true);
    expect(registrationOpen(event, at('2030-06-01T07:59:59Z'))).toBe(true);
    expect(registrationOpen(event, at('2030-06-01T08:00:00Z'))).toBe(false);
    expect(
      registrationOpen(
        { ...event, registrationClosesAt: at('2030-05-20T00:00:00Z') },
        at('2030-05-25T00:00:00Z'),
      ),
    ).toBe(false);
    expect(registrationOpen({ ...event, status: 'draft' }, at('2030-05-10T00:00:00Z'))).toBe(false);
    expect(registrationOpen({ ...event, status: 'cancelled' }, at('2030-05-10T00:00:00Z'))).toBe(
      false,
    );
  });

  it('is late only past the deadline', () => {
    const starts = at('2030-06-01T08:00:00Z');
    expect(lateCancellation(starts, 48, at('2030-05-30T08:00:00Z'))).toBe(false);
    expect(lateCancellation(starts, 48, at('2030-05-30T08:00:01Z'))).toBe(true);
    expect(lateCancellation(starts, 0, at('2030-06-01T07:59:59Z'))).toBe(false);
  });

  it('fits a ticket to its audience', () => {
    expect(audienceFits('all', true)).toBe(true);
    expect(audienceFits('adults', false)).toBe(true);
    expect(audienceFits('adults', true)).toBe(false);
    expect(audienceFits('minors', true)).toBe(true);
    expect(audienceFits('minors', false)).toBe(false);
  });
});

describe('rank templates (0056)', () => {
  it.each(RANK_TEMPLATE_KEYS)('%s is a ladder the database accepts', (key) => {
    const template = RANK_TEMPLATES[key];
    expect(isClubSport(template.sport)).toBe(true);
    expect(template.ranks.length).toBeGreaterThan(1);
    expect(template.ranks.length).toBeLessThanOrEqual(RANKS_PER_LADDER_MAX);
    const keys = template.ranks.map((rank) => rank.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const rank of template.ranks as readonly {
      key: string;
      colour: string;
      accent?: string;
      stripes?: number;
    }[]) {
      expect(rank.key).toMatch(/^[a-z][a-z0-9]*$/);
      expect(BELT_COLOURS).toContain(rank.colour);
      if (rank.accent !== undefined) {
        expect(BELT_COLOURS).toContain(rank.accent);
        expect(rank.accent).not.toBe(rank.colour);
      }
      expect(rank.stripes ?? 0).toBeLessThanOrEqual(RANK_STRIPES_MAX);
    }
  });

  it('knows only its own keys', () => {
    expect(isRankTemplateKey('judo')).toBe(true);
    expect(isRankTemplateKey('toString')).toBe(false);
    expect(isRankTemplateKey('')).toBe(false);
  });
});

describe('the club API and webhooks (0057)', () => {
  it('names a real office permission for every scope', () => {
    for (const scope of CLUB_API_SCOPES) {
      expect(CLUB_PERMISSIONS).toContain(CLUB_API_SCOPE_PERMISSION[scope]);
    }
    expect(Object.keys(CLUB_API_SCOPE_PERMISSION).sort()).toEqual([...CLUB_API_SCOPES].sort());
  });

  it('names the scope that fetches what every event points at', () => {
    for (const event of CLUB_WEBHOOK_EVENTS) {
      expect(CLUB_API_SCOPES).toContain(CLUB_WEBHOOK_EVENT_SCOPE[event]);
    }
  });

  it('a read scope never stands for a write permission', () => {
    for (const scope of CLUB_API_SCOPES.filter((s) => s.endsWith(':read'))) {
      expect(CLUB_API_SCOPE_PERMISSION[scope]).toMatch(/\.view$/);
    }
  });

  it('backs off over about a day and a half, then gives up', () => {
    const waits: number[] = [];
    for (let attempts = 1; attempts < WEBHOOK_MAX_ATTEMPTS; attempts += 1) {
      const wait = webhookRetryAfterSeconds(attempts);
      expect(wait).not.toBeNull();
      waits.push(wait ?? 0);
    }
    expect(waits).toEqual([...waits].sort((a, b) => a - b));
    const total = waits.reduce((sum, wait) => sum + wait, 0);
    expect(total).toBeGreaterThan(24 * 3600);
    expect(total).toBeLessThan(48 * 3600);
    expect(webhookRetryAfterSeconds(WEBHOOK_MAX_ATTEMPTS)).toBeNull();
    expect(webhookRetryAfterSeconds(WEBHOOK_MAX_ATTEMPTS + 3)).toBeNull();
    expect(webhookRetryAfterSeconds(0)).toBe(60);
  });

  it('can never record more attempts than the CHECK admits', () => {
    expect(WEBHOOK_MAX_ATTEMPTS).toBeLessThanOrEqual(50);
  });
});

describe('club tracking ids (0058)', () => {
  it('accepts a GA4 measurement id, forgiving case and spaces', () => {
    expect(parseGaMeasurementId(' g-ab12cd34 ')).toBe('G-AB12CD34');
    expect(parseGaMeasurementId('')).toBeNull();
    for (const bad of [
      'UA-12345-1',
      'GTM-ABC123',
      'G-',
      'G-ABC',
      'G-<script>',
      'G-ABCDEFGHIJKLM',
    ]) {
      expect(parseGaMeasurementId(bad), bad).toBe('invalid');
    }
  });

  it('accepts a Meta Pixel id of digits only', () => {
    expect(parseMetaPixelId('1234 5678 9012')).toBe('123456789012');
    expect(parseMetaPixelId('  ')).toBeNull();
    for (const bad of ['12345', '1'.repeat(21), '12345a', 'fbq(1)']) {
      expect(parseMetaPixelId(bad), bad).toBe('invalid');
    }
  });

  it('builds the vendor address itself, from an id', () => {
    expect(gaScriptUrl('G-AB12CD34')).toBe(
      'https://www.googletagmanager.com/gtag/js?id=G-AB12CD34',
    );
  });

  it("keeps one answer per club, and knows the vendors' cookies", () => {
    expect(trackingConsentKey('a')).not.toBe(trackingConsentKey('b'));
    for (const name of ['_ga', '_ga_ABC123', '_gcl_au', '_gcl_aw', '_gac_UA-1', '_fbp', '_fbc'])
      expect(isTrackingCookie(name)).toBe(true);
    for (const name of ['pops_session', 'better-auth.session_token', 'galaxy', '_gclid']) {
      expect(isTrackingCookie(name)).toBe(false);
    }
  });

  it('remembers each tool’s answer for a year, under one wording, then asks again', () => {
    const given = new Date('2026-10-30T12:00:00Z');
    const stored = encodeTrackingConsent({ ga: true, meta: false }, given);
    expect(decodeTrackingConsent(stored, given)).toEqual({ ga: true, meta: false });
    expect(decodeTrackingConsent(stored, new Date('2027-10-29T12:00:00Z'))).toEqual({
      ga: true,
      meta: false,
    });
    expect(decodeTrackingConsent(stored, new Date('2027-10-30T12:00:00Z'))).toBeNull();
    // Anything else is no answer: the banner asks.
    for (const raw of [
      null,
      'granted',
      '{}',
      '{"answer":"granted","at":"2026-10-30"}',
      `{"v":${TRACKING_CONSENT_VERSION + 1},"at":"2026-10-30","ga":true}`,
      `{"v":${TRACKING_CONSENT_VERSION},"at":"2099-01-01","ga":true}`,
      'not json',
    ]) {
      expect(decodeTrackingConsent(raw, given), String(raw)).toBeNull();
    }
  });

  it('asks again for a tool the visitor never answered for', () => {
    const gaOnly = { ga: true };
    expect(trackingAnswered(gaOnly, ['ga'])).toBe(true);
    // The club added Meta later: an old yes to measurement is not a yes to ads.
    expect(trackingAnswered(gaOnly, ['ga', 'meta'])).toBe(false);
    expect(trackingAnswered({ ga: false, meta: false }, ['ga', 'meta'])).toBe(true);
    expect(trackingAnswered(null, ['ga'])).toBe(false);
  });
});
