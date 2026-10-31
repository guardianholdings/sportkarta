import 'server-only';

import { getDb, sql, type SQL } from '@sportkarta/db';
import {
  CLUB_WEBHOOK_ENDPOINTS_MAX,
  isClubWebhookEvent,
  type ClubWebhookDeliveryError,
  type ClubWebhookDeliveryState,
  type ClubWebhookEvent,
} from '@sportkarta/lib/clubs';
import { webhookSecretFor } from '@sportkarta/lib/clubs/secrets';

import { recordClubAudit } from './audit';
import { clubFeatureSql } from './features';
import { clubScope, clubStaffWriteScope, type ClubActor } from './scope';

/**
 * A club's webhook endpoints (0057), seen from the office.
 *
 * The SIGNING SECRET IS DERIVED, never stored: HMAC of the endpoint id and
 * its version under CLUB_WEBHOOK_SECRET. It is shown once — when the endpoint
 * is added and when it is rotated — to the member of staff who did it. Adding,
 * re-enabling and rotating are the club's own management's (an NGO admin never
 * points a club's data at a URL, nor sees its secret); disabling and removing
 * are protective, so the NGO admin may, and they work while the club is
 * read-only.
 *
 * The deliveries themselves are written by the database (club_webhook_enqueue)
 * and sent by the worker; this module only lists them.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TransactionalDb extends SqlRunner {
  transaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

/**
 * The master the per-endpoint secrets derive from. Unset (or short) means
 * webhooks are OFF — fail closed, like CHECKIN_TOKEN_SECRET: deploy.yml
 * derives it from AUTH_SECRET under its own label. Changing it rotates every
 * endpoint's secret at once.
 */
export function webhookMasterSecret(): string | null {
  const secret = process.env.CLUB_WEBHOOK_SECRET?.trim();
  return secret && secret.length >= 32 ? secret : null;
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function iso(value: unknown): string | null {
  return value === null || value === undefined ? null : new Date(String(value)).toISOString();
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  events: ClubWebhookEvent[];
  description: string | null;
  disabled: 'manual' | 'failing' | null;
  /** Who added it; an endpoint outlives them, so the office shows it. */
  creatorName: string | null;
  creatorActive: boolean;
  failingSince: string | null;
  lastSuccessAt: string | null;
  createdAt: string;
  pending: number;
  failedLastWeek: number;
}

export async function listWebhookEndpoints(actor: ClubActor): Promise<WebhookEndpoint[]> {
  const result = await getDb().execute(sql`
    SELECT we.id, we.url, we.events, we.description, we.disabled_reason, we.failing_since,
           we.last_success_at, we.created_at,
           coalesce(nullif(btrim(st.display_name), ''), nullif(btrim(u.display_name), '')) AS creator_name,
           (st.user_id IS NOT NULL AND u.suspended_at IS NULL) AS creator_active,
           (SELECT count(*)::int FROM club_webhook_deliveries d
             WHERE d.club_id = we.club_id AND d.endpoint_id = we.id AND d.state = 'pending') AS pending,
           (SELECT count(*)::int FROM club_webhook_deliveries d
             WHERE d.club_id = we.club_id AND d.endpoint_id = we.id AND d.state = 'failed'
               AND d.occurred_at > now() - interval '7 days') AS failed_week
      FROM club_webhook_endpoints we
      LEFT JOIN club_staff st ON st.club_id = we.club_id AND st.user_id = we.created_by
      LEFT JOIN users u ON u.id = we.created_by
     WHERE ${clubScope(actor, 'api.manage', 'we')}
     ORDER BY we.created_at, we.id
  `);
  return result.rows.map((row) => ({
    id: String(row.id),
    url: String(row.url),
    events: Array.isArray(row.events) ? row.events.filter(isClubWebhookEvent) : [],
    description: text(row.description),
    disabled:
      row.disabled_reason === 'manual' || row.disabled_reason === 'failing'
        ? row.disabled_reason
        : null,
    creatorName: text(row.creator_name),
    creatorActive: row.creator_active === true,
    failingSince: iso(row.failing_since),
    lastSuccessAt: iso(row.last_success_at),
    createdAt: iso(row.created_at) ?? '',
    pending: Number(row.pending ?? 0),
    failedLastWeek: Number(row.failed_week ?? 0),
  }));
}

export interface WebhookDelivery {
  id: string;
  event: ClubWebhookEvent;
  state: ClubWebhookDeliveryState;
  attempts: number;
  lastStatus: number | null;
  lastError: ClubWebhookDeliveryError | null;
  occurredAt: string;
}

/** The newest deliveries to one endpoint — the log the office shows. */
export async function listWebhookDeliveries(
  actor: ClubActor,
  endpointId: string,
  limit = 20,
): Promise<WebhookDelivery[]> {
  const result = await getDb().execute(sql`
    SELECT wd.id, wd.event, wd.state, wd.attempts, wd.last_status, wd.last_error, wd.occurred_at
      FROM club_webhook_deliveries wd
     WHERE ${clubScope(actor, 'api.manage', 'wd')} AND wd.endpoint_id = ${endpointId}::uuid
     ORDER BY wd.occurred_at DESC, wd.id
     LIMIT ${Math.max(1, Math.min(limit, 100))}
  `);
  return result.rows.flatMap((row) =>
    isClubWebhookEvent(row.event)
      ? [
          {
            id: String(row.id),
            event: row.event,
            state: String(row.state) as ClubWebhookDeliveryState,
            attempts: Number(row.attempts ?? 0),
            lastStatus: row.last_status === null ? null : Number(row.last_status),
            lastError: text(row.last_error) as ClubWebhookDeliveryError | null,
            occurredAt: iso(row.occurred_at) ?? '',
          },
        ]
      : [],
  );
}

export type AddEndpointResult =
  | { ok: true; id: string; secret: string }
  | { ok: false; error: 'too_many_endpoints' | 'not_allowed' | 'not_configured' };

/** Add an endpoint; its secret (version 1) is returned once. */
export async function addWebhookEndpoint(
  db: TransactionalDb,
  actor: ClubActor,
  input: { url: string; events: readonly ClubWebhookEvent[]; description: string | null },
): Promise<AddEndpointResult> {
  const master = webhookMasterSecret();
  if (!master) return { ok: false, error: 'not_configured' };
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`club_webhooks:${actor.clubId}`}, 0))`,
    );
    const created = await tx.execute(sql`
      INSERT INTO club_webhook_endpoints (club_id, url, events, description, created_by)
      SELECT we.club_id, ${input.url}, ${sql.param([...input.events])}::text[],
             ${input.description}, ${actor.userId}
        -- The adding member of staff's own row: only the club's own management.
        FROM club_staff we
       WHERE we.user_id = ${actor.userId} AND ${clubStaffWriteScope(actor, 'api.manage', 'we')}
         AND ${clubFeatureSql(actor.clubId, 'webhooks')}
         AND (SELECT count(*) FROM club_webhook_endpoints e WHERE e.club_id = we.club_id)
             < ${CLUB_WEBHOOK_ENDPOINTS_MAX}
      RETURNING id
    `);
    const id = text(created.rows[0]?.id);
    if (!id) {
      const count = await tx.execute(sql`
        SELECT count(*)::int AS n FROM club_webhook_endpoints WHERE club_id = ${actor.clubId}::uuid
      `);
      const full = Number(count.rows[0]?.n ?? 0) >= CLUB_WEBHOOK_ENDPOINTS_MAX;
      return { ok: false, error: full ? 'too_many_endpoints' : 'not_allowed' } as const;
    }
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'webhook_saved',
      detail: { endpoint: id, events: input.events.length },
    });
    return { ok: true, id, secret: webhookSecretFor(master, id, 1) } as const;
  });
}

/**
 * Stop sending. The deliveries still waiting are closed as 'failed'
 * (endpoint_disabled), so re-enabling does not replay a backlog of stale
 * events at the receiver — all but member.deleted, which is held (and still
 * queued) until the endpoint is enabled again: an erasure the integration
 * never hears of is the one loss that matters (0057).
 */
export async function disableWebhookEndpoint(
  db: TransactionalDb,
  actor: ClubActor,
  endpointId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE club_webhook_endpoints we
         SET disabled_at = now(), disabled_reason = 'manual'
       WHERE we.id = ${endpointId}::uuid AND we.disabled_at IS NULL
         AND ${clubScope(actor, 'api.manage', 'we')}
      RETURNING we.id
    `);
    if (updated.rows.length === 0) return false;
    await tx.execute(sql`
      UPDATE club_webhook_deliveries
         SET state = 'failed', last_error = 'endpoint_disabled'
       WHERE club_id = ${actor.clubId}::uuid AND endpoint_id = ${endpointId}::uuid
         AND state = 'pending' AND event <> 'member.deleted'
    `);
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'webhook_disabled',
      detail: { endpoint: endpointId },
    });
    return true;
  });
}

