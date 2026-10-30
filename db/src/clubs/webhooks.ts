import { sql, type SQL } from 'drizzle-orm';

/**
 * The worker's side of club webhooks (0057): claim due deliveries, record
 * each attempt, give up on an endpoint that keeps failing, and prune the log.
 * The deliveries were written by club_webhook_enqueue in the transaction that
 * made each change; nothing here decides WHAT to send.
 *
 * CLAIM BY LEASE. A claim moves next_attempt_at forward by the lease, so a
 * worker that dies mid-send leaves rows that come due again by themselves —
 * there is no 'sending' state to get stuck in. FOR UPDATE … SKIP LOCKED keeps
 * two workers off the same row; the endpoints are only read (the desk's
 * enqueue reads them FOR KEY SHARE, and nothing here takes a lock that would
 * queue a desk write behind a slow receiver).
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface DueWebhookDelivery {
  id: string;
  seq: number;
  clubId: string;
  endpointId: string;
  url: string;
  event: string;
  subjectId: string;
  memberId: string | null;
  occurredAt: string;
  attempts: number;
  secretVersion: number;
  /** Set while the previous secret still signs (a day after a rotation). */
  previousSecretVersion: number | null;
}

/**
 * Claim up to `limit` due deliveries to LIVE endpoints of clubs whose tier is
 * one of `tiers` and that operate (status active, within paid time or grace).
 * A delivery to a disabled endpoint is not claimed: member.deleted is held
 * there until the endpoint is enabled again. At most `perEndpoint` rows of
 * one endpoint per claim: a receiver that answers slowly (or never) takes
 * its turn, and does not hold every other club's events behind it.
 */
export async function claimWebhookDeliveries(
  db: SqlRunner,
  options: {
    tiers: readonly string[];
    limit: number;
    perEndpoint: number;
    leaseSeconds: number;
    overlapHours: number;
  },
): Promise<DueWebhookDelivery[]> {
  if (options.tiers.length === 0) return [];
  const result = await db.execute(sql`
    WITH ranked AS (
      SELECT d.id, d.next_attempt_at, d.seq,
             row_number() OVER (PARTITION BY d.endpoint_id ORDER BY d.next_attempt_at, d.seq) AS rn
        FROM club_webhook_deliveries d
        JOIN club_webhook_endpoints e ON e.club_id = d.club_id AND e.id = d.endpoint_id
        JOIN clubs c ON c.id = d.club_id
       WHERE d.state = 'pending' AND d.next_attempt_at <= now()
         AND e.disabled_at IS NULL
         AND c.tier = ANY(${sql.param([...options.tiers])}::text[])
         AND c.status = 'active'
         AND (c.tier = 'community'
              OR greatest(c.paid_until, c.trial_ends_on) + 14 >= (now() AT TIME ZONE 'Europe/Sofia')::date)
    ), due AS (
      SELECT d.id
        FROM club_webhook_deliveries d
        JOIN ranked r ON r.id = d.id
       WHERE r.rn <= ${options.perEndpoint} AND d.state = 'pending'
       ORDER BY r.next_attempt_at, r.seq
       LIMIT ${options.limit}
       FOR UPDATE OF d SKIP LOCKED
    )
    UPDATE club_webhook_deliveries d
       SET next_attempt_at = now() + make_interval(secs => ${options.leaseSeconds})
      FROM due, club_webhook_endpoints e
     WHERE d.id = due.id AND e.club_id = d.club_id AND e.id = d.endpoint_id
    RETURNING d.id, d.seq, d.club_id, d.endpoint_id, e.url, d.event, d.subject_id, d.member_id,
              d.occurred_at, d.attempts, e.secret_version,
              (e.secret_version > 1 AND e.secret_rotated_at
                 > now() - make_interval(hours => ${options.overlapHours})) AS overlap
  `);
  return result.rows
    .map((row) => ({
      id: String(row.id),
      seq: Number(row.seq),
      clubId: String(row.club_id),
      endpointId: String(row.endpoint_id),
      url: String(row.url),
      event: String(row.event),
      subjectId: String(row.subject_id),
      memberId: row.member_id === null ? null : String(row.member_id),
      occurredAt: new Date(String(row.occurred_at)).toISOString(),
      attempts: Number(row.attempts),
      secretVersion: Number(row.secret_version),
      previousSecretVersion: row.overlap === true ? Number(row.secret_version) - 1 : null,
    }))
    .sort((a, b) => a.seq - b.seq);
}

