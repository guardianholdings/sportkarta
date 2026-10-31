import { issueClubToken } from '@sportkarta/lib/checkin-token';
import { addDaysIso, sofiaToday } from '@sportkarta/lib/clubs';
import { verifyWebhookSignature } from '@sportkarta/lib/clubs/secrets';
import { getDb, getPool, sql } from '@sportkarta/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { POST as mcpPost } from '@/app/api/clubs/mcp/route';
import { POST as accessCheck } from '@/app/api/clubs/v1/access/check/route';
import { POST as bookingsPost } from '@/app/api/clubs/v1/bookings/route';
import { GET as checkinGet } from '@/app/api/clubs/v1/checkins/[id]/route';
import { GET as checkinsGet, POST as checkinsPost } from '@/app/api/clubs/v1/checkins/route';
import { GET as clubGet } from '@/app/api/clubs/v1/club/route';
import { GET as memberGet } from '@/app/api/clubs/v1/members/[id]/route';
import { GET as membersGet, POST as membersPost } from '@/app/api/clubs/v1/members/route';
import {
  issueClubApiKey,
  listClubApiKeys,
  revokeClubApiKey,
  verifyClubApiKey,
} from '@/lib/clubs/api-keys';
import { createDoorDevice, revokeDoorDevice } from '@/lib/clubs/doors';
import { kioskFromCookie } from '@/lib/clubs/kiosk';
import { eraseMember, issueMemberCard } from '@/lib/clubs/members';
import type { ClubActor } from '@/lib/clubs/scope';
import {
  addWebhookEndpoint,
  disableWebhookEndpoint,
  enableWebhookEndpoint,
  listWebhookDeliveries,
  removeWebhookEndpoint,
  rotateWebhookSecret,
} from '@/lib/clubs/webhooks';

import { runClubWebhooks, type WebhookPoster } from '../../../worker/src/club-webhooks-job';
import { hasDb } from './db';

vi.mock('server-only', () => ({}));

/**
 * The club API, webhooks, doors and the MCP connector (0057), end to end
 * against real Postgres, through the route handlers themselves. What must
 * hold:
 *
 *   * only the club's own management issues a key, on a tier that has the
 *     API; a key acts as its creator — revoked, or the creator gone, it is
 *     refused; the database never sees the key, only its hash;
 *   * every request is scoped (the key's scope, then the creator's role in
 *     the statement); an Idempotency-Key replays the same outcome and refuses
 *     a different request;
 *   * a change made anywhere is queued for a subscribed endpoint by the
 *     database, posted signed by the worker, retried with backoff and given
 *     up after eight attempts; a disabled endpoint holds member.deleted only;
 *   * a door opens by its club's rule and records the visit; a refused door
 *     records nothing; a door's secret is never a kiosk's;
 *   * the MCP connector lists only the tools the key's scopes allow.
 *
 * COMMITS under its own `e2e-jh-*` clubs and `e2e_club_jh_*` accounts,
 * removed through the real purge path.
 */

const PREFIX = 'e2e_club_jh_';
const WEBHOOK_SECRET = 'a-test-webhook-master-secret-of-32-plus-chars';
const CHECKIN_SECRET = 'a-test-checkin-token-secret-of-32-plus-chars';

