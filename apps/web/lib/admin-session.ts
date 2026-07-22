import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { ADMIN_COOKIE, verifyAdminToken, type AdminIdentity } from './admin-auth';

export async function getAdminIdentity(): Promise<AdminIdentity | null> {
  const store = await cookies();
  return verifyAdminToken(store.get(ADMIN_COOKIE)?.value);
}

/**
 * Server-side gate for the admin layout AND every server action — the
 * middleware redirect is only the first layer. Actions derive `actor` from
 * the verified cookie, never from client-supplied form data.
 */
export async function requireAdmin(): Promise<AdminIdentity> {
  const identity = await getAdminIdentity();
  if (!identity) {
    redirect('/admin/login');
  }
  return identity;
}
