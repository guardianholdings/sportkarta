import type { ClubFeature } from './features.js';

/**
 * The complete catalogue of what the «Клубове» add-on does — every function,
 * grouped by the area of the office it lives in. The clubs page renders it
 * (apps/web/app/[locale]/za-klubove), so a function cannot be left off the
 * page by forgetting it: catalogue.test.ts proves every tier-gated feature in
 * features.ts has a row here, and the web i18n test proves every row has its
 * title and line in the catalogue of messages.
 *
 * A row names what gates it, and nothing else — the labels live in
 * `ClubsLanding.catalogue.<area>.rows.<key>` (bg is the source):
 *   - `feature`: the tier matrix entry (features.ts) — the page shows the
 *     cheapest tier that includes it;
 *   - `service`: the outside service the row depends on, for rows that every
 *     tier has but the operator may not have switched on yet (online
 *     payments, push) — the page marks it «скоро» while the switch is off.
 * A row with a `feature` that itself needs a service (shop, SMS, pixels, the
 * API) is marked «скоро» by that feature's own mapping in
 * apps/web/lib/clubs/features.ts; it carries no `service` here.
 */

export const CLUB_SERVICES = ['payments', 'push', 'sms', 'pixels', 'shop', 'api'] as const;
export type ClubService = (typeof CLUB_SERVICES)[number];

export interface CatalogueRow {
  key: string;
  feature?: ClubFeature;
  service?: ClubService;
}

export interface CatalogueArea {
  key: string;
  rows: readonly CatalogueRow[];
}

const row = (key: string, gate: { feature?: ClubFeature; service?: ClubService } = {}) => ({
  key,
  ...gate,
});

export const CLUB_CATALOGUE: readonly CatalogueArea[] = [
  {
    key: 'dashboard',
    rows: [
      row('today'),
      row('expiring'),
      row('unpaid'),
      row('cap'),
      row('claims'),
      row('erasures'),
      row('inbox'),
      row('leads'),
      row('checklist'),
    ],
  },
  {
    key: 'members',
    rows: [
      row('card'),
      row('family'),
      row('segments'),
      row('import'),
      row('export'),
      row('history'),
      row('invites'),
      row('link'),
      row('gdpr'),
      row('consents'),
    ],
  },
  {
    key: 'plans',
    rows: [
      row('renewal'),
      row('terms'),
      row('selfService'),
      row('sale'),
      row('online', { service: 'payments' }),
      row('cap'),
      row('fees'),
      row('strikes'),
    ],
  },
  {
    key: 'schedule',
    rows: [
      row('grid'),
      row('recurring'),
      row('waitlist'),
      row('trial'),
      row('roster'),
      row('cancel'),
      row('feed'),
    ],
  },
  {
    key: 'attendance',
    rows: [
      row('desk'),
      row('card'),
      row('qr'),
      row('kiosk'),
      row('doors', { feature: 'door_access' }),
      row('neverRefused'),
      row('passport'),
    ],
  },
  {
    key: 'courts',
    rows: [
      row('resources'),
      row('services'),
      row('pricing'),
      row('booking'),
      row('hold', { service: 'payments' }),
      row('window'),
      row('noDouble'),
    ],
  },
  {
    key: 'events',
    rows: [
      row('kinds'),
      row('tickets'),
      row('hold', { service: 'payments' }),
      row('brackets'),
      row('elo'),
      row('ics'),
      row('names'),
    ],
  },
  {
    key: 'payments',
    rows: [
      row('stripe', { service: 'payments' }),
      row('portal', { service: 'payments' }),
      row('subscriptions', { service: 'payments' }),
      row('refunds', { service: 'payments' }),
      row('owed'),
      row('noFunds'),
    ],
  },
  {
    key: 'shop',
    rows: [
      row('till', { feature: 'shop' }),
      row('stock', { feature: 'shop' }),
      row('promotions', { feature: 'promotions' }),
      row('vouchers', { feature: 'promotions' }),
      row('wallet', { feature: 'wallet' }),
    ],
  },
  {
    key: 'invoices',
    rows: [
      row('documents', { feature: 'invoices' }),
      row('identity', { feature: 'invoices' }),
      row('vat', { feature: 'invoices' }),
      row('zero', { feature: 'invoices' }),
    ],
  },
  {
    key: 'messaging',
    rows: [
      row('broadcasts', { feature: 'broadcasts' }),
      row('automations', { feature: 'automations' }),
      row('channels', { service: 'push' }),
      row('sms', { feature: 'sms' }),
      row('system'),
      row('worker'),
    ],
  },
  {
    key: 'inbox',
    rows: [
      row('threads'),
      row('inquiries'),
      row('pipeline'),
      row('tasks'),
      row('ratings', { feature: 'feedback' }),
    ],
  },
  {
    key: 'documents',
    rows: [
      row('versions'),
      row('signing'),
      row('guardian'),
      row('missing'),
      row('ladders'),
      row('readiness'),
      row('bulk'),
    ],
  },
  {
    key: 'reports',
    rows: [
      row('definitions'),
      row('csv'),
      row('advanced', { feature: 'reports_advanced' }),
      row('engagement', { feature: 'reports_advanced' }),
      row('trainerPay', { feature: 'staff_pay' }),
    ],
  },
  {
    key: 'team',
    rows: [
      row('roles'),
      row('invites'),
      row('pay', { feature: 'staff_pay' }),
      row('timeOff'),
      row('profile'),
      row('mail'),
    ],
  },
  {
    key: 'website',
    rows: [
      row('page'),
      row('shortLink'),
      row('branding'),
      row('content'),
      row('locations'),
      row('embeds', { feature: 'embeds' }),
      row('pwa'),
      row('pixels', { feature: 'pixels' }),
    ],
  },
  {
    key: 'portal',
    rows: [
      row('membership'),
      row('bookings'),
      row('buy', { service: 'payments' }),
      row('credit', { feature: 'wallet' }),
      row('reservations'),
      row('events'),
      row('qr'),
      row('chat'),
      row('documents'),
      row('ranks'),
      row('ratings', { feature: 'feedback' }),
      row('consents'),
      row('push', { service: 'push' }),
      row('gdpr'),
    ],
  },
  {
    key: 'integrations',
    rows: [
      row('api', { feature: 'api' }),
      row('webhooks', { feature: 'webhooks' }),
      row('mcp', { feature: 'mcp' }),
      row('doors', { feature: 'door_access' }),
      row('docs', { feature: 'api' }),
    ],
  },
  {
    key: 'security',
    rows: [
      row('controller'),
      row('audit'),
      row('noDob'),
      row('noTracking'),
      row('export'),
      row('archive'),
    ],
  },
];
