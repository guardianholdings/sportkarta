'use server';

import { getDb } from '@sportkarta/db';
import { automationPurpose } from '@sportkarta/lib/clubs';
import { getLocale, getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';

import { redirect } from '@/i18n/navigation';
import { clubName, requireClubStaff } from '@/lib/clubs/club-session';
import { featureOn } from '@/lib/clubs/features';
import {
  isUuid,
  parseAutomation,
  parseBroadcast,
  parseSchedule,
  parseSmsNotify,
} from '@/lib/clubs/input';
import {
  cancelBroadcast,
  channelsOn,
  deleteBroadcastDraft,
  saveAutomation,
  saveBroadcastDraft,
  saveSmsNotify,
  longestMemberName,
  scheduleBroadcast,
  smsFits,
  unscheduleBroadcast,
} from '@/lib/clubs/messages';
import { enqueueClubBroadcasts } from '@/lib/clubs/notify';
import { siteUrl } from '@/lib/seo';

/**
 * A club's messages (0051). messages.send (owner, manager) on a tier with
 * broadcasts / automations; SMS settings are settings.manage on a tier with
 * SMS. Every statement in lib/clubs/messages.ts carries its own scope and the
 * feature check again — what is checked here only decides where to send the
 * person back to.
 */

function slugOf(formData: FormData): string {
  const slug = formData.get('slug');
  return typeof slug === 'string' && /^[a-z0-9-]{3,60}$/.test(slug) ? slug : '';
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/** The SMS as the worker will send it (the club's own language) still fits. */
async function fits(
  actor: Parameters<typeof longestMemberName>[0],
  club: { nameBg: string; nameEn: string | null; locale: 'bg' | 'en' },
  text: string,
  marketing: boolean,
): Promise<boolean> {
  const t = await getTranslations({ locale: club.locale, namespace: 'ClubEmail' });
  return smsFits({
    clubName: clubName(club, club.locale),
    text,
    marketing,
    optOutLabel: t('smsOptOut'),
    siteUrl: siteUrl(),
    longestName: await longestMemberName(actor),
  });
}

async function back(slug: string, path: string, rezultat: string): Promise<never> {
  revalidatePath(`/klub/${slug}/saobshteniya`);
  // `path` is one of this file's literals, optionally with a uuid.
  return redirect({
    href: `/klub/${slug}/saobshteniya${path}?rezultat=${rezultat}`,
    locale: await getLocale(),
  });
}

/** A new draft, or an edit of one. Lands on the message, to preview and send. */
export async function saveBroadcastAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor, club } = await requireClubStaff(slug, 'messages.send');
  if (!featureOn(club, 'broadcasts')) return back(slug, '', 'feature_unavailable');
  const idRaw = str(formData, 'broadcastId');
  const broadcastId = isUuid(idRaw) ? idRaw : null;
  const here = broadcastId ? `/${broadcastId}` : '';
  const parsed = parseBroadcast(formData);
  if (!parsed.ok) return back(slug, here, parsed.errors[0] ?? 'invalid');
  const allowed = channelsOn(club);
  if (parsed.value.channels.some((channel) => !allowed.includes(channel))) {
    return back(slug, here, 'feature_unavailable');
  }
  const sms = parsed.value.smsBody;
  if (sms !== null && !(await fits(actor, club, sms, parsed.value.purpose === 'marketing'))) {
    return back(slug, here, 'sms_too_long');
  }
  const saved = await saveBroadcastDraft(getDb(), actor, broadcastId, parsed.value);
  if (!saved.ok) return back(slug, here, saved.error);
  return back(slug, `/${saved.broadcastId}`, 'saved');
}

export async function scheduleBroadcastAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor, club } = await requireClubStaff(slug, 'messages.send');
  const id = str(formData, 'broadcastId');
  if (!isUuid(id)) return back(slug, '', 'not_found');
  if (!featureOn(club, 'broadcasts')) return back(slug, `/${id}`, 'feature_unavailable');
  const now = new Date();
  const at = parseSchedule(formData, now);
  if (!at.ok) return back(slug, `/${id}`, at.errors[0] ?? 'invalid');
  const result = await scheduleBroadcast(getDb(), actor, id, at.value);
  if (!result.ok) return back(slug, `/${id}`, result.error);
  const immediate = at.value.getTime() <= now.getTime();
  if (immediate) await enqueueClubBroadcasts();
  return back(slug, `/${id}`, immediate ? 'sending' : 'scheduled');
}

export async function unscheduleBroadcastAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'messages.send');
  const id = str(formData, 'broadcastId');
  if (!isUuid(id)) return back(slug, '', 'not_found');
  const ok = await unscheduleBroadcast(getDb(), actor, id);
  return back(slug, `/${id}`, ok ? 'unscheduled' : 'not_found');
}

export async function cancelBroadcastAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'messages.send');
  const id = str(formData, 'broadcastId');
  if (!isUuid(id)) return back(slug, '', 'not_found');
  const ok = await cancelBroadcast(getDb(), actor, id);
  return back(slug, `/${id}`, ok ? 'cancelled' : 'not_found');
}

export async function deleteBroadcastAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'messages.send');
  const id = str(formData, 'broadcastId');
  if (!isUuid(id)) return back(slug, '', 'not_found');
  const ok = await deleteBroadcastDraft(getDb(), actor, id);
  return ok ? back(slug, '', 'deleted') : back(slug, `/${id}`, 'not_found');
}

export async function saveAutomationAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor, club } = await requireClubStaff(slug, 'messages.send');
  if (!featureOn(club, 'automations')) return back(slug, '/avtomatichni', 'feature_unavailable');
  const parsed = parseAutomation(formData);
  if (!parsed.ok) return back(slug, '/avtomatichni', parsed.errors[0] ?? 'invalid');
  if (parsed.value.channel === 'sms' && !channelsOn(club).includes('sms')) {
    return back(slug, '/avtomatichni', 'feature_unavailable');
  }
  if (
    parsed.value.channel === 'sms' &&
    !(await fits(
      actor,
      club,
      parsed.value.body,
      automationPurpose(parsed.value.trigger) === 'marketing',
    ))
  ) {
    return back(slug, '/avtomatichni', 'sms_too_long');
  }
  const ok = await saveAutomation(getDb(), actor, parsed.value);
  return back(slug, '/avtomatichni', ok ? 'automation_saved' : 'readOnly');
}

export async function saveSmsSettingsAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor, club } = await requireClubStaff(slug, 'settings.manage');
  if (!featureOn(club, 'sms')) return back(slug, '/sms', 'feature_unavailable');
  const ok = await saveSmsNotify(getDb(), actor, parseSmsNotify(formData));
  return back(slug, '/sms', ok ? 'sms_saved' : 'readOnly');
}
