'use server';

import { isPushEndpoint, parsePushSubscription } from '@sportkarta/lib/push';
import { revalidatePath } from 'next/cache';

import { requireUser } from '@/lib/auth-session';
import {
  pushDeviceIsUsers,
  pushPublicKey,
  removeAllPushSubscriptions,
  removePushSubscription,
  savePushSubscription,
} from '@/lib/push';

/**
 * This device's notifications (0051), called by the push toggle after the
 * browser has subscribed or unsubscribed. The session account is the only
 * one written; the subscription is validated against the push-service
 * allowlist before it is stored (and again by the table's CHECK).
 */

export async function subscribePushAction(raw: unknown): Promise<{ ok: boolean }> {
  if (!pushPublicKey()) return { ok: false };
  const user = await requireUser();
  const subscription = parsePushSubscription(raw);
  if (!subscription) return { ok: false };
  await savePushSubscription(user.id, subscription);
  return { ok: true };
}

export async function unsubscribePushAction(endpoint: unknown): Promise<{ ok: boolean }> {
  const user = await requireUser();
  if (typeof endpoint !== 'string' || !isPushEndpoint(endpoint)) return { ok: false };
  await removePushSubscription(user.id, endpoint);
  return { ok: true };
}

/**
 * Whether this browser's subscription is the signed-in account's. On a
 * shared browser it may be another account's (signed out, or "all devices
 * off" from elsewhere): the toggle then drops it locally, so another
 * account's notices stop appearing here.
 */
export async function pushDeviceMineAction(endpoint: unknown): Promise<{ mine: boolean }> {
  const user = await requireUser();
  if (typeof endpoint !== 'string' || !isPushEndpoint(endpoint)) return { mine: false };
  return { mine: await pushDeviceIsUsers(user.id, endpoint) };
}

/** «Изключи на всички устройства» (a form on /profil). */
export async function removeAllDevicesAction(): Promise<void> {
  const user = await requireUser();
  await removeAllPushSubscriptions(user.id);
  revalidatePath('/[locale]/profil', 'page');
}