export interface WebhookAttempt {
  ok: boolean;
  status: number | null;
  error: string | null;
}

/**
 * Record one attempt. Delivered; or failed and due again after
 * `retryAfterSeconds`; or, with null, given up ('failed'). The endpoint's
 * health moves with it: a success clears failing_since, a failure starts it.
 */
export async function settleWebhookDelivery(
  db: SqlRunner,
  delivery: Pick<DueWebhookDelivery, 'id' | 'clubId' | 'endpointId'>,
  attempt: WebhookAttempt,
  retryAfterSeconds: number | null,
): Promise<void> {
  if (attempt.ok) {
    await db.execute(sql`
      UPDATE club_webhook_deliveries
         SET state = 'delivered', delivered_at = now(), attempts = attempts + 1,
             last_attempt_at = now(), last_status = ${attempt.status}, last_error = NULL
       WHERE id = ${delivery.id}::uuid AND state = 'pending'
    `);
    await db.execute(sql`
      UPDATE club_webhook_endpoints
         SET last_success_at = now(), failing_since = NULL
       WHERE club_id = ${delivery.clubId}::uuid AND id = ${delivery.endpointId}::uuid
    `);
    return;
  }
  await db.execute(sql`
    UPDATE club_webhook_deliveries
       SET attempts = attempts + 1, last_attempt_at = now(), last_status = ${attempt.status},
           last_error = ${attempt.error},
           state = ${retryAfterSeconds === null ? 'failed' : 'pending'},
           next_attempt_at = now() + make_interval(secs => ${retryAfterSeconds ?? 0})
     WHERE id = ${delivery.id}::uuid AND state = 'pending'
  `);
  await db.execute(sql`
    UPDATE club_webhook_endpoints
       SET failing_since = now()
     WHERE club_id = ${delivery.clubId}::uuid AND id = ${delivery.endpointId}::uuid
       AND failing_since IS NULL
  `);
}

/**
 * Disable every endpoint that has failed for `days` without one success
 * ('failing'), close its waiting deliveries — all but member.deleted, which
 * is held for when it is enabled again — and say so in the club's log.
 */
export async function disableFailingEndpoints(db: SqlRunner, days: number): Promise<number> {
  const result = await db.execute(sql`
    WITH off AS (
      UPDATE club_webhook_endpoints
         SET disabled_at = now(), disabled_reason = 'failing'
       WHERE disabled_at IS NULL AND failing_since < now() - make_interval(days => ${days})
      RETURNING club_id, id
    ), closed AS (
      UPDATE club_webhook_deliveries d
         SET state = 'failed', last_error = 'endpoint_disabled'
        FROM off
       WHERE d.club_id = off.club_id AND d.endpoint_id = off.id AND d.state = 'pending'
         AND d.event <> 'member.deleted'
      RETURNING d.id
    ), logged AS (
      INSERT INTO club_audit (club_id, actor_id, actor_kind, action, detail)
      SELECT off.club_id, NULL, 'system', 'webhook_disabled',
             jsonb_build_object('endpoint', off.id::text, 'reason', 'failing')
        FROM off
      RETURNING club_id
    )
    SELECT (SELECT count(*) FROM off)::int AS disabled,
           (SELECT count(*) FROM closed)::int AS closed,
           (SELECT count(*) FROM logged)::int AS logged
  `);
  return Number(result.rows[0]?.disabled ?? 0);
}

/**
 * The delivery log keeps 30 days; an idempotency record, one. Both are
 * conveniences, not records — the outcome of every write is in the club's
 * own tables and its audit log.
 */
export async function pruneClubIntegrations(
  db: SqlRunner,
): Promise<{ deliveries: number; idempotency: number }> {
  const deliveries = await db.execute(sql`
    DELETE FROM club_webhook_deliveries WHERE occurred_at < now() - interval '30 days'
    RETURNING 1
  `);
  const idempotency = await db.execute(sql`
    DELETE FROM club_api_idempotency WHERE created_at < now() - interval '1 day'
    RETURNING 1
  `);
  return { deliveries: deliveries.rows.length, idempotency: idempotency.rows.length };
}
