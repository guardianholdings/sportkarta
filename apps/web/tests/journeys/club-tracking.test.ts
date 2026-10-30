import { getDb, getPool, sql } from '@sportkarta/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ClubActor } from '@/lib/clubs/scope';
import { clubTrackingSettings, publicClubTracking, saveClubTracking } from '@/lib/clubs/tracking';

import { hasDb } from './db';

vi.mock('server-only', () => ({}));

/**
 * A paid club's own GA4 / Meta Pixel (0058), end to end against real
 * Postgres. What must hold:
 *
 *   * only the club's own management sets the ids — never the desk, never
 *     the NGO admin, never another club's owner, never a lapsed club — and
 *     only on a tier with pixels, and only with the club's privacy notice;
 *   * a public page sees them only while the operator's switch is on, the
 *     tier has pixels and the club is renderable; switched off, nothing;
 *   * the database refuses anything that is not an id, and an id without a
 *     privacy notice.
 *
 * COMMITS under its own `e2e-jp-*` clubs and `e2e_club_jp_*` accounts,
 * removed through the real purge path.
 */

const PREFIX = 'e2e_club_jp_';

async function cleanup(): Promise<void> {
  const db = getDb();
  const clubs = await db.execute(sql`SELECT id FROM clubs WHERE slug LIKE 'e2e-jp-%'`);
  for (const row of clubs.rows) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('pops.purging_club', ${String(row.id)}, true)`);
      await tx.execute(sql`DELETE FROM clubs WHERE id = ${String(row.id)}::uuid`);
    });
  }
  await db.execute(sql`DELETE FROM users WHERE id LIKE ${`${PREFIX}%`}`);
}

describe.skipIf(!hasDb)('club tracking journey (requires running database)', () => {
  let db: ReturnType<typeof getDb>;

  async function account(label: string, role = 'user'): Promise<string> {
    const id = `${PREFIX}${label}_${Math.random().toString(36).slice(2, 8)}`;
    await db.execute(sql`
      INSERT INTO users (id, display_name, email, email_verified, role)
      VALUES (${id}, ${`Служител ${label}`}, ${`${id}@example.org`}, true, ${role})
    `);
    return id;
  }

  async function club(tier: 'community' | 'standard' | 'pro'): Promise<{
    clubId: string;
    owner: ClubActor;
    manager: ClubActor;
    desk: ClubActor;
  }> {
    const created = await db.execute(sql`
      INSERT INTO clubs (slug, name_bg, tier, status, approved_at, paid_until, visible)
      VALUES (${`e2e-jp-${Math.random().toString(36).slice(2, 8)}`}, 'Клуб Пиксели', ${tier},
              'active', now(), (now() + interval '1 year')::date, true)
      RETURNING id
    `);
    const clubId = String(created.rows[0]?.id);
    const ownerId = await account('owner');
    const managerId = await account('manager');
    const deskId = await account('desk');
    await db.execute(sql`
      INSERT INTO club_staff (club_id, user_id, role)
      VALUES (${clubId}::uuid, ${ownerId}, 'owner'), (${clubId}::uuid, ${managerId}, 'manager'),
             (${clubId}::uuid, ${deskId}, 'desk')
    `);
    return {
      clubId,
      owner: { userId: ownerId, clubId, role: 'owner', ngoAdmin: false },
      manager: { userId: managerId, clubId, role: 'manager', ngoAdmin: false },
      desk: { userId: deskId, clubId, role: 'desk', ngoAdmin: false },
    };
  }

  beforeAll(async () => {
    vi.stubEnv('CLUBS_ENABLED', 'true');
    vi.stubEnv('CLUB_PIXELS_ENABLED', 'true');
    db = getDb();
    await cleanup();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await cleanup();
    await getPool().end();
  });

  it('lets only the club’s own management set the ids, on a tier with pixels', async () => {
    const paid = await club('standard');
    const ids = {
      gaId: 'G-AB12CD34EF',
      metaId: '123456789012345',
      privacyUrl: 'https://club.example/privacy',
    };
    expect(await saveClubTracking(db, paid.desk, ids)).toBe(false);
    const ngoAdmin: ClubActor = {
      userId: await account('admin', 'admin'),
      clubId: paid.clubId,
      role: null,
      ngoAdmin: true,
    };
    expect(await saveClubTracking(db, ngoAdmin, ids)).toBe(false);
    expect(await saveClubTracking(db, paid.owner, ids)).toBe(true);
    expect(await clubTrackingSettings(paid.owner)).toEqual(ids);
    const audit = await db.execute(sql`
      SELECT detail FROM club_audit WHERE club_id = ${paid.clubId}::uuid AND action = 'settings_changed'
    `);
    expect(audit.rows.map((r) => r.detail)).toEqual([
      { tracking: true, ga: true, meta: true, privacy: true },
    ]);
    expect(await saveClubTracking(db, paid.manager, { ...ids, metaId: null })).toBe(true);

    // Another club's owner, pointed at this club: nothing.
    const other = await club('pro');
    expect(await saveClubTracking(db, { ...other.owner, clubId: paid.clubId }, ids)).toBe(false);

    const free = await club('community');
    expect(await saveClubTracking(db, free.owner, ids)).toBe(false);

    // A lapsed club (paid_until long past) writes nothing.
    await db.execute(sql`
      UPDATE clubs SET paid_until = (now() - interval '1 year')::date, trial_ends_on = NULL
       WHERE id = ${other.clubId}::uuid
    `);
    expect(await saveClubTracking(db, other.owner, ids)).toBe(false);
  });

  it('needs the club’s privacy notice with an id, and clears everything together', async () => {
    const paid = await club('pro');
    const noNotice = { gaId: 'G-NOTICE01', metaId: null, privacyUrl: null };
    expect(await saveClubTracking(db, paid.owner, noNotice)).toBe(false);
    const withNotice = { ...noNotice, privacyUrl: 'https://club.example/privacy' };
    expect(await saveClubTracking(db, paid.owner, withNotice)).toBe(true);
    // One statement clears ids and notice: the CHECK sees the final row.
    const cleared = { gaId: null, metaId: null, privacyUrl: null };
    expect(await saveClubTracking(db, paid.owner, cleared)).toBe(true);
    expect(await clubTrackingSettings(paid.owner)).toEqual(cleared);
    expect(await publicClubTracking(paid.clubId)).toBeNull();
  });

  it('shows the ids to a public page only while the switch, the tier and the club allow', async () => {
    const paid = await club('pro');
    expect(await publicClubTracking(paid.clubId)).toBeNull();
    const ids = { gaId: 'G-ZZ99YY88', metaId: null, privacyUrl: 'https://club.example/privacy' };
    expect(await saveClubTracking(db, paid.owner, ids)).toBe(true);
    expect(await publicClubTracking(paid.clubId)).toEqual({
      clubId: paid.clubId,
      gaId: 'G-ZZ99YY88',
      metaId: null,
      policyUrl: 'https://club.example/privacy',
    });

    vi.stubEnv('CLUB_PIXELS_ENABLED', 'false');
    expect(await publicClubTracking(paid.clubId)).toBeNull();
    vi.stubEnv('CLUB_PIXELS_ENABLED', 'true');

    // A downgrade, or a hidden page, stops them without touching the ids.
    await db.execute(sql`UPDATE clubs SET tier = 'community' WHERE id = ${paid.clubId}::uuid`);
    expect(await publicClubTracking(paid.clubId)).toBeNull();
    await db.execute(sql`
      UPDATE clubs SET tier = 'pro', visible = false WHERE id = ${paid.clubId}::uuid
    `);
    expect(await publicClubTracking(paid.clubId)).toBeNull();
  });

  it('stores ids and nothing else', async () => {
    const paid = await club('pro');
    for (const bad of ['GTM-ABC123', 'G-abc123', '<script>', 'https://evil.example/x.js']) {
      await expect(
        db.execute(sql`
          UPDATE clubs SET ga_measurement_id = ${bad} WHERE id = ${paid.clubId}::uuid
        `),
      ).rejects.toThrow();
    }
    await expect(
      db.execute(sql`UPDATE clubs SET meta_pixel_id = '12ab34' WHERE id = ${paid.clubId}::uuid`),
    ).rejects.toThrow();
    // An id needs the notice; the notice must be an https page.
    await expect(
      db.execute(sql`UPDATE clubs SET meta_pixel_id = '123456' WHERE id = ${paid.clubId}::uuid`),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`
        UPDATE clubs SET privacy_url = 'http://club.example/privacy' WHERE id = ${paid.clubId}::uuid
      `),
    ).rejects.toThrow();
  });
});
