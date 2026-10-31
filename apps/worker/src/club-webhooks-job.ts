import {
  claimWebhookDeliveries,
  disableFailingEndpoints,
  getDb,
  pruneClubIntegrations,
  settleWebhookDelivery,
  type DueWebhookDelivery,
} from '@sportkarta/db';
import {
  CLUB_TIERS,
  WEBHOOK_DISABLE_AFTER_DAYS,
  WEBHOOK_ROTATION_OVERLAP_HOURS,
  clubHasFeature,
  isClubWebhookEvent,
  webhookBody,
  webhookRetryAfterSeconds,
} from '@sportkarta/lib/clubs';
import { webhookSecretFor, webhookSignatureHeader } from '@sportkarta/lib/clubs/secrets';
import { safePost, type SafePostResult } from '@sportkarta/lib/net';

/**
 * Club webhooks (0057): post what the database queued, sign it, back off.
 *
 *  - OFF unless CLUB_API_ENABLED is "true" and CLUB_WEBHOOK_SECRET is set (32+
 *    characters; deploy.yml derives it from AUTH_SECRET). Like every club
 *    job, it does not read CLUBS_ENABLED: with the module off nothing can
 *    create an endpoint, so the outbox stays empty. Off, nothing is
 *    claimed — the rows wait, and the 30-day prune is the only thing that
 *    touches them.
 *  - Only clubs whose tier includes webhooks, and that operate, are served
 *    (the claim's own predicate): a downgraded club's queue simply stops.
 *  - Every request goes through safePost — https, public addresses only,
 *    checked at connection time, no redirects, a 10-second deadline.
 *  - Signed `POPS-Signature: t=…,v1=…` with the endpoint's derived secret,
 *    and for a day after a rotation with the previous one too. The delivery id
 *    is the receiver's idempotency key (POPS-Delivery, and `id` in the body).
 *
 * The log line carries counts only — never a URL (a club's endpoint may carry
 * a token in its path) and never an id.
 */

export type WebhookPoster = (
  url: string,
  body: string,
  headers: Readonly<Record<string, string>>,
) => Promise<SafePostResult>;

export interface ClubWebhooksReport {
  configured: boolean;
  sent: number;
  failed: number;
  gaveUp: number;
  disabled: number;
}

/** Claims per run, how many per claim, and how many in flight at once. */
const BATCHES = 6;
const BATCH = 40;
const PARALLEL = 8;
/** One endpoint's share of a claim: a slow receiver waits its turn. */
const PER_ENDPOINT = 8;
/** Longer than a batch can take (40 / 8 × 10 s), so a slow run is not re-claimed. */
const LEASE_SECONDS = 180;

function secretsFor(master: string, delivery: DueWebhookDelivery): string[] {
  const secrets = [webhookSecretFor(master, delivery.endpointId, delivery.secretVersion)];
  if (delivery.previousSecretVersion !== null) {
    secrets.push(webhookSecretFor(master, delivery.endpointId, delivery.previousSecretVersion));
  }
  return secrets;
}

async function deliver(
  master: string,
  delivery: DueWebhookDelivery,
  post: WebhookPoster,
): Promise<SafePostResult> {
  if (!isClubWebhookEvent(delivery.event)) {
    return { ok: false, status: null, error: 'http_status' };
  }
  const body = JSON.stringify(
    webhookBody({
      id: delivery.id,
      seq: delivery.seq,
      event: delivery.event,
      occurredAt: delivery.occurredAt,
      clubId: delivery.clubId,
      subjectId: delivery.subjectId,
      memberId: delivery.memberId,
    }),
  );
  const timestamp = Math.floor(Date.now() / 1000);
  return post(delivery.url, body, {
    'content-type': 'application/json',
    'user-agent': 'POPS-Webhooks/1.0 (+https://pops.bg)',
    'pops-delivery': delivery.id,
    'pops-event': delivery.event,
    'pops-signature': webhookSignatureHeader(secretsFor(master, delivery), timestamp, body),
  });
}

export async function runClubWebhooks(
  env: NodeJS.ProcessEnv = process.env,
  post: WebhookPoster = safePost,
): Promise<ClubWebhooksReport> {
  const report: ClubWebhooksReport = {
    configured: false,
    sent: 0,
    failed: 0,
    gaveUp: 0,
    disabled: 0,
  };
  const master = env.CLUB_WEBHOOK_SECRET?.trim() ?? '';
  if (env.CLUB_API_ENABLED !== 'true' || master.length < 32) return report;
  report.configured = true;
  const db = getDb();
  const tiers = CLUB_TIERS.filter((tier) => clubHasFeature(tier, 'webhooks'));
  for (let batch = 0; batch < BATCHES; batch += 1) {
    const due = await claimWebhookDeliveries(db, {
      tiers,
      limit: BATCH,
      perEndpoint: PER_ENDPOINT,
      leaseSeconds: LEASE_SECONDS,
      overlapHours: WEBHOOK_ROTATION_OVERLAP_HOURS,
    });
    for (let start = 0; start < due.length; start += PARALLEL) {
      await Promise.all(
        due.slice(start, start + PARALLEL).map(async (delivery) => {
          const result = await deliver(master, delivery, post);
          const retry = result.ok ? null : webhookRetryAfterSeconds(delivery.attempts + 1);
          await settleWebhookDelivery(db, delivery, result, retry);
          if (result.ok) report.sent += 1;
          else if (retry === null) report.gaveUp += 1;
          else report.failed += 1;
        }),
      );
    }
    if (due.length < BATCH) break;
  }
  report.disabled = await disableFailingEndpoints(db, WEBHOOK_DISABLE_AFTER_DAYS);
  return report;
}

export async function runClubIntegrationsPrune(): Promise<{
  deliveries: number;
  idempotency: number;
}> {
  return pruneClubIntegrations(getDb());
}
