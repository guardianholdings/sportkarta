'use server';

import { getDb, revertAccountEdits, revertCrowdEdit } from '@sportkarta/db';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';

import { redirect } from '@/i18n/navigation';
import { requireRole } from '@/lib/auth-session';

import { feedHref, REVERT_WINDOWS_HOURS, type FeedParams } from './params';

/**
 * Undo from the crowd-edit feed (pre-launch audit finding 53).
 *
 * ADMIN-ONLY, re-checked here: the page is gated too, but a server action is a
 * public endpoint in its own right. The operator's id comes from the verified
 * session and becomes the `actor` of every compensating audit row; nothing
 * about who is reverting is read from the form.
 *
 * Every revert re-validates against the live row (db/src/crowd-edits.ts): the
 * edit id in the form is only a pointer, so a stale page can at worst produce
 * `superseded`, never overwrite a later correction.
 */

function refreshPublicViews(): void {
  revalidatePath('/admin/redakcii');
  revalidatePath('/admin/facilities');
  // Facility pages, city pages and the map read the rows a revert just changed.
  revalidatePath('/[locale]/obekt/[slug]', 'page');
}

export async function revertEditAction(editId: number, back: FeedParams): Promise<void> {
  const user = await requireRole('admin');
  const result = await revertCrowdEdit(getDb(), { editId, actorId: user.id });
  if (result.outcome === 'reverted') refreshPublicViews();
  // i18n redirects throughout, so an admin working in /en stays there (A-14).
  redirect({ href: feedHref(back, { rezultat: result.outcome }), locale: await getLocale() });
}

export async function revertAccountAction(back: FeedParams, formData: FormData): Promise<void> {
  const user = await requireRole('admin');
  const accountId = String(formData.get('akaunt') ?? '').trim();
  const hours = Number(formData.get('chasa'));
  // Only the offered windows: the form is a pointer, not a parameter surface.
  if (accountId === '' || !(REVERT_WINDOWS_HOURS as readonly number[]).includes(hours)) {
    redirect({ href: feedHref(back, { rezultat: 'not_found' }), locale: await getLocale() });
  }

  const result = await revertAccountEdits(getDb(), {
    accountId,
    withinHours: hours,
    actorId: user.id,
  });
  if (result.reverted > 0) refreshPublicViews();
  redirect({
    href: feedHref(back, {
      rezultat: 'bulk',
      n: String(result.reverted),
      s: String(result.superseded),
      a: String(result.already + result.notRevertable),
      ...(result.truncated ? { t: '1' } : {}),
    }),
    locale: await getLocale(),
  });
}
