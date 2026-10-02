'use server';

import { getDb } from '@sportkarta/db';
import { revalidatePath } from 'next/cache';

import {
  eraseAccountAsAdmin,
  forcePassportPrivate,
  resetDisplayName,
  revokeSessions,
  suspendAccount,
  unsuspendAccount,
  type ControlFailure,
} from '@/lib/account-controls';
import { requireRole } from '@/lib/auth-session';
import { redirect } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';

/**
 * The operator's controls on one account (migration 0033).
 *
 * ADMIN-ONLY, re-checked in EVERY action with `requireRole('admin')` — the page
 * gate is not trusted, because a server action is a public endpoint that can be
 * posted to directly. Never `requireAdmin()`, which admits ambassadors.
 *
 * The actor is always the verified session's account, never a form field; the
 * subject is bound server-side (`action.bind(null, id)`) by the page, so the
 * only thing a crafted request can change is WHICH account, and every account
 * is already in an admin's reach. lib/account-controls.ts holds the rules and
 * writes the admin_actions row inside each change's own transaction.
 */

export interface ControlState {
  /** i18n key suffix under AdminAccounts.controls.error.* */
  error: ControlFailure | null;
  done: boolean;
}

function pathOf(subjectId: string): string {
  return `/admin/akaunti/${subjectId}`;
}

export async function suspendAccountAction(
  subjectId: string,
  _prev: ControlState,
  formData: FormData,
): Promise<ControlState> {
  const admin = await requireRole('admin');
  const result = await suspendAccount(
    getDb(),
    admin.id,
    subjectId,
    String(formData.get('reason') ?? ''),
  );
  if (!result.ok) return { error: result.reason, done: false };
  revalidatePath(pathOf(subjectId));
  return { error: null, done: true };
}

export async function unsuspendAccountAction(subjectId: string): Promise<void> {
  const admin = await requireRole('admin');
  await unsuspendAccount(getDb(), admin.id, subjectId);
  revalidatePath(pathOf(subjectId));
}

export async function resetDisplayNameAction(subjectId: string): Promise<void> {
  const admin = await requireRole('admin');
  await resetDisplayName(getDb(), admin.id, subjectId);
  revalidatePath(pathOf(subjectId));
}

export async function forcePassportPrivateAction(subjectId: string): Promise<void> {
  const admin = await requireRole('admin');
  await forcePassportPrivate(getDb(), admin.id, subjectId);
  revalidatePath(pathOf(subjectId));
}

export async function revokeSessionsAction(subjectId: string): Promise<void> {
  const admin = await requireRole('admin');
  await revokeSessions(getDb(), admin.id, subjectId);
  revalidatePath(pathOf(subjectId));
}

/**
 * Erase on the member's behalf. The typed confirmation is the member's email,
 * checked against the database (lib/account-controls.ts). On success the
 * account no longer exists, so the admin is sent back to the list.
 */
export async function eraseAccountAction(
  subjectId: string,
  _prev: ControlState,
  formData: FormData,
): Promise<ControlState> {
  const admin = await requireRole('admin');
  const result = await eraseAccountAsAdmin(
    getDb(),
    admin.id,
    subjectId,
    String(formData.get('confirmation') ?? ''),
  );
  if (!result.ok) return { error: result.reason, done: false };

  // No email, no name, no id — only that an erasure completed and what it kept.
  console.info(
    `[gdpr] account erased by an admin; audit rows preserved=${result.summary.auditRowsPreserved}`,
  );
  revalidatePath('/admin/akaunti');
  const locale = String(formData.get('locale') ?? '');
  redirect({
    href: { pathname: '/admin/akaunti', query: { iztrit: '1' } },
    locale: routing.locales.find((candidate) => candidate === locale) ?? routing.defaultLocale,
  });
  // Unreachable — redirect() throws — but TypeScript does not narrow on a
  // destructured `never` function, so the signature needs a value here.
  return { error: null, done: true };
}
