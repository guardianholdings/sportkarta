'use server';

import { getDb } from '@sportkarta/db';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';

import { redirect } from '@/i18n/navigation';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { replyAsClub, setThreadClosed, startThreadAsClub } from '@/lib/clubs/inbox';
import { isUuid, parseNewThread, parseReply } from '@/lib/clubs/input';
import { enqueueClubNotify } from '@/lib/clubs/notify';

/**
 * The office's inbox (0052): answer, close, re-open, and write first to a
 * linked member. inbox.reply (front of house); every statement in
 * lib/clubs/inbox.ts carries its own scope — what is checked here only
 * decides where to send the person back to. The member's notice is enqueued
 * after the commit, and only when they had read the thread up to then.
 */

function slugOf(formData: FormData): string {
  const slug = formData.get('slug');
  return typeof slug === 'string' && /^[a-z0-9-]{3,60}$/.test(slug) ? slug : '';
}

function idOf(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' && isUuid(value) ? value : '';
}

async function back(slug: string, path: string, rezultat: string): Promise<never> {
  revalidatePath(`/klub/${slug}/vhodyashti`);
  // `path` is '' or `/<uuid>` (a thread) — never caller text.
  return redirect({
    href: `/klub/${slug}/vhodyashti${path}?rezultat=${rezultat}`,
    locale: await getLocale(),
  });
}

export async function replyAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'inbox.reply');
  const threadId = idOf(formData, 'threadId');
  if (!threadId) return back(slug, '', 'not_found');
  const parsed = parseReply(formData);
  if (!parsed.ok) return back(slug, `/${threadId}`, parsed.errors[0] ?? 'invalid');
  const result = await replyAsClub(getDb(), actor, threadId, parsed.value);
  if (!result.ok) return back(slug, `/${threadId}`, result.error);
  if (result.notify)
    await enqueueClubNotify({ kind: 'inbox_message', messageId: result.messageId });
  return back(slug, `/${threadId}`, 'sent');
}

export async function closeThreadAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'inbox.reply');
  const threadId = idOf(formData, 'threadId');
  if (!threadId) return back(slug, '', 'not_found');
  const closed = formData.get('closed') === 'true';
  const ok = await setThreadClosed(getDb(), actor, threadId, closed);
  return back(slug, `/${threadId}`, ok ? (closed ? 'closed' : 'reopened') : 'readOnly');
}

/** From a member's page: the office writes first (linked members only). */
export async function startThreadAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'inbox.reply');
  const memberId = idOf(formData, 'memberId');
  if (!memberId) return back(slug, '', 'not_found');
  const parsed = parseNewThread(formData);
  const memberPage = async (rezultat: string): Promise<never> =>
    redirect({
      href: `/klub/${slug}/chlenove/${memberId}?rezultat=${rezultat}`,
      locale: await getLocale(),
    });
  if (!parsed.ok) return memberPage(parsed.errors[0] ?? 'invalid');
  const result = await startThreadAsClub(
    getDb(),
    actor,
    memberId,
    parsed.value.subject,
    parsed.value.body,
  );
  if (!result.ok) return memberPage(result.error);
  await enqueueClubNotify({ kind: 'inbox_message', messageId: result.messageId });
  return back(slug, `/${result.threadId}`, 'started');
}
