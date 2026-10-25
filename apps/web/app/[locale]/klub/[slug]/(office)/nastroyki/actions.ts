'use server';

import { getDb } from '@sportkarta/db';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';

import { redirect } from '@/i18n/navigation';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { isUuid, parseClubSettings, parseFaq, parseLocation } from '@/lib/clubs/input';
import { createKioskDevice, newPairingCode, revokeKiosk } from '@/lib/clubs/kiosk';
import {
  removeFaq,
  saveFaq,
  saveLocation,
  setClubLogo,
  setClubVisible,
  setLocationActive,
  updateClubSettings,
} from '@/lib/clubs/settings';
import { revalidateClubSurfaces } from '@/lib/clubs/surfaces';
import { ContributionError } from '@/lib/contributions/errors';
import { discardContributionPhoto, storeContributionPhoto } from '@/lib/contributions/photo-upload';

/**
 * Club settings actions. Every one re-gates with requireClubStaff (the page
 * gate is not an authorisation) and the domain functions embed the scope and
 * the club's entitlement in SQL: a pending or lapsed club saves nothing, which
 * comes back as `readOnly`.
 */

export interface SettingsState {
  error: string | null;
  errors?: string[];
  saved?: boolean;
  /** A kiosk pairing code, shown once. */
  code?: string;
}

function slugOf(formData: FormData): string {
  const slug = formData.get('slug');
  return typeof slug === 'string' && /^[a-z0-9-]{3,60}$/.test(slug) ? slug : '';
}

function refresh(slug: string): void {
  revalidatePath(`/klub/${slug}/nastroyki`);
  revalidatePath(`/klub/${slug}/tablo`);
  revalidateClubSurfaces(slug);
}

export async function saveSettingsAction(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'settings.manage');
  const parsed = parseClubSettings(formData);
  if (!parsed.ok) return { error: 'invalid', errors: parsed.errors };
  const saved = await updateClubSettings(getDb(), actor, parsed.value);
  if (!saved) return { error: 'readOnly' };
  refresh(slug);
  return { error: null, saved: true };
}

export async function setVisibleAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'settings.manage');
  await setClubVisible(getDb(), actor, formData.get('visible') === 'true');
  refresh(slug);
}

export async function uploadLogoAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'settings.manage');
  const file = formData.get('logo');
  let key: string | null = null;
  let outcome = 'saved';
  if (file instanceof File && file.size > 0) {
    try {
      key = await storeContributionPhoto(file, 'clubs');
      const result = await setClubLogo(getDb(), actor, key);
      if (!result.ok) {
        await discardContributionPhoto(key);
        outcome = 'readOnly';
      } else if (result.previous && result.previous !== key) {
        await discardContributionPhoto(result.previous);
      }
    } catch (error: unknown) {
      await discardContributionPhoto(key);
      if (!(error instanceof ContributionError)) throw error;
      outcome = error.code;
    }
  }
  refresh(slug);
  return redirect({
    href: { pathname: `/klub/${slug}/nastroyki`, query: { logo: outcome } },
    locale: await getLocale(),
  });
}

export async function saveLocationAction(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'settings.manage');
  const locationIdRaw = formData.get('locationId');
  const locationId = isUuid(locationIdRaw) ? locationIdRaw : null;
  const parsed = parseLocation(formData);
  if (!parsed.ok) return { error: 'invalid', errors: parsed.errors };
  const saved = await saveLocation(getDb(), actor, locationId, parsed.value);
  if (!saved) return { error: 'readOnly' };
  refresh(slug);
  return { error: null, saved: true };
}

export async function setLocationActiveAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'settings.manage');
  const locationId = formData.get('locationId');
  if (!isUuid(locationId)) return;
  await setLocationActive(getDb(), actor, locationId, formData.get('active') === 'true');
  refresh(slug);
}

export async function createKioskAction(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'kiosk.manage');
  const locationId = formData.get('locationId');
  const nameRaw = formData.get('name');
  const name =
    typeof nameRaw === 'string' && nameRaw.trim() ? nameRaw.trim().slice(0, 60) : 'Kiosk';
  if (!isUuid(locationId)) return { error: 'invalid', errors: ['location_required'] };
  const created = await createKioskDevice(getDb(), actor, locationId, name);
  if (!created) return { error: 'readOnly' };
  revalidatePath(`/klub/${slug}/nastroyki`);
  return { error: null, code: created.code };
}

export async function newPairingCodeAction(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'kiosk.manage');
  const deviceId = formData.get('deviceId');
  if (!isUuid(deviceId)) return { error: 'invalid' };
  const code = await newPairingCode(getDb(), actor, deviceId);
  if (!code) return { error: 'readOnly' };
  revalidatePath(`/klub/${slug}/nastroyki`);
  return { error: null, code };
}

export async function revokeKioskAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'kiosk.manage');
  const deviceId = formData.get('deviceId');
  if (!isUuid(deviceId)) return;
  await revokeKiosk(getDb(), actor, deviceId);
  revalidatePath(`/klub/${slug}/nastroyki`);
}

/** Add or edit one FAQ entry of the public page. */
export async function saveFaqAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'settings.manage');
  const parsed = parseFaq(formData);
  const faqId = formData.get('faqId');
  if (parsed.ok) await saveFaq(getDb(), actor, isUuid(faqId) ? faqId : null, parsed.value);
  refresh(slug);
}

export async function removeFaqAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'settings.manage');
  const faqId = formData.get('faqId');
  if (isUuid(faqId)) await removeFaq(getDb(), actor, faqId);
  refresh(slug);
}
