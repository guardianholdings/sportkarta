import { getDb, sql, type SQL } from '@sportkarta/db';
import {
  digestsEqual,
  generateKioskSecret,
  generatePairingCode,
  pairingCodeHash,
  sha256Hex,
} from '@sportkarta/lib/clubs/secrets';

import { recordClubAudit } from './audit';
import { violatedConstraint } from './errors';
import { clubActorMay, clubScope, clubWriteScope, type ClubActor } from './scope';

/**
 * The tablet at the desk (0039 club_kiosk_devices).
 *
 * A shared tablet must never hold a STAFF session — anyone at the desk could
 * then open the office. So a manager creates a device and gets a 6-digit code
 * (valid 10 minutes); the tablet opens /klub/<slug>/kiosk and types it; the
 * server issues a random secret into an httpOnly cookie scoped to that path,
 * and keeps only its SHA-256. The cookie is "<device id>~<secret>": each
 * request looks the device up by primary key and compares digests in constant
 * time. Revoking the device stops it on its next refresh. The tablet then
 * shows a rotating QR naming the LOCATION (v2~loc token) — no person, ever.
 *
 * A DOOR CONTROLLER (0057) lives in the same table with kind = 'door', and its
 * secret has a tablet cookie's shape — so every lookup here names the kind,
 * and apps/web/lib/clubs/doors.ts names the other one.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TransactionalDb extends SqlRunner {
  transaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

export const PAIRING_MINUTES = 10;
export const KIOSK_COOKIE = 'pops_kiosk';
const COOKIE_SHAPE = /^([0-9a-f-]{36})~([A-Za-z0-9_-]{40,60})$/;

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export interface KioskDevice {
  id: string;
  name: string;
  locationName: string;
  state: 'pairing' | 'paired' | 'expired' | 'revoked';
  lastSeenAt: string | null;
}

export async function listKioskDevices(actor: ClubActor): Promise<KioskDevice[]> {
  const result = await getDb().execute(sql`
    SELECT kd.id, kd.name, l.name AS location_name, kd.paired_at, kd.revoked_at,
           (kd.pairing_expires_at > now()) AS code_live, kd.last_seen_at
      FROM club_kiosk_devices kd JOIN club_locations l ON l.id = kd.location_id
     WHERE ${clubScope(actor, 'kiosk.manage', 'kd')} AND kd.kind = 'kiosk'
     ORDER BY kd.revoked_at NULLS FIRST, kd.created_at DESC
  `);
  return result.rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    locationName: String(row.location_name),
    state: row.revoked_at
      ? 'revoked'
      : row.paired_at
        ? 'paired'
        : row.code_live === true
          ? 'pairing'
          : 'expired',
    lastSeenAt: row.last_seen_at ? new Date(String(row.last_seen_at)).toISOString() : null,
  }));
}

/** Create a device and its first pairing code; the code is shown once. */
export async function createKioskDevice(
  db: TransactionalDb,
  actor: ClubActor,
  locationId: string,
  name: string,
): Promise<{ deviceId: string; code: string } | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const code = generatePairingCode();
    try {
      return await db.transaction(async (tx) => {
        const created = await tx.execute(sql`
          INSERT INTO club_kiosk_devices (club_id, location_id, name, pairing_code_hash,
                                          pairing_expires_at, created_by)
          SELECT l.club_id, l.id, ${name}, ${pairingCodeHash(actor.clubId, code)},
                 now() + make_interval(mins => ${PAIRING_MINUTES}::int), ${actor.userId}
            FROM club_locations l
           WHERE l.id = ${locationId}::uuid AND l.active
             AND ${clubWriteScope(actor, 'kiosk.manage', 'l')}
          RETURNING id
        `);
        const deviceId = text(created.rows[0]?.id);
        if (!deviceId) return null;
        await recordClubAudit(tx, {
          clubId: actor.clubId,
          by: { kind: 'staff', actor },
          action: 'kiosk_created',
          detail: { deviceId },
        });
        return { deviceId, code };
      });
    } catch (error: unknown) {
      // Two live codes in one club collided (1 in a million): draw again.
      if (violatedConstraint(error) !== 'club_kiosk_devices_live_code_unique') {
        throw error;
      }
    }
  }
  return null;
}

/** A fresh code for a device that is not (or no longer) paired. */
export async function newPairingCode(
  db: TransactionalDb,
  actor: ClubActor,
  deviceId: string,
): Promise<string | null> {
  const code = generatePairingCode();
  const updated = await db.execute(sql`
    UPDATE club_kiosk_devices kd
       SET pairing_code_hash = ${pairingCodeHash(actor.clubId, code)},
           pairing_expires_at = now() + make_interval(mins => ${PAIRING_MINUTES}::int)
     WHERE kd.id = ${deviceId}::uuid AND kd.kind = 'kiosk' AND kd.paired_at IS NULL
       AND kd.revoked_at IS NULL AND ${clubWriteScope(actor, 'kiosk.manage', 'kd')}
     RETURNING kd.id
  `);
  return updated.rows.length > 0 ? code : null;
}

/**
 * The tablet types the code. Success returns the cookie value — the only time
 * the secret exists outside the tablet. Wrong or expired codes return null;
 * the caller rate-limits attempts.
 */
