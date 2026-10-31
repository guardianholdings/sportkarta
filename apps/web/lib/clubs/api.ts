import 'server-only';

import { getDb, sql } from '@sportkarta/db';
import type { ClubApiScope } from '@sportkarta/lib/clubs';
import { sha256Hex } from '@sportkarta/lib/clubs/secrets';

import { clientIpFromForwardedFor } from '@/lib/rate-limit';

import { clubsEnabled } from './access';
import { verifyClubApiKey, type VerifiedClubKey } from './api-keys';
import { clubSwitchOn, featureOn } from './features';
import { CLUB_API_PER_MINUTE, clubApiFailureLimiter, clubApiKeyLimiter } from './rate-limit';

/**
 * The club API's plumbing (0057): authentication, limits, idempotency and
 * the envelope. The routes under app/api/clubs/v1 and the MCP connector at
 * app/api/clubs/mcp both go through `authenticateClubApi`.
 *
 * `Authorization: Bearer skbk_…` AND NOTHING ELSE — the open-data rules
 * (apps/web/lib/opendata/response.ts): no key in a query string (it would sit
 * in every log and Referer between the caller and us), and no cookie. Unlike
 * open data, this API is NOT CORS-open: it serves a club's client records, a
 * key belongs on a server, and a browser page on another origin gets nothing.
 *
 * Every response is `no-store`. Every error is `{ "error": { "code", "message" } }`
 * with a stable code; the messages are English, for developers.
 */

