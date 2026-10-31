import type { ClubFeature, ClubPermission } from '@sportkarta/lib/clubs';

/**
 * The club office's sections and the seven hubs they are grouped into
 * (operator decision 2026-10-31, UX audit N9). Twenty-three equal pills used
 * to scroll sideways on a phone; now one row of seven hubs, and a second row
 * with the sections of the hub you are in. Routes are unchanged.
 *
 * Pure data, so tests/office-nav.test.ts can hold the grouping to its rules:
 * every section in exactly one hub, no hub naming a section that is not here.
 * Filtering by role and tier happens in ClubShell, for RENDERING only — every
 * page still gates itself (requireClubStaff) and every statement its scope.
 */

export interface OfficeSection {
  segment: string;
  /** ClubOffice.nav.<key> */
  key: string;
  permission: ClubPermission;
  /** Shown only when the club's tier (and any operator switch) includes it. */
  feature?: ClubFeature;
}

export const OFFICE_SECTIONS: readonly OfficeSection[] = [
  { segment: 'tablo', key: 'dashboard', permission: 'office.view' },
  { segment: 'prisastviya', key: 'desk', permission: 'attendance.record' },
  { segment: 'grafik', key: 'schedule', permission: 'schedule.view' },
  { segment: 'kalendar', key: 'calendar', permission: 'schedule.view' },
  { segment: 'sabitiya', key: 'events', permission: 'schedule.view' },
  { segment: 'vhodyashti', key: 'inbox', permission: 'inbox.reply' },
  { segment: 'chlenove', key: 'members', permission: 'members.view' },
  { segment: 'dokumenti', key: 'documents', permission: 'members.view' },
  { segment: 'poyasi', key: 'ranks', permission: 'ranks.view' },
  { segment: 'abonamenti', key: 'plans', permission: 'sales.manage' },
  { segment: 'uslugi', key: 'services', permission: 'schedule.manage' },
  { segment: 'plashtaniya', key: 'payments', permission: 'payments.view' },
  { segment: 'prodazhbi', key: 'sales', permission: 'shop.sell', feature: 'shop' },
  { segment: 'produkti', key: 'products', permission: 'shop.manage', feature: 'shop' },
  { segment: 'promocii', key: 'promotions', permission: 'plans.manage', feature: 'promotions' },
  { segment: 'fakturi', key: 'invoices', permission: 'invoices.issue', feature: 'invoices' },
  {
    segment: 'saobshteniya',
    key: 'messages',
    permission: 'messages.send',
    feature: 'broadcasts',
  },
  { segment: 'otzivi', key: 'feedback', permission: 'feedback.view', feature: 'feedback' },
  { segment: 'otcheti', key: 'reports', permission: 'reports.view' },
  { segment: 'ekip', key: 'team', permission: 'staff.view' },
  { segment: 'resursi', key: 'resources', permission: 'settings.manage' },
  { segment: 'nastroyki', key: 'settings', permission: 'settings.manage' },
  { segment: 'integratsii', key: 'integrations', permission: 'api.manage', feature: 'api' },
];

/**
 * The hubs, in order, each with its sections in order. `also`: office pages
 * outside the nav that belong to a hub — the desk scanner is Присъствия.
 */
export const OFFICE_HUBS = [
  { key: 'dashboard', segments: ['tablo'], also: [] },
  { key: 'attendance', segments: ['prisastviya'], also: ['skan'] },
  { key: 'schedule', segments: ['grafik', 'kalendar', 'sabitiya'], also: [] },
  { key: 'members', segments: ['chlenove', 'dokumenti', 'poyasi'], also: [] },
  {
    key: 'money',
    segments: [
      'abonamenti',
      'uslugi',
      'plashtaniya',
      'prodazhbi',
      'produkti',
      'promocii',
      'fakturi',
    ],
    also: [],
  },
  { key: 'communication', segments: ['vhodyashti', 'saobshteniya', 'otzivi'], also: [] },
  {
    key: 'settings',
    segments: ['nastroyki', 'ekip', 'resursi', 'integratsii', 'otcheti'],
    also: [],
  },
] as const;

export type OfficeHubKey = (typeof OFFICE_HUBS)[number]['key'];

/**
 * The visible sections, grouped into hubs in hub order. A hub none of whose
 * sections the person may see is left out.
 */
export function groupOfficeSections<T extends { segment: string }>(
  visible: readonly T[],
): { key: OfficeHubKey; sections: T[]; also: readonly string[] }[] {
  return OFFICE_HUBS.map((hub) => ({
    key: hub.key,
    sections: hub.segments.flatMap((segment) => visible.filter((s) => s.segment === segment)),
    also: hub.also,
  })).filter((hub) => hub.sections.length > 0);
}
