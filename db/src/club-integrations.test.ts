import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getDb } from './client.js';
import {
  claimWebhookDeliveries,
  disableFailingEndpoints,
  pruneClubIntegrations,
  settleWebhookDelivery,
} from './clubs/webhooks.js';
import {
  cleanupClubFixtures,
  failure,
  makeClub,
  makeMember,
  purgeClub,
  type ClubFixture,
} from './clubs/test-fixtures.js';

/**
 * The club API, webhooks and doors (0057) — what the database guarantees:
 *
 *   * a change is queued for every LIVE endpoint subscribed to it, in the
 *     same transaction (member.deleted for a disabled one too); a staff note
 *     or a lead field is not an event; nothing is queued while the club is
 *     being purged, and the purge goes through;
 *   * a door has a rule, never a pairing code, and never becomes a tablet;
 *     a door's check-in names no person, and neither does its audit row;
 *   * an idempotency row holds no outcome until it is done;
 *   * and the worker's side: claims by lease in the order the changes were
 *     made, only for tiers it serves; settles, gives up, disables an endpoint
 *     that failed for days (holding member.deleted), and prunes.
 *
 * Integration test against the dev/CI database; skips without DATABASE_URL.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('club integrations (requires running database)', () => {
  let client: pg.Client;
  let pro: ClubFixture;

  async function endpoint(
    clubId: string,
    events: string[],
    options: { disabled?: boolean } = {},
  ): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO club_webhook_endpoints (club_id, url, events, created_by, disabled_at, disabled_reason)
       VALUES ($1, 'https://hooks.example.com/x', $2, 'e2e_club_test',
               CASE WHEN $3 THEN now() END, CASE WHEN $3 THEN 'manual' END)
       RETURNING id`,
      [clubId, events, options.disabled ?? false],
    );
    return result.rows[0]?.id ?? '';
  }

  async function deliveries(endpointId: string): Promise<{ event: string; state: string }[]> {
    const result = await client.query<{ event: string; state: string }>(
      `SELECT event, state FROM club_webhook_deliveries WHERE endpoint_id = $1 ORDER BY seq`,
      [endpointId],
    );
    return result.rows;
  }

  async function refused(text: string, values: unknown[]) {
    return failure(client.query(text, values));
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await cleanupClubFixtures(client);
    pro = await makeClub(client, `int-${Math.random().toString(36).slice(2, 7)}`, { tier: 'pro' });
    await client.query(
      `UPDATE clubs SET paid_until = (now() + interval '1 year')::date WHERE id = $1`,
      [pro.clubId],
    );
  });

  afterAll(async () => {
    await cleanupClubFixtures(client);
    await client.end();
  });

  it('queues what an endpoint subscribed to, and only that', async () => {
    const live = await endpoint(pro.clubId, ['member.created', 'member.updated', 'member.deleted']);
    const stopped = await endpoint(pro.clubId, ['member.created', 'member.deleted'], {
      disabled: true,
    });
    const memberId = await makeMember(client, pro.clubId, 'Събитие');
    await client.query(`UPDATE club_members SET staff_note = 'бележка' WHERE id = $1`, [memberId]);
    await client.query(`UPDATE club_members SET lead_opened_at = now() WHERE id = $1`, [memberId]);
    expect(await deliveries(live)).toEqual([{ event: 'member.created', state: 'pending' }]);
    await client.query(`UPDATE club_members SET email = 'nov@example.org' WHERE id = $1`, [
      memberId,
    ]);
    await client.query(`UPDATE club_members SET tags = '{нов}' WHERE id = $1`, [memberId]);
    expect((await deliveries(live)).map((d) => d.event)).toEqual([
      'member.created',
      'member.updated',
      'member.updated',
    ]);
    // A disabled endpoint hears of nothing — but an erasure.
    expect(await deliveries(stopped)).toEqual([]);
    await client.query(`DELETE FROM club_members WHERE id = $1`, [memberId]);
    expect(await deliveries(stopped)).toEqual([{ event: 'member.deleted', state: 'pending' }]);
    const deleted = await client.query<{ subject_id: string; member_id: string }>(
      `SELECT subject_id, member_id FROM club_webhook_deliveries
        WHERE endpoint_id = $1 AND event = 'member.deleted'`,
      [live],
    );
    expect(deleted.rows).toEqual([{ subject_id: memberId, member_id: memberId }]);
  });

  it('lets a purge through, telling nobody', async () => {
    const doomed = await makeClub(client, `int-p-${Math.random().toString(36).slice(2, 7)}`, {
      tier: 'pro',
    });
    await endpoint(doomed.clubId, ['member.deleted', 'member.created']);
    await makeMember(client, doomed.clubId, 'Последен');
    await purgeClub(client, doomed.clubId);
    const left = await client.query(`SELECT 1 FROM clubs WHERE id = $1`, [doomed.clubId]);
    expect(left.rows).toEqual([]);
  });

  it('keeps a door a door, with a rule, and no person behind its visits', async () => {
    const door = await client.query<{ id: string }>(
      `INSERT INTO club_kiosk_devices (club_id, location_id, name, kind, access_rule, secret_hash, paired_at)
       VALUES ($1, $2, 'Врата', 'door', 'covered', repeat('a', 64), now()) RETURNING id`,
      [pro.clubId, pro.locationId],
    );
    const doorId = door.rows[0]?.id ?? '';
    const kindChange = await refused(
      `UPDATE club_kiosk_devices SET kind = 'kiosk', access_rule = NULL WHERE id = $1`,
      [doorId],
    );
    expect(kindChange.message).toContain('club_kiosk_devices_keep_kind');
    const noRule = await refused(
      `INSERT INTO club_kiosk_devices (club_id, location_id, name, kind)
       VALUES ($1, $2, 'Без правило', 'door')`,
      [pro.clubId, pro.locationId],
    );
    expect(noRule.constraint).toBe('club_kiosk_devices_rule_for_doors');
    const withCode = await refused(
      `INSERT INTO club_kiosk_devices (club_id, location_id, name, kind, access_rule,
                                       pairing_code_hash, pairing_expires_at)
       VALUES ($1, $2, 'С код', 'door', 'member', repeat('b', 64), now() + interval '5 minutes')`,
      [pro.clubId, pro.locationId],
    );
    expect(withCode.constraint).toBe('club_kiosk_devices_door_never_paired_by_code');

    const memberId = await makeMember(client, pro.clubId, 'Влизащ');
    const vouched = await refused(
      `INSERT INTO club_checkins (club_id, member_id, location_id, method, recorded_by, covered, sofia_day)
       VALUES ($1, $2, $3, 'door', $4, false, (now() AT TIME ZONE 'Europe/Sofia')::date)`,
      [pro.clubId, memberId, pro.locationId, pro.ownerId],
    );
    expect(vouched.constraint).toBe('club_checkins_recorder_matches_method');
    await client.query(
      `INSERT INTO club_checkins (club_id, member_id, location_id, method, covered, sofia_day)
       VALUES ($1, $2, $3, 'door', false, (now() AT TIME ZONE 'Europe/Sofia')::date)`,
      [pro.clubId, memberId, pro.locationId],
    );
    await client.query(
      `INSERT INTO club_audit (club_id, actor_id, actor_kind, action, detail)
       VALUES ($1, NULL, 'door', 'checkin_recorded', '{}')`,
      [pro.clubId],
    );
    const nobody = await refused(
      `INSERT INTO club_audit (club_id, actor_id, actor_kind, action, detail)
       VALUES ($1, NULL, 'api', 'member_created', '{}')`,
      [pro.clubId],
    );
    expect(nobody.constraint).toBe('club_audit_actor_matches_kind');
  });

  it('holds no outcome on a request still running, and no key in a name', async () => {
    const key = await client.query<{ id: string }>(
      `INSERT INTO club_api_keys (club_id, name, key_hash, prefix, scopes, created_by)
       VALUES ($1, 'Ключ', repeat('c', 64), 'skbk_abcdef', '{members:read}', $2) RETURNING id`,
      [pro.clubId, pro.ownerId],
    );
    const keyId = key.rows[0]?.id ?? '';
    const early = await refused(
      `INSERT INTO club_api_idempotency (club_id, key_id, idempotency_key, request_hash, error_code)
       VALUES ($1, $2, 'k', repeat('d', 64), 'invalid')`,
      [pro.clubId, keyId],
    );
    expect(early.constraint).toBe('club_api_idempotency_pending_has_no_outcome');
    const pasted = await refused(
      `INSERT INTO club_api_keys (club_id, name, key_hash, prefix, scopes, created_by)
       VALUES ($1, 'skbk_paste', repeat('e', 64), 'skbk_abcdeg', '{members:read}', $2)`,
      [pro.clubId, pro.ownerId],
    );
    expect(pasted.constraint).toBe('club_api_keys_name_no_key');
    const unknownScope = await refused(
      `INSERT INTO club_api_keys (club_id, name, key_hash, prefix, scopes, created_by)
       VALUES ($1, 'Широк', repeat('f', 64), 'skbk_abcdeh', '{members:delete}', $2)`,
      [pro.clubId, pro.ownerId],
    );
    expect(unknownScope.constraint).toBe('club_api_keys_scopes_known');
  });

  it('claims by lease in order, settles, gives up, disables a failing endpoint and prunes', async () => {
    const db = getDb();
    const hook = await endpoint(pro.clubId, ['member.created', 'member.deleted']);
    const first = await makeMember(client, pro.clubId, 'Първи');
    const second = await makeMember(client, pro.clubId, 'Втори');
    const options = {
      tiers: ['pro'],
      limit: 50,
      perEndpoint: 10,
      leaseSeconds: 120,
      overlapHours: 24,
    };

    // Not a tier the worker serves: nothing.
    expect(await claimWebhookDeliveries(db, { ...options, tiers: ['standard'] })).toEqual([]);
    const claimed = (await claimWebhookDeliveries(db, options)).filter(
      (d) => d.endpointId === hook,
    );
    expect(claimed.map((d) => d.memberId)).toEqual([first, second]);
    expect(claimed[0]?.previousSecretVersion).toBeNull();
    // Leased: a second claim does not take them again.
    expect(
      (await claimWebhookDeliveries(db, options)).filter((d) => d.endpointId === hook),
    ).toEqual([]);

    const [a, b] = claimed;
    if (!a || !b) throw new Error('nothing claimed');
    await settleWebhookDelivery(db, a, { ok: true, status: 200, error: null }, null);
    await settleWebhookDelivery(db, b, { ok: false, status: null, error: 'timeout' }, 60);
    const health = await client.query<{ failing: boolean; success: boolean }>(
      `SELECT failing_since IS NOT NULL AS failing, last_success_at IS NOT NULL AS success
         FROM club_webhook_endpoints WHERE id = $1`,
      [hook],
    );
    expect(health.rows[0]).toEqual({ failing: true, success: true });
    expect(await deliveries(hook)).toEqual([
      { event: 'member.created', state: 'delivered' },
      { event: 'member.created', state: 'pending' },
    ]);
    await settleWebhookDelivery(db, b, { ok: false, status: 503, error: 'http_status' }, null);
    expect((await deliveries(hook))[1]?.state).toBe('failed');

    // Failing for three days without a success: disabled, member.deleted held.
    await client.query(`DELETE FROM club_members WHERE id = $1`, [first]);
    await makeMember(client, pro.clubId, 'Трети');
    await client.query(
      `UPDATE club_webhook_endpoints SET failing_since = now() - interval '4 days' WHERE id = $1`,
      [hook],
    );
    expect(await disableFailingEndpoints(db, 3)).toBeGreaterThanOrEqual(1);
    const after = await client.query<{ disabled_reason: string }>(
      `SELECT disabled_reason FROM club_webhook_endpoints WHERE id = $1`,
      [hook],
    );
    expect(after.rows[0]?.disabled_reason).toBe('failing');
    const pending = await client.query<{ event: string }>(
      `SELECT event FROM club_webhook_deliveries WHERE endpoint_id = $1 AND state = 'pending'`,
      [hook],
    );
    expect(pending.rows.map((r) => r.event)).toEqual(['member.deleted']);
    const logged = await client.query(
      `SELECT 1 FROM club_audit WHERE club_id = $1 AND action = 'webhook_disabled'
          AND actor_kind = 'system' AND detail->>'reason' = 'failing'`,
      [pro.clubId],
    );
    expect(logged.rows).toHaveLength(1);

    // The log keeps 30 days.
    await client.query(
      `UPDATE club_webhook_deliveries SET occurred_at = now() - interval '31 days'
        WHERE endpoint_id = $1 AND state = 'delivered'`,
      [hook],
    );
    const pruned = await pruneClubIntegrations(db);
    expect(pruned.deliveries).toBeGreaterThanOrEqual(1);
    expect((await deliveries(hook)).map((d) => d.state)).not.toContain('delivered');
  });
});
