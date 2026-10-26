'use server';

import { getDb } from '@sportkarta/db';
import { CLUB_TIERS, isIsoDate, type ClubTier } from '@sportkarta/lib/clubs';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';

import { redirect } from '@/i18n/navigation';
import { requireRole } from '@/lib/auth-session';
import {
  approveClub,
  purgeClub,
  rejectApplication,
  setClubPlan,
  setClubStatus,
  type ClubStatusTarget,
} from '@/lib/clubs/admin';
import { requireClubsEnabled } from '@/lib/clubs/club-session';
import { enqueueClubNotify } from '@/lib/clubs/notify';
import {
  closeOpenCheckouts,
  releaseClubAccount,
  stopProviderSubscriptions,
} from '@/lib/clubs/payments';
import { revalidateClubSurfaces } from '@/lib/clubs/surfaces';
import { discardContributionPhoto } from '@/lib/contributions/photo-upload';

/**
 * The operator's club controls (/admin/klubove). requireRole('admin') on EVERY
 * action — not requireAdmin(), which admits ambassadors: selling the add-on is
 * not a moderation decision. Each action writes the TARGET state and logs to
 * admin_actions in the same transaction (lib/clubs/admin.ts), then sends the
 * operator back to the club with a one-word outcome in the URL.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9-]{3,60}$/;

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

async function backTo(slug: string, outcome: string): Promise<never> {
  return redirect({
    href: { pathname: `/admin/klubove/${slug}`, query: { rezultat: outcome } },
    locale: await getLocale(),
  });
}

async function guard(
  formData: FormData,
): Promise<{ adminId: string; clubId: string; slug: string }> {
  requireClubsEnabled();
  const admin = await requireRole('admin');
  const clubId = field(formData, 'clubId');
  const slug = field(formData, 'slug');
  if (!UUID.test(clubId) || !SLUG.test(slug))
    return backTo(SLUG.test(slug) ? slug : 'x', 'invalid');
  return { adminId: admin.id, clubId, slug };
}

function refresh(slug: string): void {
  revalidatePath('/admin/klubove');
  revalidatePath(`/admin/klubove/${slug}`);
  revalidateClubSurfaces(slug);
}

export async function approveClubAction(formData: FormData): Promise<void> {
  const { adminId, clubId, slug } = await guard(formData);
  const changed = await approveClub(getDb(), adminId, clubId);
  refresh(slug);
  if (changed) await enqueueClubNotify({ kind: 'application_approved', clubId });
  return backTo(slug, changed ? 'approved' : 'unchanged');
}

export async function rejectClubAction(formData: FormData): Promise<void> {
  const { adminId, clubId, slug } = await guard(formData);
  const changed = await rejectApplication(getDb(), adminId, clubId);
  refresh(slug);
  return backTo(slug, changed ? 'rejected' : 'unchanged');
}

export async function setClubPlanAction(formData: FormData): Promise<void> {
  const { adminId, clubId, slug } = await guard(formData);
  const tierRaw = field(formData, 'tier');
  if (!(CLUB_TIERS as readonly string[]).includes(tierRaw)) return backTo(slug, 'tier_invalid');
  const paidUntil = field(formData, 'paidUntil') || null;
  const trialEndsOn = field(formData, 'trialEndsOn') || null;
  if ((paidUntil && !isIsoDate(paidUntil)) || (trialEndsOn && !isIsoDate(trialEndsOn))) {
    return backTo(slug, 'date_invalid');
  }
  const capRaw = field(formData, 'memberCap');
  const memberCap = capRaw === '' ? null : /^\d{1,7}$/.test(capRaw) ? Number(capRaw) : NaN;
  if (memberCap !== null && (!Number.isInteger(memberCap) || memberCap < 1)) {
    return backTo(slug, 'cap_invalid');
  }
  // SMS parts a month (0051): what the club may send, and is re-invoiced for.
  const smsRaw = field(formData, 'smsMonthlyCap') || '0';
  if (!/^\d{1,6}$/.test(smsRaw) || Number(smsRaw) > 100_000) {
    return backTo(slug, 'sms_cap_invalid');
  }
  const changed = await setClubPlan(getDb(), adminId, clubId, {
    tier: tierRaw as ClubTier,
    paidUntil,
    trialEndsOn,
    memberCap,
    smsMonthlyCap: Number(smsRaw),
  });
  refresh(slug);
  return backTo(slug, changed ? 'saved' : 'not_changed');
}

export async function setClubStatusAction(formData: FormData): Promise<void> {
  const { adminId, clubId, slug } = await guard(formData);
  const target = field(formData, 'target');
  if (target !== 'active' && target !== 'suspended' && target !== 'archived') {
    return backTo(slug, 'invalid');
  }
  // An archived club bills nobody: its members' card subscriptions end now.
  if (target === 'archived') {
    await closeOpenCheckouts(clubId, null);
    if (!(await stopProviderSubscriptions(clubId, { club: true }, 'now'))) {
      return backTo(slug, 'provider_error');
    }
  }
  const changed = await setClubStatus(getDb(), adminId, clubId, target as ClubStatusTarget);
  refresh(slug);
  return backTo(slug, changed ? 'saved' : 'unchanged');
}

export async function purgeClubAction(formData: FormData): Promise<void> {
  const { adminId, clubId, slug } = await guard(formData);
  // No member is billed for a club that no longer exists: subscriptions end
  // now, before the rows that record them go.
  await closeOpenCheckouts(clubId, null);
  if (!(await stopProviderSubscriptions(clubId, { club: true }, 'now'))) {
    return backTo(slug, 'provider_error');
  }
  const result = await purgeClub(getDb(), adminId, clubId);
  if (!result.purged) return backTo(slug, 'not_yet');
  // Only once the club is gone: let go of its Stripe connection (best effort),
  // so a purged club leaves POPS no read_write access to its account.
  await releaseClubAccount(clubId);
  // The logo file only after the rows are gone — best effort, like partners.
  await discardContributionPhoto(result.logoPath);
  revalidatePath('/admin/klubove');
  revalidateClubSurfaces(slug);
  return redirect({
    href: { pathname: '/admin/klubove', query: { tab: 'archived', rezultat: 'purged' } },
    locale: await getLocale(),
  });
}
