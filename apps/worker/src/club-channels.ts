import {
  claimClubNotification,
  getDb,
  isSmsCapRefusal,
  notePushResult,
  pushSubscriptionsOf,
  type MemberChannels,
} from '@sportkarta/db';
import { clubHasFeature, type ClubNotificationKind } from '@sportkarta/lib/clubs';
import type { DeliveryOutcome } from '@sportkarta/lib/email';
import { PushDeliveryError, type PushPayload, type PushSender } from '@sportkarta/lib/push';
import type { SmsSender } from '@sportkarta/lib/sms';
import { SMS_MAX_PARTS, smsParts, toE164 } from '@sportkarta/lib/sms/text';

/**
 * The two channels beside e-mail (0051): SMS and push. Each send is its own
 * CLAIM-THEN-SEND transaction against club_notifications, keyed by channel,
 * so a message that went by e-mail is never re-sent by e-mail because its SMS
 * failed, and the other way round.
 *
 * A channel is attempted only when POPS runs it (the env master switch AND a
 * transport that is not disabled — decided once at boot, in `on`) and, for
 * SMS, the club's tier includes it. The club's monthly SMS allowance is the
 * database's to enforce (club_notifications_sms_cap): a refused claim is a
 * skip, never a failure, because retrying cannot make the allowance bigger.
 *
 * NO PII IN LOGS: nothing here logs; the callers log counts.
 */

export interface ClubChannelOptions {
  sms: { sender: SmsSender; on: boolean };
  push: { sender: PushSender; on: boolean };
}

const db = () => getDb();

/** «27.10, 18:00» — a time short enough for an SMS or a lock screen. */
export function shortWhen(startsAtLocal: string | undefined): string {
  const match = /^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(startsAtLocal ?? '');
  if (!match) return '';
  const [, month, day, hour, minute] = match;
  return `${String(day)}.${String(month)}, ${String(hour)}:${String(minute)}`;
}

export async function sendSmsTo(
  recipient: MemberChannels,
  message: { kind: ClubNotificationKind; key: string; ledgerMemberId: string; text: string },
  channels: ClubChannelOptions | undefined,
): Promise<DeliveryOutcome> {
  if (!channels?.sms.on || !clubHasFeature(recipient.tier, 'sms') || !recipient.phone) {
    return 'skipped';
  }
  const to = toE164(recipient.phone);
  if (!to) return 'skipped';
  const parts = smsParts(message.text);
  if (parts > SMS_MAX_PARTS) return 'skipped';
  try {
    return await db().transaction(async (tx) => {
      const claimed = await claimClubNotification(tx, {
        clubId: recipient.clubId,
        memberId: message.ledgerMemberId,
        kind: message.kind,
        key: message.key,
        channel: 'sms',
        smsParts: parts,
      });
      if (!claimed) return 'skipped';
      await channels.sms.sender.send({ to, text: message.text });
      return 'sent';
    });
  } catch (error: unknown) {
    if (isSmsCapRefusal(error)) return 'skipped';
    throw error;
  }
}

/** Nothing to deliver to: every device is gone or refuses this message for good. */
class NothingDelivered extends Error {}

/**
 * To every device of the receiving account. The claim stands only when a
 * device took the message (so a broadcast's push count is deliveries, not
 * attempts). When no device took it, the claim is rolled back: THROWN for a
 * retry if a failure may pass (network, 429, 5xx), skipped quietly when
 * every device is gone or refuses for good — retrying cannot help, and those
 * devices are counted towards removal.
 *
 * What each device answered is written AFTER the claim's transaction, so a
 * rollback does not erase it: a dead device is still removed, a failing one
 * still counted.
 */
export async function sendPushTo(
  recipient: MemberChannels,
  message: {
    kind: ClubNotificationKind;
    key: string;
    ledgerMemberId: string;
    payload: PushPayload;
  },
  channels: ClubChannelOptions | undefined,
): Promise<DeliveryOutcome> {
  if (!channels?.push.on || !recipient.pushUserId) return 'skipped';
  const subscriptions = await pushSubscriptionsOf(db(), recipient.pushUserId);
  if (subscriptions.length === 0) return 'skipped';
  const answers: { id: string; result: 'sent' | 'gone' | 'failed' }[] = [];
  try {
    return await db().transaction(async (tx) => {
      const claimed = await claimClubNotification(tx, {
        clubId: recipient.clubId,
        memberId: message.ledgerMemberId,
        kind: message.kind,
        key: message.key,
        channel: 'push',
      });
      if (!claimed) return 'skipped';
      let sent = 0;
      let mayPass = 0;
      for (const subscription of subscriptions) {
        try {
          const result = await channels.push.sender.send(subscription, message.payload);
          answers.push({ id: subscription.id, result: result === 'rejected' ? 'failed' : result });
          if (result === 'sent') sent += 1;
        } catch {
          answers.push({ id: subscription.id, result: 'failed' });
          mayPass += 1;
        }
      }
      if (sent > 0) return 'sent';
      if (mayPass > 0) throw new PushDeliveryError(null);
      throw new NothingDelivered();
    });
  } catch (error: unknown) {
    if (error instanceof NothingDelivered) return 'skipped';
    throw error;
  } finally {
    for (const answer of answers) await notePushResult(db(), answer.id, answer.result);
  }
}