async function cleanup(): Promise<void> {
  const db = getDb();
  const clubs = await db.execute(sql`SELECT id FROM clubs WHERE slug LIKE 'e2e-jh-%'`);
  for (const row of clubs.rows) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('pops.purging_club', ${String(row.id)}, true)`);
      await tx.execute(sql`DELETE FROM clubs WHERE id = ${String(row.id)}::uuid`);
    });
  }
  await db.execute(sql`DELETE FROM users WHERE id LIKE ${`${PREFIX}%`}`);
}

function call(
  path: string,
  options: { key?: string; method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.key) headers.authorization = `Bearer ${options.key}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`http://localhost${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function data(body: Record<string, unknown>): Record<string, unknown> {
  return body.data as Record<string, unknown>;
}

describe.skipIf(!hasDb)('club integrations journey (requires running database)', () => {
  let db: ReturnType<typeof getDb>;
  let clubId = '';
  let slug = '';
  let locationId = '';
  let owner: ClubActor;
  let desk: ClubActor;
  let manager: ClubActor;
  let ngoAdmin: ClubActor;

  async function account(label: string, role = 'user'): Promise<string> {
    const id = `${PREFIX}${label}_${Math.random().toString(36).slice(2, 8)}`;
    await db.execute(sql`
      INSERT INTO users (id, display_name, email, email_verified, role)
      VALUES (${id}, ${`Служител ${label}`}, ${`${id}@example.org`}, true, ${role})
    `);
    return id;
  }

  async function staff(role: 'owner' | 'manager' | 'desk'): Promise<ClubActor> {
    const userId = await account(role);
    await db.execute(sql`
      INSERT INTO club_staff (club_id, user_id, role) VALUES (${clubId}::uuid, ${userId}, ${role})
    `);
    return { userId, clubId, role, ngoAdmin: false };
  }

  async function member(label: string): Promise<string> {
    const created = await db.execute(sql`
      INSERT INTO club_members (club_id, display_name) VALUES (${clubId}::uuid, ${label})
      RETURNING id
    `);
    return String(created.rows[0]?.id);
  }

  beforeAll(async () => {
    vi.stubEnv('CLUBS_ENABLED', 'true');
    vi.stubEnv('CLUB_API_ENABLED', 'true');
    vi.stubEnv('CLUB_WEBHOOK_SECRET', WEBHOOK_SECRET);
    vi.stubEnv('CHECKIN_TOKEN_SECRET', CHECKIN_SECRET);
    db = getDb();
    await cleanup();
    slug = `e2e-jh-${Math.random().toString(36).slice(2, 8)}`;
    const club = await db.execute(sql`
      INSERT INTO clubs (slug, name_bg, tier, status, approved_at, paid_until, visible)
      VALUES (${slug}, 'Клуб Интеграции', 'pro', 'active', now(),
              (now() + interval '1 year')::date, true)
      RETURNING id
    `);
    clubId = String(club.rows[0]?.id);
    owner = await staff('owner');
    manager = await staff('manager');
    desk = await staff('desk');
    ngoAdmin = { userId: await account('admin', 'admin'), clubId, role: null, ngoAdmin: true };
    const location = await db.execute(sql`
      INSERT INTO club_locations (club_id, name, address)
      VALUES (${clubId}::uuid, 'Зала', 'ул. Тестова 3') RETURNING id
    `);
    locationId = String(location.rows[0]?.id);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await cleanup();
    await getPool().end();
  });

  it('issues keys to the club’s own management only, and stores only their hash', async () => {
    expect(await issueClubApiKey(db, desk, { name: 'Рецепция', scopes: ['members:read'] })).toEqual(
      { ok: false, error: 'not_allowed' },
    );
    expect(
      await issueClubApiKey(db, ngoAdmin, { name: 'Сдружение', scopes: ['members:read'] }),
    ).toEqual({ ok: false, error: 'not_allowed' });
    const issued = await issueClubApiKey(db, owner, {
      name: 'Сайт',
      scopes: ['members:read', 'members:write'],
    });
    if (!issued.ok) throw new Error('key refused');
    expect(issued.key).toMatch(/^skbk_[A-Za-z0-9_-]{43}$/);
    const stored = await db.execute(sql`
      SELECT key_hash, prefix FROM club_api_keys WHERE id = ${issued.id}::uuid
    `);
    expect(String(stored.rows[0]?.key_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.key.startsWith(String(stored.rows[0]?.prefix))).toBe(true);
    const listed = await listClubApiKeys(owner);
    expect(listed.map((k) => k.id)).toContain(issued.id);
    expect(JSON.stringify(listed)).not.toContain(issued.key);

    const verified = await verifyClubApiKey(issued.key);
    expect(verified?.actor).toEqual({
      userId: owner.userId,
      clubId,
      role: 'owner',
      ngoAdmin: false,
      apiKeyId: issued.id,
    });
    expect(verified?.scopes.sort()).toEqual(['members:read', 'members:write']);
    // A pasted key in the name is refused by the database itself.
    await expect(
      issueClubApiKey(db, owner, { name: `my ${issued.key}`, scopes: ['members:read'] }),
    ).rejects.toThrow();
  });

  it('serves the API by scope, as the key’s creator, and replays an idempotent write', async () => {
    const issued = await issueClubApiKey(db, owner, {
      name: 'Интеграция',
      scopes: ['members:read', 'members:write', 'attendance:read', 'attendance:write'],
    });
    if (!issued.ok) throw new Error('key refused');
    const key = issued.key;

    expect((await clubGet(call('/api/clubs/v1/club'))).status).toBe(401);
    expect(
      (await clubGet(call('/api/clubs/v1/club', { key: `${key.slice(0, -1)}x` }))).status,
    ).toBe(401);
    const me = await clubGet(call('/api/clubs/v1/club', { key }));
    expect(me.status).toBe(200);
    expect(me.headers.get('cache-control')).toBe('no-store');
    expect(me.headers.get('ratelimit-limit')).toBe('120');
    expect(data(await json(me)).slug).toBe(slug);

    // Off: the API does not exist.
    vi.stubEnv('CLUB_API_ENABLED', 'false');
    expect((await clubGet(call('/api/clubs/v1/club', { key }))).status).toBe(404);
    vi.stubEnv('CLUB_API_ENABLED', 'true');

    const body = { display_name: 'Мария API', email: 'maria-api@example.org', tags: ['сутрин'] };
    const first = await membersPost(
      call('/api/clubs/v1/members', { key, body, headers: { 'idempotency-key': 'create-1' } }),
    );
    expect(first.status).toBe(201);
    const created = data(await json(first));
    expect(created.display_name).toBe('Мария API');
    const replay = await membersPost(
      call('/api/clubs/v1/members', { key, body, headers: { 'idempotency-key': 'create-1' } }),
    );
    expect(replay.status).toBe(201);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(data(await json(replay)).id).toBe(created.id);
    const conflict = await membersPost(
      call('/api/clubs/v1/members', {
        key,
        body: { display_name: 'Друг' },
        headers: { 'idempotency-key': 'create-1' },
      }),
    );
    expect(conflict.status).toBe(422);
    const rows = await db.execute(sql`
      SELECT source FROM club_members WHERE club_id = ${clubId}::uuid AND display_name = 'Мария API'
    `);
    expect(rows.rows.map((r) => r.source)).toEqual(['api']);
    const audit = await db.execute(sql`
      SELECT actor_kind, actor_id, detail FROM club_audit
       WHERE club_id = ${clubId}::uuid AND action = 'member_created'
         AND subject_member_id = ${String(created.id)}::uuid
    `);
    expect(audit.rows[0]?.actor_kind).toBe('api');
    expect(audit.rows[0]?.actor_id).toBe(owner.userId);
    expect((audit.rows[0]?.detail as Record<string, unknown>).api_key).toBe(issued.id);

    const invalid = await membersPost(call('/api/clubs/v1/members', { key, body: { email: 5 } }));
    expect(invalid.status).toBe(400);

    const one = await memberGet(call(`/api/clubs/v1/members/${String(created.id)}`, { key }), {
      params: Promise.resolve({ id: String(created.id) }),
    });
    expect(one.status).toBe(200);
    expect(data(await json(one)).memberships).toEqual([]);
    const list = await json(await membersGet(call('/api/clubs/v1/members?q=API', { key })));
    expect((list.data as unknown[]).length).toBeGreaterThan(0);

    // Attendance through the API: recorded, uncovered, once.
    const visit = await checkinsPost(
      call('/api/clubs/v1/checkins', { key, body: { member_id: created.id } }),
    );
    expect(visit.status).toBe(201);
    const visitData = data(await json(visit));
    expect(visitData.method).toBe('api');
    expect(visitData.covered).toBe(false);
    const again = await checkinsPost(
      call('/api/clubs/v1/checkins', { key, body: { member_id: created.id } }),
    );
    expect(again.status).toBe(200);
    expect(data(await json(again)).id).toBe(visitData.id);
    const today = sofiaToday();
    const day = await json(
      await checkinsGet(call(`/api/clubs/v1/checkins?from=${today}&to=${today}`, { key })),
    );
    expect((day.data as Record<string, unknown>[]).map((c) => c.id)).toContain(visitData.id);
    const tooLong = await checkinsGet(
      call(`/api/clubs/v1/checkins?from=${today}&to=${addDaysIso(today, 40)}`, { key }),
    );
    expect(tooLong.status).toBe(400);

    // A scope the key lacks is refused before anything runs.
    const readOnly = await issueClubApiKey(db, owner, {
      name: 'Само четене',
      scopes: ['members:read'],
    });
    if (!readOnly.ok) throw new Error('key refused');
    const refused = await membersPost(
      call('/api/clubs/v1/members', { key: readOnly.key, body: { display_name: 'Не' } }),
    );
    expect(refused.status).toBe(403);
    expect(((await json(refused)).error as Record<string, unknown>).code).toBe(
      'insufficient_scope',
    );

    // Revoked, or the creator gone: refused.
    expect(await revokeClubApiKey(db, owner, readOnly.id)).toBe(true);
    expect(await verifyClubApiKey(readOnly.key)).toBeNull();
    const managerKey = await issueClubApiKey(db, manager, {
      name: 'Мениджър',
      scopes: ['members:read'],
    });
    if (!managerKey.ok) throw new Error('key refused');
    expect(await verifyClubApiKey(managerKey.key)).not.toBeNull();
    await db.execute(sql`
      DELETE FROM club_staff WHERE club_id = ${clubId}::uuid AND user_id = ${manager.userId}
    `);
    expect(await verifyClubApiKey(managerKey.key)).toBeNull();
  });

  it('queues changes for a subscribed endpoint, signs, retries, gives up and holds erasures', async () => {
    expect(
      await addWebhookEndpoint(db, desk, {
        url: 'https://hooks.example.com/pops',
        events: ['member.created'],
        description: null,
      }),
    ).toEqual({ ok: false, error: 'not_allowed' });
    const added = await addWebhookEndpoint(db, owner, {
      url: 'https://hooks.example.com/pops',
      events: ['member.created', 'member.deleted', 'checkin.created'],
      description: 'CRM',
    });
    if (!added.ok) throw new Error('endpoint refused');
    const endpointId = added.id;

    const memberId = await member('Иван Webhook');
    let deliveries = await listWebhookDeliveries(owner, endpointId);
    expect(deliveries.map((d) => [d.event, d.state])).toEqual([['member.created', 'pending']]);

    const sent: { url: string; body: string; headers: Record<string, string> }[] = [];
    const ok: WebhookPoster = (url, body, headers) => {
      sent.push({ url, body, headers: { ...headers } });
      return Promise.resolve({ ok: true, status: 204, error: null });
    };
    const report = await runClubWebhooks(process.env, ok);
    expect(report.sent).toBeGreaterThanOrEqual(1);
    const mine = sent.find(
      (s) => (JSON.parse(s.body) as { data: { member_id: string } }).data.member_id === memberId,
    );
    if (!mine) throw new Error('not posted');
    const posted = JSON.parse(mine.body) as Record<string, unknown>;
    expect(posted.type).toBe('member.created');
    expect(posted.club_id).toBe(clubId);
    expect(typeof posted.seq).toBe('number');
    expect(mine.headers['pops-event']).toBe('member.created');
    expect(
      verifyWebhookSignature(
        added.secret,
        mine.headers['pops-signature'] ?? '',
        mine.body,
        Math.floor(Date.now() / 1000),
        300,
      ),
    ).toBe(true);
    deliveries = await listWebhookDeliveries(owner, endpointId);
    expect(deliveries[0]?.state).toBe('delivered');

    // A failure is retried later; the eighth gives up.
    await member('Петър Неуспешен');
    const failing: WebhookPoster = () =>
      Promise.resolve({ ok: false, status: 500, error: 'http_status' });
    await runClubWebhooks(process.env, failing);
    const retried = await db.execute(sql`
      SELECT attempts, state, next_attempt_at > now() AS later, last_error
        FROM club_webhook_deliveries
       WHERE endpoint_id = ${endpointId}::uuid AND state <> 'delivered'
    `);
    expect(retried.rows).toEqual([
      { attempts: 1, state: 'pending', later: true, last_error: 'http_status' },
    ]);
    await db.execute(sql`
      UPDATE club_webhook_deliveries
         SET attempts = 7, next_attempt_at = now() - interval '1 second'
       WHERE endpoint_id = ${endpointId}::uuid AND state = 'pending'
    `);
    expect((await runClubWebhooks(process.env, failing)).gaveUp).toBe(1);
    const failed = await db.execute(sql`
      SELECT count(*)::int AS n FROM club_webhook_deliveries
       WHERE endpoint_id = ${endpointId}::uuid AND state = 'failed'
    `);
    expect(failed.rows[0]?.n).toBe(1);

    // Disabled: only member.deleted is held, and sent once enabled again.
    expect(await disableWebhookEndpoint(db, owner, endpointId)).toBe(true);
    await member('Нов, докато е спрян');
    expect(await eraseMember(db, owner, memberId)).toBe('ok');
    const held = await db.execute(sql`
      SELECT event FROM club_webhook_deliveries
       WHERE endpoint_id = ${endpointId}::uuid AND state = 'pending'
    `);
    expect(held.rows.map((r) => r.event)).toEqual(['member.deleted']);
    sent.length = 0;
    await runClubWebhooks(process.env, ok);
    expect(sent).toEqual([]);
    expect(await enableWebhookEndpoint(db, owner, endpointId)).toBe(true);
    await runClubWebhooks(process.env, ok);
    expect(sent.map((s) => (JSON.parse(s.body) as { type: string }).type)).toEqual([
      'member.deleted',
    ]);

    // A rotation: both secrets sign for a day.
    const rotated = await rotateWebhookSecret(db, owner, endpointId);
    if (!rotated) throw new Error('rotation refused');
    expect(rotated).not.toBe(added.secret);
    await member('След ротацията');
    sent.length = 0;
    await runClubWebhooks(process.env, ok);
    const signed = sent[0];
    if (!signed) throw new Error('not posted');
    const now = Math.floor(Date.now() / 1000);
    const header = signed.headers['pops-signature'] ?? '';
    expect(header.split(',').filter((part) => part.startsWith('v1='))).toHaveLength(2);
    expect(verifyWebhookSignature(rotated, header, signed.body, now, 300)).toBe(true);
    expect(verifyWebhookSignature(added.secret, header, signed.body, now, 300)).toBe(true);

    // Off without the master secret: nothing is claimed.
    vi.stubEnv('CLUB_WEBHOOK_SECRET', '');
    await member('Без тайна');
    expect((await runClubWebhooks(process.env, ok)).configured).toBe(false);
    vi.stubEnv('CLUB_WEBHOOK_SECRET', WEBHOOK_SECRET);

    expect(await removeWebhookEndpoint(db, owner, endpointId)).toBe(true);
    const gone = await db.execute(sql`
      SELECT count(*)::int AS n FROM club_webhook_deliveries
       WHERE endpoint_id = ${endpointId}::uuid
    `);
    expect(gone.rows[0]?.n).toBe(0);
  });

  it('opens a door by the club’s rule and records the visit; a refused door records nothing', async () => {
    expect(
      await createDoorDevice(db, desk, { locationId, name: 'Вход', rule: 'covered' }),
    ).toBeNull();
    const strict = await createDoorDevice(db, owner, { locationId, name: 'Вход', rule: 'covered' });
    const open = await createDoorDevice(db, owner, { locationId, name: 'Зала', rule: 'member' });
    if (!strict || !open) throw new Error('door refused');
    expect(strict.token).toMatch(/^skbd_[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/);

    // A door's secret is never a kiosk's.
    const secret = strict.token.split('.')[1] ?? '';
    expect(await kioskFromCookie(slug, `${strict.deviceId}~${secret}`)).toBeNull();

    const memberId = await member('Гергана Врата');
    const card = await issueMemberCard(db, owner, memberId);
    if (!card) throw new Error('card refused');
    const scan = (token: string, credential: string) =>
      accessCheck(
        call('/api/clubs/v1/access/check', {
          headers: { authorization: `Bearer ${token}` },
          body: { credential },
        }),
      );
    const visits = async () =>
      Number(
        (
          await db.execute(sql`
            SELECT count(*)::int AS n FROM club_checkins
             WHERE member_id = ${memberId}::uuid AND method = 'door'
          `)
        ).rows[0]?.n,
      );

    expect(await json(await scan(strict.token, card))).toMatchObject({
      allow: false,
      reason: 'not_covered',
    });
    expect(await visits()).toBe(0);

    expect(await json(await scan(open.token, card))).toMatchObject({
      allow: true,
      checkin: 'recorded',
      covered: false,
    });
    expect(await visits()).toBe(1);
    expect((await json(await scan(open.token, card))).checkin).toBe('already');

    // The member's own QR, fresh and stale.
    const qr = issueClubToken({ kind: 'mem', id: memberId, secret: CHECKIN_SECRET });
    const link = `https://pops.bg/klub/${slug}/skan/${encodeURIComponent(qr)}`;
    expect((await json(await scan(open.token, link))).allow).toBe(true);
    const stale = issueClubToken({
      kind: 'mem',
      id: memberId,
      secret: CHECKIN_SECRET,
      at: new Date(Date.now() - 60 * 60 * 1000),
    });
    expect((await json(await scan(open.token, stale))).reason).toBe('expired_credential');
    expect((await json(await scan(open.token, `skbc_${'u'.repeat(24)}`))).reason).toBe(
      'unknown_credential',
    );

    await db.execute(sql`UPDATE club_members SET archived_at = now() WHERE id = ${memberId}::uuid`);
    expect((await json(await scan(open.token, card))).reason).toBe('archived');

    expect(await revokeDoorDevice(db, owner, open.deviceId)).toBe(true);
    expect((await scan(open.token, card)).status).toBe(401);
  });

  it('lists only the tools a key’s scopes allow, over MCP', async () => {
    const issued = await issueClubApiKey(db, owner, { name: 'Асистент', scopes: ['members:read'] });
    if (!issued.ok) throw new Error('key refused');
    const rpc = (message: unknown, headers: Record<string, string> = {}) =>
      mcpPost(call('/api/clubs/mcp', { key: issued.key, body: message, headers }));

    const init = await json(
      await rpc({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      }),
    );
    expect((init.result as Record<string, unknown>).protocolVersion).toBe('2025-06-18');
    expect((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);

    const tools = await json(await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    const names = ((tools.result as Record<string, unknown>).tools as { name: string }[]).map(
      (tool) => tool.name,
    );
    expect(names.sort()).toEqual(['club_info', 'get_member', 'search_members']);

    const found = await json(
      await rpc({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'search_members', arguments: { query: 'API' } },
      }),
    );
    const result = found.result as { structuredContent: { data: unknown[] }; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.data.length).toBeGreaterThan(0);

    const write = await json(
      await rpc({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'create_member', arguments: { display_name: 'Не' } },
      }),
    );
    expect((write.error as Record<string, unknown>).code).toBe(-32602);

    const foreign = await rpc(
      { jsonrpc: '2.0', id: 5, method: 'ping' },
      {
        origin: 'https://evil.example',
      },
    );
    expect(foreign.status).toBe(403);
  });

  it('keeps every key and door to its own club, and to its creator as they are now', async () => {
    // Club B, with its own owner and an all-scopes key.
    const otherSlug = `e2e-jh-${Math.random().toString(36).slice(2, 8)}`;
    const other = await db.execute(sql`
      INSERT INTO clubs (slug, name_bg, tier, status, approved_at, paid_until, visible)
      VALUES (${otherSlug}, 'Друг клуб', 'pro', 'active', now(),
              (now() + interval '1 year')::date, true)
      RETURNING id
    `);
    const otherId = String(other.rows[0]?.id);
    const otherOwner = await account('owner_b');
    await db.execute(sql`
      INSERT INTO club_staff (club_id, user_id, role) VALUES (${otherId}::uuid, ${otherOwner}, 'owner')
    `);
    const otherActor: ClubActor = {
      userId: otherOwner,
      clubId: otherId,
      role: 'owner',
      ngoAdmin: false,
    };
    const otherMember = await db.execute(sql`
      INSERT INTO club_members (club_id, display_name) VALUES (${otherId}::uuid, 'Член Б') RETURNING id
    `);
    const otherMemberId = String(otherMember.rows[0]?.id);
    const keyB = await issueClubApiKey(db, otherActor, {
      name: 'Б',
      scopes: [
        'members:read',
        'members:write',
        'attendance:read',
        'attendance:write',
        'bookings:write',
        'payments:read',
      ],
    });
    if (!keyB.ok) throw new Error('key refused');

    // Club A's records, through B's key: not found, never another club's.
    const memberA = await member('Член А');
    const visitA = await db.execute(sql`
      INSERT INTO club_checkins (club_id, member_id, location_id, method, recorded_by, covered, sofia_day)
      VALUES (${clubId}::uuid, ${memberA}::uuid, ${locationId}::uuid, 'desk', ${owner.userId}, false,
              (now() AT TIME ZONE 'Europe/Sofia')::date)
      RETURNING id
    `);
    const visitAId = String(visitA.rows[0]?.id);
    const klass = await db.execute(sql`
      INSERT INTO club_classes (club_id, location_id, title, sport, starts_at_local, duration_minutes,
                                capacity, public, trial_allowed, booking_opens_hours)
      VALUES (${clubId}::uuid, ${locationId}::uuid, 'Клас А', 'fitness',
              (date_trunc('hour', now()) + interval '2 days') AT TIME ZONE 'Europe/Sofia',
              60, 20, true, false, 720)
      RETURNING id
    `);
    const occurrence = await db.execute(sql`
      INSERT INTO club_class_occurrences (club_id, class_id, starts_at, ends_at, starts_at_local)
      SELECT c.club_id, c.id, c.starts_at_local AT TIME ZONE 'Europe/Sofia',
             (c.starts_at_local AT TIME ZONE 'Europe/Sofia') + interval '60 minutes', c.starts_at_local
        FROM club_classes c WHERE c.id = ${String(klass.rows[0]?.id)}::uuid
      RETURNING id
    `);
    const occurrenceA = String(occurrence.rows[0]?.id);

    const byId = await memberGet(call(`/api/clubs/v1/members/${memberA}`, { key: keyB.key }), {
      params: Promise.resolve({ id: memberA }),
    });
    expect(byId.status).toBe(404);
    const theirs = await json(
      await membersGet(call('/api/clubs/v1/members?q=Член', { key: keyB.key })),
    );
    expect((theirs.data as { id: string }[]).map((m) => m.id)).toEqual([otherMemberId]);
    const visitById = await checkinGet(
      call(`/api/clubs/v1/checkins/${visitAId}`, { key: keyB.key }),
      { params: Promise.resolve({ id: visitAId }) },
    );
    expect(visitById.status).toBe(404);
    const recordA = await checkinsPost(
      call('/api/clubs/v1/checkins', { key: keyB.key, body: { member_id: memberA } }),
    );
    expect(recordA.status).toBe(404);
    const foreignLocation = await checkinsPost(
      call('/api/clubs/v1/checkins', {
        key: keyB.key,
        body: { member_id: otherMemberId, location_id: locationId },
      }),
    );
    expect(foreignLocation.status).toBe(404);
    const bookA = await bookingsPost(
      call('/api/clubs/v1/bookings', {
        key: keyB.key,
        body: { member_id: otherMemberId, class_occurrence_id: occurrenceA },
      }),
    );
    expect(bookA.status).toBe(403);

    // Club A's door does not know club B's card.
    const door = await createDoorDevice(db, owner, {
      locationId,
      name: 'Странична',
      rule: 'member',
    });
    if (!door) throw new Error('door refused');
    const cardB = await issueMemberCard(db, otherActor, otherMemberId);
    if (!cardB) throw new Error('card refused');
    const scanned = await accessCheck(
      call('/api/clubs/v1/access/check', {
        headers: { authorization: `Bearer ${door.token}` },
        body: { credential: cardB },
      }),
    );
    expect(await json(scanned)).toEqual({ allow: false, reason: 'unknown_credential' });

    // A 'covered' door lets a client already in back through, even uncovered.
    const strict = await createDoorDevice(db, owner, {
      locationId,
      name: 'Строга',
      rule: 'covered',
    });
    if (!strict) throw new Error('door refused');
    const cardA = await issueMemberCard(db, owner, memberA);
    if (!cardA) throw new Error('card refused');
    const back = await accessCheck(
      call('/api/clubs/v1/access/check', {
        headers: { authorization: `Bearer ${strict.token}` },
        body: { credential: cardA },
      }),
    );
    expect(await json(back)).toMatchObject({ allow: true, checkin: 'already' });

    // A write-only key learns the id of what it made, never the record.
    const writeOnly = await issueClubApiKey(db, owner, {
      name: 'Форма',
      scopes: ['members:write'],
    });
    if (!writeOnly.ok) throw new Error('key refused');
    const lead = { display_name: 'Запитване', email: 'lead@example.org' };
    const made = await membersPost(
      call('/api/clubs/v1/members', {
        key: writeOnly.key,
        body: lead,
        headers: { 'idempotency-key': 'lead-1' },
      }),
    );
    expect(made.status).toBe(201);
    expect(Object.keys(data(await json(made)))).toEqual(['id']);
    const replayed = await membersPost(
      call('/api/clubs/v1/members', {
        key: writeOnly.key,
        body: lead,
        headers: { 'idempotency-key': 'lead-1' },
      }),
    );
    expect(Object.keys(data(await json(replayed)))).toEqual(['id']);

    // The creator's role as it is NOW: a manager's key, then a trainer's.
    const manager2 = await staff('manager');
    const managerKey = await issueClubApiKey(db, manager2, { name: 'М', scopes: ['members:read'] });
    if (!managerKey.ok) throw new Error('key refused');
    await db.execute(sql`
      UPDATE club_staff SET role = 'trainer'
       WHERE club_id = ${clubId}::uuid AND user_id = ${manager2.userId}
    `);
    const asTrainer = await json(
      await membersGet(call('/api/clubs/v1/members', { key: managerKey.key })),
    );
    expect(asTrainer.total).toBe(0);
    // Suspended: refused.
    await db.execute(sql`
      UPDATE users SET suspended_at = now(), suspended_reason = 'Тест'
       WHERE id = ${manager2.userId}
    `);
    expect(await verifyClubApiKey(managerKey.key)).toBeNull();
    await db.execute(sql`
      UPDATE users SET suspended_at = NULL, suspended_reason = NULL WHERE id = ${manager2.userId}
    `);
    expect(await verifyClubApiKey(managerKey.key)).not.toBeNull();
    // Removed and added back: the old key stays dead.
    await db.execute(sql`
      DELETE FROM club_staff WHERE club_id = ${clubId}::uuid AND user_id = ${manager2.userId}
    `);
    await db.execute(sql`
      INSERT INTO club_staff (club_id, user_id, role)
      VALUES (${clubId}::uuid, ${manager2.userId}, 'manager')
    `);
    expect(await verifyClubApiKey(managerKey.key)).toBeNull();

    // The NGO admin never points a club's events at a URL, nor sees a secret.
    expect(
      await addWebhookEndpoint(db, ngoAdmin, {
        url: 'https://hooks.example.com/ngo',
        events: ['member.created'],
        description: null,
      }),
    ).toEqual({ ok: false, error: 'not_allowed' });
    const added = await addWebhookEndpoint(db, owner, {
      url: 'https://hooks.example.com/rot',
      events: ['member.created'],
      description: null,
    });
    if (!added.ok) throw new Error('endpoint refused');
    expect(await rotateWebhookSecret(db, ngoAdmin, added.id)).toBeNull();
    // A leaked secret can be stopped at once.
    expect(await rotateWebhookSecret(db, owner, added.id, { expireNow: true })).not.toBeNull();
    const overlap = await db.execute(sql`
      SELECT secret_rotated_at > now() - interval '1 day' AS overlapping
        FROM club_webhook_endpoints WHERE id = ${added.id}::uuid
    `);
    expect(overlap.rows[0]?.overlapping).toBe(false);
  });
});
