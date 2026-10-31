'use server';

import { getDb } from '@sportkarta/db';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';

import { redirect } from '@/i18n/navigation';
import { requireUser } from '@/lib/auth-session';
import { requireClubsEnabled } from '@/lib/clubs/club-session';
import { signInPortal } from '@/lib/clubs/documents';
import { isUuid, parseSignature } from '@/lib/clubs/input';
import { clubIdForSlug } from '@/lib/clubs/portal';
import { clubMemberActionLimiter } from '@/lib/clubs/rate-limit';

/**
 * A client signs a club document from the portal (0055): their own record, or
 * a child's as its guardian. The statement admits only the account's own
 * records and the version the page showed, if it is still the latest.
 */
export async function signDocumentAction(formData: FormData): Promise<void> {
  requireClubsEnabled();
  const user = await requireUser();
  const slugRaw = formData.get('slug');
  const slug = typeof slugRaw === 'string' && /^[a-z0-9-]{3,60}$/.test(slugRaw) ? slugRaw : '';
  const locale = await getLocale();
  const back = (rezultat: string): never =>
    redirect({ href: `/klub/${slug}/az/dokumenti?rezultat=${rezultat}`, locale });
  const clubId = await clubIdForSlug(slug);
  if (!clubId) return back('not_found');
  const field = (name: string) => {
    const value = formData.get(name);
    return typeof value === 'string' ? value : '';
  };
  const memberId = field('memberId');
  const documentId = field('documentId');
  const versionId = field('versionId');
  if (!isUuid(memberId) || !isUuid(documentId) || !isUuid(versionId)) return back('not_found');
  if (!clubMemberActionLimiter.check(`document:${user.id}`).allowed) return back('rate_limited');
  const parsed = parseSignature(formData);
  if (!parsed.ok) return back(parsed.errors[0] ?? 'invalid');
  const signed = await signInPortal(
    getDb(),
    user.id,
    clubId,
    memberId,
    documentId,
    versionId,
    parsed.value.signerName,
  );
  revalidatePath(`/klub/${slug}/az/dokumenti`);
  revalidatePath(`/klub/${slug}/az`);
  // A second submit of the same signature is the same signature.
  return back(signed.ok || signed.error === 'already_signed' ? 'signed' : signed.error);
}
