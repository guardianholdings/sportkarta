'use server';

import { getDb } from '@sportkarta/db';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';

import { redirect } from '@/i18n/navigation';
import { requireUser } from '@/lib/auth-session';
import { requireClubsEnabled } from '@/lib/clubs/club-session';
import { writeAsMember } from '@/lib/clubs/inbox';
import { isUuid, parseNewThread, parseReply } from '@/lib/clubs/input';
import { enqueueClubNotify } from '@/lib/clubs/notify';
import { clubIdForSlug } from '@/lib/clubs/portal';

/**
 * A member writes to their club (0052): a new conversation or an answer in
 * one of theirs. The statement admits only the account's own linked record;
 * the staff's notice is enqueued after the commit, and only when the office
 * had read the thread up to then.
 */
export async function memberWriteAction(formData: FormData): Promise<void> {
  requireClubsEnabled();
  const user = await requireUser();
  const slugRaw = formData.get('slug');
  const slug = typeof slugRaw === 'string' && /^[a-z0-9-]{3,60}$/.test(slugRaw) ? slugRaw : '';
  const threadRaw = formData.get('threadId');
  const threadId = typeof threadRaw === 'string' && isUuid(threadRaw) ? threadRaw : null;
  const locale = await getLocale();
  // A uuid or nothing — never caller text.
  const back = (path: string, rezultat: string): never =>
    redirect({ href: `/klub/${slug}/az/saobshteniya${path}?rezultat=${rezultat}`, locale });
  const clubId = await clubIdForSlug(slug);
  if (!clubId) return back('', 'not_found');
  let result;
  if (threadId) {
    const body = parseReply(formData);
    if (!body.ok) return back(`/${threadId}`, body.errors[0] ?? 'invalid');
    result = await writeAsMember(getDb(), user.id, clubId, { threadId }, body.value);
  } else {
    const parsed = parseNewThread(formData);
    if (!parsed.ok) return back('', parsed.errors[0] ?? 'invalid');
    result = await writeAsMember(
      getDb(),
      user.id,
      clubId,
      { subject: parsed.value.subject },
      parsed.value.body,
    );
  }
  if (!result.ok) return back(threadId ? `/${threadId}` : '', result.error);
  if (result.notify)
    await enqueueClubNotify({ kind: 'inbox_message', messageId: result.messageId });
  revalidatePath(`/klub/${slug}/az/saobshteniya`);
  return back(`/${result.threadId}`, 'sent');
}