export async function pairKiosk(
  db: TransactionalDb,
  clubSlug: string,
  code: string,
): Promise<{ cookie: string; deviceId: string } | null> {
  if (!/^\d{6}$/.test(code)) return null;
  return db.transaction(async (tx) => {
    const club = await tx.execute(
      sql`SELECT id FROM clubs WHERE slug = ${clubSlug} AND status = 'active'`,
    );
    const clubId = text(club.rows[0]?.id);
    if (!clubId) return null;
    const secret = generateKioskSecret();
    const paired = await tx.execute(sql`
      UPDATE club_kiosk_devices
         SET secret_hash = ${sha256Hex(secret)}, paired_at = now(), last_seen_at = now(),
             pairing_code_hash = NULL, pairing_expires_at = NULL
       WHERE club_id = ${clubId}::uuid AND pairing_code_hash = ${pairingCodeHash(clubId, code)}
         AND kind = 'kiosk' AND pairing_expires_at > now() AND revoked_at IS NULL
         AND paired_at IS NULL
       RETURNING id
    `);
    const deviceId = text(paired.rows[0]?.id);
    if (!deviceId) return null;
    await recordClubAudit(tx, {
      clubId,
      by: { kind: 'kiosk' },
      action: 'kiosk_paired',
      detail: { deviceId },
    });
    return { cookie: `${deviceId}~${secret}`, deviceId };
  });
}

export interface KioskSession {
  deviceId: string;
  clubId: string;
  clubSlug: string;
  clubName: string;
  logoPath: string | null;
  locationId: string;
  locationName: string;
  /** False when the club cannot operate (pending, lapsed, suspended…). */
  live: boolean;
}

/** The device behind a kiosk cookie, or null (unknown, revoked, wrong club). */
export async function kioskFromCookie(
  clubSlug: string,
  cookie: string | undefined,
): Promise<KioskSession | null> {
  const match = cookie ? COOKIE_SHAPE.exec(cookie) : null;
  if (!match) return null;
  const [, deviceId, secret] = match as unknown as [string, string, string];
  const result = await getDb().execute(sql`
    SELECT kd.id, kd.secret_hash, kd.last_seen_at, c.id AS club_id, c.slug, c.name_bg, c.logo_path,
           l.id AS location_id, l.name AS location_name,
           (c.status = 'active' AND (c.tier = 'community'
              OR greatest(c.paid_until, c.trial_ends_on) + 14 >= (now() AT TIME ZONE 'Europe/Sofia')::date))
             AS live
      FROM club_kiosk_devices kd
      JOIN clubs c ON c.id = kd.club_id
      JOIN club_locations l ON l.id = kd.location_id
     WHERE kd.id = ${deviceId}::uuid AND c.slug = ${clubSlug} AND kd.kind = 'kiosk'
       AND kd.revoked_at IS NULL AND kd.secret_hash IS NOT NULL
  `);
  const row = result.rows[0];
  if (!row || !digestsEqual(String(row.secret_hash), sha256Hex(secret))) return null;
  const lastSeen = row.last_seen_at ? new Date(String(row.last_seen_at)).getTime() : 0;
  if (Date.now() - lastSeen > 5 * 60_000) {
    await getDb().execute(
      sql`UPDATE club_kiosk_devices SET last_seen_at = now() WHERE id = ${deviceId}::uuid`,
    );
  }
  return {
    deviceId,
    clubId: String(row.club_id),
    clubSlug: String(row.slug),
    clubName: String(row.name_bg),
    logoPath: text(row.logo_path),
    locationId: String(row.location_id),
    locationName: String(row.location_name),
    live: row.live === true,
  };
}

export async function revokeKiosk(
  db: TransactionalDb,
  actor: ClubActor,
  deviceId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE club_kiosk_devices kd
         SET revoked_at = now(), pairing_code_hash = NULL, pairing_expires_at = NULL
       WHERE kd.id = ${deviceId}::uuid AND kd.kind = 'kiosk' AND kd.revoked_at IS NULL
         AND ${clubScope(actor, 'kiosk.manage', 'kd')}
         AND ${clubActorMay(actor, 'kiosk.manage', { write: false })}
       RETURNING kd.id
    `);
    if (updated.rows.length === 0) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'kiosk_revoked',
      detail: { deviceId },
    });
    return true;
  });
}

/**
 * Where the kiosk cookie lives: the kiosk page itself, with the locale prefix
 * next-intl puts on it (bg has none). The secret never travels to any other
 * page of the site.
 */
export function kioskCookiePath(slug: string, locale: string): string {
  return `${locale === 'bg' ? '' : `/${locale}`}/klub/${slug}/kiosk`;
}

/** How many arrivals this kiosk's location has had today — a number, no names. */
export async function kioskTodayCount(session: KioskSession): Promise<number> {
  const result = await getDb().execute(sql`
    SELECT count(*)::int AS n FROM club_checkins
     WHERE club_id = ${session.clubId}::uuid AND location_id = ${session.locationId}::uuid
       AND sofia_day = (now() AT TIME ZONE 'Europe/Sofia')::date
  `);
  return Number(result.rows[0]?.n ?? 0);
}

export interface KioskLocation {
  locationId: string;
  locationName: string;
  clubId: string;
  clubSlug: string;
  clubName: string;
}

/**
 * The club and location a kiosk token names, for the page a member's phone
 * opens. Only an active location of a club that is not archived resolves.
 */
export async function kioskLocation(
  locationId: string,
  locale: string,
): Promise<KioskLocation | null> {
  const result = await getDb().execute(sql`
    SELECT l.id, l.name, c.id AS club_id, c.slug,
           CASE WHEN ${locale} = 'en' THEN coalesce(c.name_en, c.name_bg) ELSE c.name_bg END AS club_name
      FROM club_locations l
      JOIN clubs c ON c.id = l.club_id
     WHERE l.id = ${locationId}::uuid AND l.active AND c.status <> 'archived'
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    locationId: String(row.id),
    locationName: String(row.name),
    clubId: String(row.club_id),
    clubSlug: String(row.slug),
    clubName: String(row.club_name),
  };
}