/** Send again — the club's own management, while the club operates. */
export async function enableWebhookEndpoint(
  db: TransactionalDb,
  actor: ClubActor,
  endpointId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE club_webhook_endpoints we
         SET disabled_at = NULL, disabled_reason = NULL, failing_since = NULL
       WHERE we.id = ${endpointId}::uuid AND we.disabled_at IS NOT NULL
         AND ${clubStaffWriteScope(actor, 'api.manage', 'we')}
         AND ${clubFeatureSql(actor.clubId, 'webhooks')}
      RETURNING we.id
    `);
    if (updated.rows.length === 0) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'webhook_enabled',
      detail: { endpoint: endpointId },
    });
    return true;
  });
}

/**
 * A new secret for an endpoint, shown once. For a day the previous one signs
 * too, so the receiver can switch without dropping an event — unless
 * `expireNow` (a leaked secret): then the old one stops at once. The worker
 * signs with the previous version while secret_rotated_at is within the day,
 * so expiring now dates the rotation back past it.
 */
export async function rotateWebhookSecret(
  db: TransactionalDb,
  actor: ClubActor,
  endpointId: string,
  options: { expireNow?: boolean } = {},
): Promise<string | null> {
  const master = webhookMasterSecret();
  if (!master) return null;
  return db.transaction(async (tx) => {
    const rotated = await tx.execute(sql`
      UPDATE club_webhook_endpoints we
         SET secret_version = we.secret_version + 1,
             secret_rotated_at = ${options.expireNow ? sql`now() - interval '2 days'` : sql`now()`}
       WHERE we.id = ${endpointId}::uuid
         AND ${clubStaffWriteScope(actor, 'api.manage', 'we')}
      RETURNING we.secret_version
    `);
    const version = rotated.rows[0]?.secret_version;
    if (version === undefined) return null;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'webhook_secret_rotated',
      detail: { endpoint: endpointId, expiredNow: options.expireNow === true },
    });
    return webhookSecretFor(master, endpointId, Number(version));
  });
}

/** Remove an endpoint and its log (the log is a 30-day convenience, not a record). */
export async function removeWebhookEndpoint(
  db: TransactionalDb,
  actor: ClubActor,
  endpointId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const removed = await tx.execute(sql`
      DELETE FROM club_webhook_endpoints we
       WHERE we.id = ${endpointId}::uuid AND ${clubScope(actor, 'api.manage', 'we')}
      RETURNING we.id
    `);
    if (removed.rows.length === 0) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'webhook_removed',
      detail: { endpoint: endpointId },
    });
    return true;
  });
}
