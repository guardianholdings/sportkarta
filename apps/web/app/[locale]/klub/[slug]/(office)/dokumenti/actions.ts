'use server';

import { getDb } from '@sportkarta/db';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';

import { redirect } from '@/i18n/navigation';
import { requireClubStaff } from '@/lib/clubs/club-session';
import {
  publishVersion,
  saveDocument,
  setDocumentArchived,
  signAtDesk,
} from '@/lib/clubs/documents';
import { isUuid, parseDocument, parseDocumentVersion, parseSignature } from '@/lib/clubs/input';

/**
 * Documents and waivers in the office (0055). Writing them is
 * documents.manage; taking a signature at the desk is documents.sign (the
 * member of staff is its witness). Every statement carries its own scope.
 */

function slugOf(formData: FormData): string {
  const slug = formData.get('slug');
  return typeof slug === 'string' && /^[a-z0-9-]{3,60}$/.test(slug) ? slug : '';
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/** `documentId` is a checked uuid or null (the list page); `rezultat` a code. */
async function back(slug: string, documentId: string | null, rezultat: string): Promise<never> {
  revalidatePath(`/klub/${slug}/dokumenti`);
  return redirect({
    href: `/klub/${slug}/dokumenti${documentId ? `/${documentId}` : ''}?rezultat=${rezultat}`,
    locale: await getLocale(),
  });
}

/** A new document with its first text, or its edited heading. */
export async function saveDocumentAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'documents.manage');
  const raw = str(formData, 'documentId');
  const documentId = isUuid(raw) ? raw : null;
  const parsed = parseDocument(formData);
  if (!parsed.ok) return back(slug, documentId, parsed.errors[0] ?? 'invalid');
  let first = null;
  if (documentId === null) {
    const text = parseDocumentVersion(formData, true);
    if (!text.ok) return back(slug, null, text.errors[0] ?? 'invalid');
    first = text.value;
  }
  const saved = await saveDocument(getDb(), actor, parsed.value, documentId, first);
  if (!saved.ok) return back(slug, documentId, saved.error);
  return back(slug, saved.documentId, documentId === null ? 'created' : 'saved');
}

/** A new version of the text. */
export async function publishVersionAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'documents.manage');
  const documentId = str(formData, 'documentId');
  if (!isUuid(documentId)) return back(slug, null, 'not_found');
  const parsed = parseDocumentVersion(formData, false);
  if (!parsed.ok) return back(slug, documentId, parsed.errors[0] ?? 'invalid');
  const version = await publishVersion(getDb(), actor, documentId, parsed.value);
  return back(slug, documentId, version === null ? 'not_allowed' : 'versioned');
}

/** Archive or restore. */
export async function archiveDocumentAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'documents.manage');
  const documentId = str(formData, 'documentId');
  if (!isUuid(documentId)) return back(slug, null, 'not_found');
  const archive = str(formData, 'archive') === '1';
  const ok = await setDocumentArchived(getDb(), actor, documentId, archive);
  return back(slug, documentId, ok ? (archive ? 'archived' : 'restored') : 'not_allowed');
}

/** A signature taken at the desk, from the member card. */
export async function deskSignAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'documents.sign');
  const memberId = str(formData, 'memberId');
  const documentId = str(formData, 'documentId');
  const versionId = str(formData, 'versionId');
  const card = async (rezultat: string): Promise<never> => {
    revalidatePath(`/klub/${slug}/chlenove/${memberId}`);
    return redirect({
      href: `/klub/${slug}/chlenove/${memberId}?dokument=${rezultat}#documents-h`,
      locale: await getLocale(),
    });
  };
  if (!isUuid(memberId) || !isUuid(documentId) || !isUuid(versionId)) {
    return back(slug, null, 'not_found');
  }
  const parsed = parseSignature(formData);
  if (!parsed.ok) return card(parsed.errors[0] ?? 'invalid');
  const signed = await signAtDesk(getDb(), actor, memberId, documentId, versionId, parsed.value);
  return card(signed.ok ? 'signed' : signed.error);
}
