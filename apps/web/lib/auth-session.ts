import 'server-only';

import { getDb, sql } from '@sportkarta/db';
import { getLocale } from 'next-intl/server';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

import { redirect } from '@/i18n/navigation';

import { getAuth } from './auth';
import { resolveAdminEmails } from './auth-config';
import {
  ADMIN_PANEL_MIN_ROLE,
  hasAtLeast,
  isRevokedAdmin,
  syncAdminRole,
  toRole,
  type Role,
} from './roles';
import { REQUEST_PATH_HEADER, signInHref } from './sign-in-destination';

/**
 * Session + authorization helpers. Replaces the Stage 1 admin-session module:
 * identity is now an account, and `actor` on audit rows is the opaque user id.
 *
 * Layering is unchanged and deliberate — middleware gives a cheap redirect,
 * layouts gate rendering, and EVERY server action re-checks here. No single
 * gate is trusted.
 */

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string;
  homeCity: string | null;
  isMinor: boolean;
  role: Role;
}

export { PROFILE_PATH, SIGN_IN_PATH } from './sign-in-destination';

let adminEmails: ReadonlySet<string> | undefined;

/**
 * The admin role as of THIS request. ADMIN_EMAILS is re-checked on every
 * authorization, not only at sign-in: a removed admin with a live 30-day
 * sliding session would otherwise keep every right for as long as they kept
 * visiting. The demotion is written back (syncAdminRole) rather than only
 * computed here, because session-organiser checks read `users.role` in SQL.
 */
async function currentRole(userId: string, email: string, stored: unknown): Promise<Role> {
  adminEmails ??= resolveAdminEmails(process.env);
  if (!isRevokedAdmin(stored, email, adminEmails)) return toRole(stored);
  await syncAdminRole(getDb(), userId, adminEmails);
  return 'user';
}

/**
 * Verify the session, then read the profile from the database.
 *
 * better-auth answers getSession() from its signed cookie cache for up to
 * SESSION_COOKIE_CACHE_SECONDS (lib/auth-options.ts) without touching the
 * database. Two things in that cookie go stale: the user snapshot (a freshly
 * granted role, a just-saved profile, a revoked admin) and the session itself,
 * which may already be gone from the store (an admin's "end every session",
 * the pre-hijack guard). Authorization must never read from a cache the client
 * is holding, so both rows are authoritative, read in ONE statement: two
 * primary-key lookups, one round trip, on authenticated pages only.
 *
 * Not `query: { disableCookieCache: true }`: that would have better-auth read
 * the session itself even when the cookie could answer, a second round trip
 * on top of this one, which the role and suspension need anyway.
 *
 * No row back returns null, so GDPR erasure, a suspension, a revoked session
 * and one expired in the store all sign the person out on their very next
 * request.
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const auth = getAuth();
  if (!auth) return null;

  const session = await auth.api.getSession({ headers: await headers() });
  const userId = session?.user?.id;
  const sessionId = session?.session?.id;
  if (!userId || !sessionId) return null;

  // A SUSPENDED account (0033) reads exactly like an erased one: no row, so
  // every gate behind this — requireUser, requireRole, each server action —
  // sees a signed-out visitor on the very next request, cookie cache or not.
  // So does a session that is no longer in the store: the id the cookie names
  // must still be a live session of THIS account, not merely any of its
  // sessions (the pre-hijack owner signs in on a fresh one while the
  // stranger's cookie still names the deleted one).
  const result = await getDb().execute(sql`
    SELECT u.id, u.email, u.display_name, u.home_city, u.is_minor, u.role
    FROM users u
    JOIN sessions s ON s.user_id = u.id
    WHERE u.id = ${userId} AND u.suspended_at IS NULL
      AND s.id = ${sessionId} AND s.expires_at > now()
  `);
  const row = result.rows[0];
  if (!row) return null;

  return {
    id: String(row.id),
    email: String(row.email),
    displayName: String(row.display_name ?? ''),
    homeCity: (row.home_city as string | null) ?? null,
    isMinor: row.is_minor === true,
    role: await currentRole(String(row.id), String(row.email), row.role),
  };
}

/**
 * Send an anonymous visitor to sign in — in the language of the page they were
 * on, and carrying that page as `next`, so the code step returns them to it.
 * The path comes from middleware (REQUEST_PATH_HEADER); a bare next/navigation
 * redirect to '/vhod' used to drop both, landing English visitors on the
 * Bulgarian form and everyone on /profil afterwards.
 */
async function redirectToSignIn(): Promise<never> {
  const [headerStore, locale] = await Promise.all([headers(), getLocale()]);
  return redirect({ href: signInHref(headerStore.get(REQUEST_PATH_HEADER)), locale });
}

export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) return redirectToSignIn();
  return user;
}

/**
 * Anonymous visitors are sent to sign in; signed-in accounts without the rank
 * get a 404 rather than a "forbidden" page — an unprivileged member has no
 * business learning which admin routes exist.
 */
export async function requireRole(minimum: Role): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) return redirectToSignIn();
  if (!hasAtLeast(user.role, minimum)) notFound();
  return user;
}

/**
 * Gate for the admin panel: ambassadors and admins.
 *
 * The name is historical — it does NOT mean "is an admin". Anything genuinely
 * admin-only (imports, granting ambassadors) must call requireRole('admin'),
 * and anything an ambassador may do must additionally be scoped by municipality
 * in the SQL (lib/moderation.ts). Rank alone never authorises a decision.
 */
export function requireAdmin(): Promise<CurrentUser> {
  return requireRole(ADMIN_PANEL_MIN_ROLE);
}
