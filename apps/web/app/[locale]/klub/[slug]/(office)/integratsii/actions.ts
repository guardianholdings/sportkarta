'use server';

import { getDb } from '@sportkarta/db';
import {
  CLUB_API_KEY_NAME_MAX,
  CLUB_WEBHOOK_DESCRIPTION_MAX,
  isClubApiScope,
  isClubWebhookEvent,
  isDoorAccessRule,
  type ClubFeature,
} from '@sportkarta/lib/clubs';
import { checkPublicHttpsUrl } from '@sportkarta/lib/net';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';

import { redirect } from '@/i18n/navigation';
import { issueClubApiKey, revokeClubApiKey } from '@/lib/clubs/api-keys';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { createDoorDevice, revokeDoorDevice } from '@/lib/clubs/doors';
import { featureOn } from '@/lib/clubs/features';
import { isUuid } from '@/lib/clubs/input';
import type { SecretFormState } from '@/lib/clubs/secret-form-state';
import {
  addWebhookEndpoint,
  disableWebhookEndpoint,
  enableWebhookEndpoint,
  removeWebhookEndpoint,
  rotateWebhookSecret,
} from '@/lib/clubs/webhooks';

/**
 * «Интеграции» (0057): API keys, webhooks and door controllers. Everything
 * here is api.manage (management). The forms that MINT a secret return it in
 * their state, once (SecretOnceForm); the rest are plain posts back to the
 * page. Every statement carries its own scope — the creating ones the club's
 * OWN staff only (clubStaffWriteScope), the protective ones (revoke, disable,
 * remove) the NGO admin too.
 */

function slugOf(formData: FormData): string {
  const slug = formData.get('slug');
  return typeof slug === 'string' && /^[a-z0-9-]{3,60}$/.test(slug) ? slug : '';
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function hasControl(value: string): boolean {
  return [...value].some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

/** A short label: 1–max characters, no control characters, and never a pasted secret. */
function label(raw: string, max: number, required: boolean): string | null | 'invalid' {
  if (raw === '') return required ? 'invalid' : null;
  if (raw.length > max || hasControl(raw) || /sk(bk|bd|bw|bc)_/.test(raw)) return 'invalid';
  return raw;
}

async function back(slug: string, rezultat: string): Promise<never> {
  revalidatePath(`/klub/${slug}/integratsii`);
  return redirect({
    href: `/klub/${slug}/integratsii?rezultat=${rezultat}`,
    locale: await getLocale(),
  });
}

function failed(error: string): SecretFormState {
  return { error, secret: null };
}

async function staffWith(formData: FormData, feature: ClubFeature) {
  const slug = slugOf(formData);
  const context = await requireClubStaff(slug, 'api.manage');
  return { slug, ...context, on: featureOn(context.club, feature) };
}

/** A new API key: its name and scopes; the key is shown once. */
export async function issueKeyAction(
  _prev: SecretFormState,
  formData: FormData,
): Promise<SecretFormState> {
  const { slug, actor, on } = await staffWith(formData, 'api');
  if (!on) return failed('feature_off');
  const name = label(str(formData, 'name'), CLUB_API_KEY_NAME_MAX, true);
  if (name === null || name === 'invalid') return failed('name_invalid');
  const scopes = [...new Set(formData.getAll('scope'))].filter(isClubApiScope);
  if (scopes.length === 0) return failed('scopes_none');
  const issued = await issueClubApiKey(getDb(), actor, { name, scopes });
  if (!issued.ok) return failed(issued.error);
  revalidatePath(`/klub/${slug}/integratsii`);
  return { error: null, secret: issued.key };
}

export async function revokeKeyAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'api.manage');
  const keyId = str(formData, 'keyId');
  const revoked = isUuid(keyId) && (await revokeClubApiKey(getDb(), actor, keyId));
  return back(slug, revoked ? 'keyRevoked' : 'not_allowed');
}

/** A new webhook endpoint; its signing secret is shown once. */
export async function addWebhookAction(
  _prev: SecretFormState,
  formData: FormData,
): Promise<SecretFormState> {
  const { slug, actor, on } = await staffWith(formData, 'webhooks');
  if (!on) return failed('feature_off');
  const url = checkPublicHttpsUrl(str(formData, 'url'));
  if (!url.ok) return failed(`url_${url.problem}`);
  const events = [...new Set(formData.getAll('event'))].filter(isClubWebhookEvent);
  if (events.length === 0) return failed('events_none');
  const description = label(str(formData, 'description'), CLUB_WEBHOOK_DESCRIPTION_MAX, false);
  if (description === 'invalid') return failed('name_invalid');
  const added = await addWebhookEndpoint(getDb(), actor, { url: url.url, events, description });
  if (!added.ok) return failed(added.error);
  revalidatePath(`/klub/${slug}/integratsii`);
  return { error: null, secret: added.secret };
}

/** A new signing secret for an endpoint, shown once; the old one signs for a day. */
export async function rotateWebhookAction(
  _prev: SecretFormState,
  formData: FormData,
): Promise<SecretFormState> {
  const { actor, on } = await staffWith(formData, 'webhooks');
  if (!on) return failed('feature_off');
  const endpointId = str(formData, 'endpointId');
  if (!isUuid(endpointId)) return failed('not_allowed');
  const secret = await rotateWebhookSecret(getDb(), actor, endpointId, {
    expireNow: str(formData, 'expireNow') === '1',
  });
  return secret ? { error: null, secret } : failed('not_allowed');
}

/** Stop, start again, or remove an endpoint. */
export async function webhookStateAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'api.manage');
  const endpointId = str(formData, 'endpointId');
  if (!isUuid(endpointId)) return back(slug, 'not_allowed');
  const db = getDb();
  switch (str(formData, 'op')) {
    case 'disable':
      return back(
        slug,
        (await disableWebhookEndpoint(db, actor, endpointId)) ? 'webhookDisabled' : 'not_allowed',
      );
    case 'enable':
      return back(
        slug,
        (await enableWebhookEndpoint(db, actor, endpointId)) ? 'webhookEnabled' : 'not_allowed',
      );
    case 'remove':
      return back(
        slug,
        (await removeWebhookEndpoint(db, actor, endpointId)) ? 'webhookRemoved' : 'not_allowed',
      );
    default:
      return back(slug, 'not_allowed');
  }
}

/** A new door controller; its token is shown once. */
export async function createDoorAction(
  _prev: SecretFormState,
  formData: FormData,
): Promise<SecretFormState> {
  const { slug, actor, on } = await staffWith(formData, 'door_access');
  if (!on) return failed('feature_off');
  const name = label(str(formData, 'name'), 60, true);
  if (name === null || name === 'invalid') return failed('name_invalid');
  const locationId = str(formData, 'locationId');
  if (!isUuid(locationId)) return failed('location_invalid');
  const rule = str(formData, 'rule');
  if (!isDoorAccessRule(rule)) return failed('rule_invalid');
  const created = await createDoorDevice(getDb(), actor, { locationId, name, rule });
  if (!created) return failed('not_allowed');
  revalidatePath(`/klub/${slug}/integratsii`);
  return { error: null, secret: created.token };
}

export async function revokeDoorAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'api.manage');
  const deviceId = str(formData, 'deviceId');
  const revoked = isUuid(deviceId) && (await revokeDoorDevice(getDb(), actor, deviceId));
  return back(slug, revoked ? 'doorRevoked' : 'not_allowed');
}
