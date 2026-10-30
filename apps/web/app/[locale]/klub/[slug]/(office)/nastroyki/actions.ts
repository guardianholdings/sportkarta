'use server';

import { getDb } from '@sportkarta/db';
import { parseGaMeasurementId, parseMetaPixelId } from '@sportkarta/lib/clubs';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';

import { redirect } from '@/i18n/navigation';
import { requireClubStaff } from '@/lib/clubs/club-session';
import {
  isUuid,
  parseClubSettings,
  parseFaq,
  parseInvoiceDetails,
  parseLocation,
  parsePrivacyUrl,
  parseTermsUrl,
} from '@/lib/clubs/input';
import { featureOn } from '@/lib/clubs/features';
import { createKioskDevice, newPairingCode, revokeKiosk } from '@/lib/clubs/kiosk';
import { saveClubTracking } from '@/lib/clubs/tracking';
import {
  connectAccount,
  disconnectAccount,
  paymentProvider,
  paymentsReady,
} from '@/lib/clubs/payments';
import {
  removeFaq,
  saveFaq,
  saveInvoiceDetails,
  saveLocation,
  saveTermsUrl,
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

// ─── Online payments (0046) ────────────────────────────────────────────────

function paymentsBack(slug: string, outcome: string, locale: string): never {
  // `outcome` is one of this file's own literals, never user input.
  return redirect({ href: `/klub/${slug}/nastroyki?plashtaniya=${outcome}#plashtaniya`, locale });
}

/**
 * The fake provider's «Свържете» (development and e2e only): what Stripe's
 * OAuth return does for a real account. Never available with Stripe — the
 * real connection only comes back from Stripe through /api/clubs/stripe/connect.
 */
export async function connectFakePaymentsAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'settings.manage');
  const locale = await getLocale();
  if (!paymentsReady() || paymentProvider() !== 'fake')
    paymentsBack(slug, 'connect_failed', locale);
  const saved = await connectAccount(getDb(), actor, {
    provider: 'fake',
    // 0046's club_payment_accounts_ref_shape: an account id is `acct_…`.
    accountRef: `acct_fake_${actor.clubId.replace(/-/g, '').slice(0, 16)}`,
    chargesEnabled: true,
  });
  refresh(slug);
  paymentsBack(
    slug,
    saved === 'ok' ? 'connected' : saved === 'subscriptions_live' ? saved : 'connect_failed',
    locale,
  );
}

export async function disconnectPaymentsAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'settings.manage');
  const locale = await getLocale();
  const result = await disconnectAccount(getDb(), actor);
  refresh(slug);
  paymentsBack(
    slug,
    result === 'ok' ? 'disconnected' : result === 'subscriptions_live' ? result : 'read_only',
    locale,
  );
}

export async function saveTermsUrlAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'settings.manage');
  const locale = await getLocale();
  const parsed = parseTermsUrl(formData);
  if (!parsed.ok) paymentsBack(slug, 'terms_invalid', locale);
  const saved = parsed.ok && (await saveTermsUrl(getDb(), actor, parsed.value));
  refresh(slug);
  paymentsBack(slug, saved ? 'terms_saved' : 'read_only', locale);
}

/**
 * What an invoice prints about the club (0050): its address, VAT number,
 * IBAN and default VAT rate (the legal name and EIK are the club's identity,
 * above). settings.manage.
 */
export async function saveInvoiceDetailsAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'settings.manage');
  const locale = await getLocale();
  const parsed = parseInvoiceDetails(formData);
  // `outcome` is this file's own literal or a parser code, never user input.
  const back = (outcome: string): never =>
    redirect({ href: `/klub/${slug}/nastroyki?fakturi=${outcome}#fakturi`, locale });
  if (!parsed.ok) return back(parsed.errors[0] ?? 'invalid');
  const saved = await saveInvoiceDetails(getDb(), actor, parsed.value);
  refresh(slug);
  return back(saved ? 'saved' : 'read_only');
}

/**
 * The club's own GA4 measurement id and Meta Pixel id (0058) — ids only, set
 * by the club's own management on a tier with pixels while the operator's
 * switch is on. Setting one asks the club to confirm that it is responsible
 * for that tracking (it is the controller, with the vendor) and tells its
 * visitors so; clearing both needs nothing.
 */
export async function saveTrackingAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor, club } = await requireClubStaff(slug, 'settings.manage');
  const locale = await getLocale();
  // `outcome` is this file's own literal, never user input.
  const back = (outcome: string): never =>
    redirect({ href: `/klub/${slug}/nastroyki?prosledyavane=${outcome}#prosledyavane`, locale });
  if (!featureOn(club, 'pixels')) return back('feature_off');
  const raw = (name: string) => {
    const value = formData.get(name);
    return typeof value === 'string' ? value : '';
  };
  const gaId = parseGaMeasurementId(raw('gaId'));
  const metaId = parseMetaPixelId(raw('metaId'));
  const privacyUrl = parsePrivacyUrl(formData);
  if (gaId === 'invalid') return back('ga_invalid');
  if (metaId === 'invalid') return back('meta_invalid');
  if (privacyUrl === 'invalid') return back('privacy_invalid');
  if (gaId !== null || metaId !== null) {
    // 0058's CHECK holds the same rule; this keeps its refusal off the screen.
    if (privacyUrl === null) return back('privacy_needed');
    if (formData.get('responsible') !== 'on') return back('confirm_needed');
  }
  const saved = await saveClubTracking(getDb(), actor, { gaId, metaId, privacyUrl });
  refresh(slug);
  return back(saved ? 'saved' : 'read_only');
}
