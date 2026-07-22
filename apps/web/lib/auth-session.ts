import 'server-only';

import { getDb, sql } from '@sportkarta/db';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';

import { getAuth } from './auth';
import { ADMIN_PANEL_MIN_ROLE, hasAtLeast, toRole, type Role } from './roles';

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

/** Public sign-in route (Bulgarian-first slugs, like the rest of the site). */
export const SIGN_IN_PATH = '/vhod';
export const PROFILE_PATH = '/profil';

/**
 * Verify the session, then read the profile from the database.
 *
 * The session cookie is cached for five minutes, so its embedded user snapshot
 * goes stale — which would mean a freshly granted role, a just-saved profile or
 * a revoked admin all lagging by up to five minutes. Authorization must never
 * read from a cache the client is holding, so the row is authoritative: one
 * primary-key lookup, on authenticated pages only.
 *
 * A session whose user row has vanished (erased account) returns null, so GDPR
 * erasure signs the person out immediately.
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const auth = getAuth();
  if (!auth) return null;

  const session = await auth.api.getSession({ headers: await headers() });
  const userId = session?.user?.id;
  if (!userId) return null;

  const result = await getDb().execute(sql`
    SELECT id, email, display_name, home_city, is_minor, role
    FROM users WHERE id = ${userId}
  `);
  const row = result.rows[0];
  if (!row) return null;

  return {
    id: String(row.id),
    email: String(row.email),
    displayName: String(row.display_name ?? ''),
    homeCity: (row.home_city as string | null) ?? null,
    isMinor: row.is_minor === true,
    role: toRole(row.role),
  };
}

export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect(SIGN_IN_PATH);
  return user;
}

/**
 * Anonymous visitors are sent to sign in; signed-in accounts without the rank
 * get a 404 rather than a "forbidden" page — an unprivileged member has no
 * business learning which admin routes exist.
 */
export async function requireRole(minimum: Role): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect(SIGN_IN_PATH);
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
