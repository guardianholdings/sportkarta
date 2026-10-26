import 'server-only';

import { getDb, sql } from '@sportkarta/db';
import { vapidPublicKey, type PushSubscriptionKeys } from '@sportkarta/lib/push';
import { getTranslations } from 'next-intl/server';

import type { PushToggleLabels } from '@/components/pwa/push-toggle';

/**
 * A POPS account's devices that accept notifications (0051, Web Push). The
 * DEVICE belongs to the account, not to a club: one subscription carries
 * every club's notices to that phone, and each club can be muted on its own
 * link (club_member_links.notify_push). Only the worker sends.
 *
 * Every statement names the SESSION account's id, so one account can neither
 * read nor remove another's devices. An endpoint is unique: the same browser
 * subscribing under a second account moves to it — the device shows what its
 * current account is told, never two accounts' notices.
 */

/** The VAPID public key a browser subscribes with, or null when push is off. */
export function pushPublicKey(): string | null {
  if (process.env.CLUB_PUSH_ENABLED !== 'true') return null;
  try {
    return vapidPublicKey(process.env);
  } catch {
    return null;
  }
}

/** At most this many devices per account; the oldest goes first. */
const DEVICES_PER_ACCOUNT = 10;

export async function savePushSubscription(
  userId: string,
  subscription: PushSubscriptionKeys,
): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
      VALUES (${userId}, ${subscription.endpoint}, ${subscription.p256dh}, ${subscription.auth})
      ON CONFLICT (endpoint) DO UPDATE
        SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
            failure_count = 0
    `);
    await tx.execute(sql`
      DELETE FROM push_subscriptions WHERE user_id = ${userId} AND id NOT IN (
        SELECT id FROM push_subscriptions WHERE user_id = ${userId}
         ORDER BY created_at DESC LIMIT ${DEVICES_PER_ACCOUNT})
    `);
  });
}

export async function removePushSubscription(userId: string, endpoint: string): Promise<void> {
  await getDb().execute(sql`
    DELETE FROM push_subscriptions WHERE user_id = ${userId} AND endpoint = ${endpoint}
  `);
}

/** «Изключи на всички устройства». */
export async function removeAllPushSubscriptions(userId: string): Promise<number> {
  const result = await getDb().execute(sql`
    DELETE FROM push_subscriptions WHERE user_id = ${userId} RETURNING id
  `);
  return result.rows.length;
}

/** Whether this endpoint is registered to this account (a shared browser may hold another's). */
export async function pushDeviceIsUsers(userId: string, endpoint: string): Promise<boolean> {
  const result = await getDb().execute(sql`
    SELECT 1 FROM push_subscriptions WHERE user_id = ${userId} AND endpoint = ${endpoint}
  `);
  return result.rows.length > 0;
}

export async function pushDeviceCount(userId: string): Promise<number> {
  const result = await getDb().execute(sql`
    SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = ${userId}
  `);
  return Number(result.rows[0]?.n ?? 0);
}

/** The device toggle's words, for the server component that renders it. */
export async function pushToggleLabels(): Promise<PushToggleLabels> {
  const t = await getTranslations('PushDevice');
  return {
    on: t('on'),
    off: t('off'),
    enable: t('enable'),
    disable: t('disable'),
    denied: t('denied'),
    unsupported: t('unsupported'),
    failed: t('failed'),
  };
}
