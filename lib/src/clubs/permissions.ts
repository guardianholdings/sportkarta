/**
 * Who may do what inside a club's office — one total, pure matrix
 * (docs/ROADMAP.md Stage 9).
 *
 * This file DECIDES nothing at runtime on its own. apps/web/lib/clubs/scope.ts
 * turns `rolesWith(permission)` into the SQL fragment every statement embeds
 * (the ambassador pattern of apps/web/lib/moderation.ts), so an out-of-scope
 * write updates zero rows whatever the UI shows; the UI uses `can` only to
 * decide what to RENDER. The two cannot disagree because both read this table.
 *
 * Roles, from the plan:
 *   owner    everything, including the club's tier banner and owner changes
 *   manager  everything except owner management, erasing clients and billing
 *   trainer  the timetable, and the roster + attendance of THEIR OWN classes —
 *            and on that roster only a display name and a minor flag (the
 *            projection rule in apps/web/lib/clubs/roster.ts)
 *   desk     clients incl. contact details, sales, payments, bookings and
 *            attendance; no settings, plans, reports or exports
 *
 * Permissions whose name ends in `_own` are granted on the trainer's own
 * classes only; scope.ts adds the instructor condition for them.
 */

export const CLUB_ROLES = ['owner', 'manager', 'trainer', 'desk'] as const;
export type ClubRole = (typeof CLUB_ROLES)[number];

export const CLUB_PERMISSIONS = [
  'office.view',
  'settings.manage',
  'billing.view',
  'kiosk.manage',
  'staff.view',
  'staff.manage',
  'staff.manage_owners',
  'members.view',
  'members.manage',
  'members.erase',
  'plans.manage',
  'sales.manage',
  'payments.view',
  'payments.record',
  'charges.void',
  'shop.sell',
  'shop.manage',
  'invoices.issue',
  'schedule.view',
  'schedule.manage',
  'roster.view',
  'roster.view_own',
  'bookings.manage',
  'attendance.record',
  'attendance.record_own',
  'reports.view',
  'data.export',
  'data.import',
  'audit.view',
  'messages.send',
  'inbox.reply',
  'feedback.view',
  'events.manage',
  'events.results',
  'documents.manage',
  'documents.sign',
] as const;
export type ClubPermission = (typeof CLUB_PERMISSIONS)[number];

const ALL: readonly ClubRole[] = CLUB_ROLES;
const OWNER: readonly ClubRole[] = ['owner'];
const MANAGEMENT: readonly ClubRole[] = ['owner', 'manager'];
const FRONT_OF_HOUSE: readonly ClubRole[] = ['owner', 'manager', 'desk'];

const MATRIX: Readonly<Record<ClubPermission, readonly ClubRole[]>> = {
  'office.view': ALL,
  'settings.manage': MANAGEMENT,
  'billing.view': OWNER,
  'kiosk.manage': MANAGEMENT,
  'staff.view': ALL,
  'staff.manage': MANAGEMENT,
  'staff.manage_owners': OWNER,
  'members.view': FRONT_OF_HOUSE,
  'members.manage': FRONT_OF_HOUSE,
  'members.erase': OWNER,
  'plans.manage': MANAGEMENT,
  'sales.manage': FRONT_OF_HOUSE,
  'payments.view': FRONT_OF_HOUSE,
  'payments.record': FRONT_OF_HOUSE,
  'charges.void': MANAGEMENT,
  // The till is the desk's; what is on the shelf, its price and its stock
  // count are management's (wave B1).
  'shop.sell': FRONT_OF_HOUSE,
  'shop.manage': MANAGEMENT,
  /** Invoices and credit notes (0050): a legal document, so owner and manager. */
  'invoices.issue': MANAGEMENT,
  'schedule.view': ALL,
  'schedule.manage': MANAGEMENT,
  'roster.view': FRONT_OF_HOUSE,
  'roster.view_own': ['trainer'],
  'bookings.manage': FRONT_OF_HOUSE,
  'attendance.record': FRONT_OF_HOUSE,
  'attendance.record_own': ['trainer'],
  'reports.view': MANAGEMENT,
  'data.export': MANAGEMENT,
  'data.import': MANAGEMENT,
  'audit.view': MANAGEMENT,
  /**
   * Messages to a group and automations (0051): what goes out under the
   * club's name, to many people, is management's.
   */
  'messages.send': MANAGEMENT,
  /**
   * The inbox and inquiries (0052): whoever answers the club's phone answers
   * its messages. The prospects pipeline is members.manage.
   */
  'inbox.reply': FRONT_OF_HOUSE,
  /** Ratings and their comments (0052): how the club is doing is management's. */
  'feedback.view': MANAGEMENT,
  /**
   * Events, camps and tournaments (0053): what the club puts on, its tickets,
   * prices and cancellation are management's. Registering a person at the
   * desk, and giving a place up for them, is bookings.manage (front of house).
   */
  'events.manage': MANAGEMENT,
  /**
   * A tournament's results (0054): whoever runs the matches records them —
   * management and the trainers. The draw itself is events.manage.
   */
  'events.results': ['owner', 'manager', 'trainer'],
  /**
   * Documents and waivers (0055): what the club asks its clients to sign, and
   * its text, are management's.
   */
  'documents.manage': MANAGEMENT,
  /**
   * Taking a signature at the desk — the member of staff is its witness —
   * belongs to the front of house, who meets the client. Reading signatures
   * is members.view.
   */
  'documents.sign': FRONT_OF_HOUSE,
};

export function isClubRole(value: unknown): value is ClubRole {
  return typeof value === 'string' && (CLUB_ROLES as readonly string[]).includes(value);
}

/** The roles that hold `permission` — what the SQL scope fragment binds. */
export function rolesWith(permission: ClubPermission): readonly ClubRole[] {
  return MATRIX[permission];
}

/** Whether `role` holds `permission`. For rendering; the SQL decides. */
export function can(role: ClubRole, permission: ClubPermission): boolean {
  return MATRIX[permission].includes(role);
}

/** True for the permissions a trainer holds on their own classes only. */
export function isOwnClassesPermission(permission: ClubPermission): boolean {
  return permission.endsWith('_own');
}

/**
 * Roles a member of staff may hand out. Only an owner creates owners; a
 * manager builds the team below them.
 */
export function grantableRoles(granter: ClubRole): readonly ClubRole[] {
  if (granter === 'owner') return CLUB_ROLES;
  if (granter === 'manager') return ['manager', 'trainer', 'desk'];
  return [];
}