export function apiJson(
  body: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

export function apiError(
  status: number,
  code: string,
  message: string,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return apiJson({ error: { code, message } }, status, headers);
}

function bearer(request: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec((request.headers.get('authorization') ?? '').trim());
  return match?.[1] ?? null;
}

export interface ApiCaller {
  key: VerifiedClubKey;
  /** RateLimit-* — every response carries them. */
  headers: Record<string, string>;
}

export type ApiAuth = { ok: true; caller: ApiCaller } | { ok: false; response: Response };

/**
 * Who is calling, and may they? In order: the module and the API are on
 * (404 otherwise — the API does not exist), a well-formed bearer key (401),
 * the per-IP cap on failed keys (429), the key verifies (401), the club's
 * tier includes the feature (403), the key's minute budget (429), the scope
 * (403). The scope check is the code's; the creator's CURRENT permission is
 * the statement's, in every function the route then calls.
 */
export async function authenticateClubApi(
  request: Request,
  options: { scope: ClubApiScope | null; feature?: 'api' | 'mcp' },
): Promise<ApiAuth> {
  if (!clubsEnabled() || !clubSwitchOn('api')) {
    return { ok: false, response: apiError(404, 'not_found', 'Not found.') };
  }
  const presented = bearer(request);
  if (!presented) {
    return {
      ok: false,
      response: apiError(
        401,
        'unauthorized',
        'Send the club API key in the Authorization header: "Bearer skbk_…".',
        { 'WWW-Authenticate': 'Bearer realm="pops"' },
      ),
    };
  }
  // Only a FAILED key costs a slot, so a busy integration's burst of good
  // requests never trips it; the cap is per surface, so a misconfigured
  // integration on a club's network never locks out its turnstile. No
  // resolvable IP — no proxy in front, so not production — is not limited.
  const ip = clientIpFromForwardedFor(request.headers.get('x-forwarded-for'));
  const failureKey = ip ? `api:${ip}` : null;
  if (failureKey) {
    const gate = clubApiFailureLimiter.wouldRefuse(failureKey);
    if (!gate.allowed) {
      return {
        ok: false,
        response: apiError(429, 'too_many_failures', 'Too many failed keys. Wait and retry.', {
          'Retry-After': String(Math.ceil(gate.retryAfterMs / 1000)),
        }),
      };
    }
  }
  const key = await verifyClubApiKey(presented);
  if (!key) {
    if (failureKey) clubApiFailureLimiter.check(failureKey);
    return {
      ok: false,
      response: apiError(
        401,
        'invalid_key',
        'The key is unknown or revoked, its creator no longer works at the club, or the club is not operating.',
        { 'WWW-Authenticate': 'Bearer realm="pops", error="invalid_token"' },
      ),
    };
  }
  const feature = options.feature ?? 'api';
  if (!featureOn({ tier: key.tier }, feature)) {
    return {
      ok: false,
      response: apiError(
        403,
        'feature_not_in_plan',
        `The club's plan does not include "${feature}".`,
      ),
    };
  }
  const budget = clubApiKeyLimiter.check(key.keyId);
  const headers: Record<string, string> = {
    'RateLimit-Limit': String(CLUB_API_PER_MINUTE),
    'RateLimit-Remaining': String(
      Math.max(0, CLUB_API_PER_MINUTE - clubApiKeyLimiter.count(key.keyId)),
    ),
    'RateLimit-Reset': budget.allowed ? '60' : String(Math.ceil(budget.retryAfterMs / 1000)),
  };
  if (!budget.allowed) {
    return {
      ok: false,
      response: apiError(429, 'rate_limited', 'Too many requests for this key. Wait and retry.', {
        ...headers,
        'Retry-After': String(Math.ceil(budget.retryAfterMs / 1000)),
      }),
    };
  }
  if (options.scope && !key.scopes.includes(options.scope)) {
    return {
      ok: false,
      response: apiError(
        403,
        'insufficient_scope',
        `This key lacks the "${options.scope}" scope.`,
        {
          ...headers,
          'WWW-Authenticate': `Bearer realm="pops", error="insufficient_scope", scope="${options.scope}"`,
        },
      ),
    };
  }
  return { ok: true, caller: { key, headers } };
}

/** At most this much request body — a member record is a few hundred bytes. */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * The body as text, or null past `maxBytes` — read as a stream and abandoned
 * at the cap, so a large body is never buffered (nothing in front of the app
 * limits a request body). A Content-Length over the cap is refused unread.
 */
export async function readCappedText(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The raw body (for the idempotency hash) and its JSON object, or an error response. */
export async function readJsonObject(
  request: Request,
  headers: Readonly<Record<string, string>>,
): Promise<
  { ok: true; raw: string; value: Record<string, unknown> } | { ok: false; response: Response }
> {
  const type = request.headers.get('content-type') ?? '';
  if (!/^application\/json\b/i.test(type)) {
    return {
      ok: false,
      response: apiError(
        415,
        'unsupported_media_type',
        'Send a JSON body (application/json).',
        headers,
      ),
    };
  }
  const raw = await readCappedText(request, MAX_BODY_BYTES);
  if (raw === null) {
    return { ok: false, response: apiError(413, 'too_large', 'The body is too large.', headers) };
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TypeError('not an object');
    }
    return { ok: true, raw, value: value as Record<string, unknown> };
  } catch {
    return {
      ok: false,
      response: apiError(400, 'invalid_json', 'The body is not a JSON object.', headers),
    };
  }
}

// ─── Idempotency ─────────────────────────────────────────────────────────

/** What a write produced: a status and what it made, or a closed error code. */
export interface ApiOutcome {
  status: number;
  resultKind?: 'member' | 'booking' | 'checkin';
  resultId?: string;
  errorCode?: string;
}

/**
 * A request left 'pending' this long was abandoned (a crash): it may be
 * retried. Far longer than any write can run — a takeover of a write that is
 * merely slow would run it twice.
 */
const STALE_PENDING_SECONDS = 15 * 60;

type IdempotencyStart =
  | { kind: 'fresh' }
  | { kind: 'replay'; outcome: ApiOutcome }
  | { kind: 'conflict' }
  | { kind: 'in_progress' };

/**
 * Claim (key, Idempotency-Key). Scoped by the key that was just verified —
 * the row is the key's own — and expired rows (a day old, which the worker
 * has not pruned yet) and abandoned ones are taken over.
 */
async function claimIdempotency(
  key: VerifiedClubKey,
  idempotencyKey: string,
  requestHash: string,
): Promise<IdempotencyStart> {
  const db = getDb();
  const claimed = await db.execute(sql`
    INSERT INTO club_api_idempotency AS ai (club_id, key_id, idempotency_key, request_hash)
    VALUES (${key.clubId}::uuid, ${key.keyId}::uuid, ${idempotencyKey}, ${requestHash})
    ON CONFLICT (key_id, idempotency_key) DO UPDATE
       SET request_hash = EXCLUDED.request_hash, state = 'pending', status_code = NULL,
           result_kind = NULL, result_id = NULL, error_code = NULL, created_at = now()
     WHERE ai.created_at < now() - interval '1 day'
        OR (ai.state = 'pending' AND ai.request_hash = EXCLUDED.request_hash
            AND ai.created_at < now() - make_interval(secs => ${STALE_PENDING_SECONDS}))
    RETURNING ai.state
  `);
  if (claimed.rows.length > 0) return { kind: 'fresh' };
  const existing = await db.execute(sql`
    SELECT request_hash, state, status_code, result_kind, result_id, error_code
      FROM club_api_idempotency
     WHERE key_id = ${key.keyId}::uuid AND idempotency_key = ${idempotencyKey}
  `);
  const row = existing.rows[0];
  if (!row) return { kind: 'in_progress' };
  if (String(row.request_hash) !== requestHash) return { kind: 'conflict' };
  if (row.state !== 'done') return { kind: 'in_progress' };
  const kind = row.result_kind;
  return {
    kind: 'replay',
    outcome: {
      status: Number(row.status_code),
      resultKind: kind === 'member' || kind === 'booking' || kind === 'checkin' ? kind : undefined,
      resultId: row.result_id === null ? undefined : String(row.result_id),
      errorCode: row.error_code === null ? undefined : String(row.error_code),
    },
  };
}

async function settleIdempotency(
  key: VerifiedClubKey,
  idempotencyKey: string,
  outcome: ApiOutcome | null,
): Promise<void> {
  const db = getDb();
  if (outcome === null) {
    // The handler threw: give the key back so a retry runs afresh.
    await db.execute(sql`
      DELETE FROM club_api_idempotency
       WHERE key_id = ${key.keyId}::uuid AND idempotency_key = ${idempotencyKey}
         AND state = 'pending'
    `);
    return;
  }
  await db.execute(sql`
    UPDATE club_api_idempotency
       SET state = 'done', status_code = ${outcome.status},
           result_kind = ${outcome.resultKind ?? null}, result_id = ${outcome.resultId ?? null},
           error_code = ${outcome.errorCode ?? null}
     WHERE key_id = ${key.keyId}::uuid AND idempotency_key = ${idempotencyKey}
  `);
}

/**
 * Run a write at most once per Idempotency-Key (optional, like Stripe's; a
 * client that retries should send one). A replay re-renders the outcome —
 * the record is read afresh, so it shows what is true now — with
 * `Idempotent-Replayed: true`.
 */
export async function idempotently(
  request: Request,
  caller: ApiCaller,
  rawBody: string,
  run: () => Promise<ApiOutcome>,
  render: (outcome: ApiOutcome) => Promise<Response>,
): Promise<Response> {
  const header = request.headers.get('idempotency-key');
  if (header === null) return render(await run());
  if (!/^[!-~]{1,255}$/.test(header)) {
    return apiError(
      400,
      'invalid_idempotency_key',
      'Idempotency-Key is 1–255 printable ASCII characters, no spaces.',
      caller.headers,
    );
  }
  const hash = sha256Hex(`${request.method} ${new URL(request.url).pathname}\n${rawBody}`);
  const start = await claimIdempotency(caller.key, header, hash);
  if (start.kind === 'conflict') {
    return apiError(
      422,
      'idempotency_key_reused',
      'This Idempotency-Key was used with a different request.',
      caller.headers,
    );
  }
  if (start.kind === 'in_progress') {
    return apiError(
      409,
      'idempotency_in_progress',
      'A request with this Idempotency-Key is still running. Retry shortly.',
      caller.headers,
    );
  }
  if (start.kind === 'replay') {
    const response = await render(start.outcome);
    response.headers.set('Idempotent-Replayed', 'true');
    return response;
  }
  let outcome: ApiOutcome;
  try {
    outcome = await run();
  } catch (error: unknown) {
    await settleIdempotency(caller.key, header, null);
    throw error;
  }
  await settleIdempotency(caller.key, header, outcome);
  return render(outcome);
}

/** Developer-facing words for the closed error codes a write can end in. */
const OUTCOME_MESSAGES: Readonly<Record<string, string>> = {
  not_allowed: "The key's creator may not do this, or the record is not this club's.",
  not_found: 'No such record at this club.',
  invalid_field: 'A field has the wrong type. See the documentation.',
  guardian_invalid: 'guardian_member_id must name an adult client record of this club.',
  already: 'Already booked.',
  closed: 'The class is cancelled.',
  not_open_yet: 'Booking for this class has not opened yet.',
  started: 'The class has started.',
  strikes_reached: "The client's booking strikes are at the club's limit.",
  not_cancellable: 'Not an active booking of a class still to come, or already attended.',
  too_early: 'The class has not begun yet.',
  club_closed: 'The club is not operating.',
};

/** An outcome that ended in an error, as the error envelope. */
export function outcomeError(
  outcome: ApiOutcome,
  headers: Readonly<Record<string, string>>,
): Response {
  const code = outcome.errorCode ?? 'refused';
  const message =
    OUTCOME_MESSAGES[code] ??
    (outcome.status === 400 ? `Invalid input: ${code}.` : 'The request was refused.');
  return apiError(outcome.status, code, message, headers);
}

// ─── Query parameters ────────────────────────────────────────────────────

/** A civil date parameter (`YYYY-MM-DD`), validated as a real day. */
export function dayParam(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : value;
}

/** Whole days from `from` to `to`. */
export function daySpan(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
