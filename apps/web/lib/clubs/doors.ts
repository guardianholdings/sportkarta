import 'server-only';

import { getDb, sql, type SQL } from '@sportkarta/db';
import { verifyClubToken } from '@sportkarta/lib/checkin-token';
import {
  CLUB_TIERS,
  isDoorAccessRule,
  type ClubTier,
  type DoorAccessRule,
  type DoorDenial,
} from '@sportkarta/lib/clubs';
import {
  digestsEqual,
  doorToken,
  generateKioskSecret,
  isCardKeyShape,
  parseDoorToken,
  sha256Hex,
} from '@sportkarta/lib/clubs/secrets';

import { checkinSecret } from '../checkin-config';
import { clubWritableSql } from './access';
import { recordClubAudit } from './audit';
import { clubCheckIn, type DoorCredential } from './checkin';
import { clubFeatureSql } from './features';
import { clubScope, clubStaffWriteScope, type ClubActor } from './scope';

/**
 * Door and turnstile controllers (0057): club_kiosk_devices with kind 'door'.
 *
 * A door is created in the office with its secret, shown ONCE as
 * `skbd_<device>.<secret>` for the installer to put in the controller; only
 * its SHA-256 is kept, and the lookup is the kiosk's — by primary key AND
 * kind, then a constant-time digest comparison. The controller posts what it
 * read (a printed card's key, or the text of a member's QR) to
 * /api/clubs/v1/access/check and opens on `allow`.
 *
 * The decision is clubCheckIn's (method 'door'): the club's rule — 'member'
 * opens for any live client record, 'covered' only for one whose abonnement
 * covers this visit — and an allowed entry IS the check-in, written in the
 * same transaction. A refused door records nothing. Vendor adapters (Salto
 * KS, WebLock) wait on partner credentials; anything that can make an HTTPS
 * call — most controllers, or a small bridge beside one — works today.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TransactionalDb extends SqlRunner {
  transaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export interface DoorDevice {
  id: string;
  name: string;
  locationName: string;
  rule: DoorAccessRule;
  lastSeenAt: string | null;
  createdAt: string;
}

export async function listDoorDevices(actor: ClubActor): Promise<DoorDevice[]> {
  const result = await getDb().execute(sql`
    SELECT kd.id, kd.name, kd.access_rule, kd.last_seen_at, kd.created_at, l.name AS location_name
      FROM club_kiosk_devices kd JOIN club_locations l ON l.id = kd.location_id
     WHERE ${clubScope(actor, 'api.manage', 'kd')} AND kd.kind = 'door' AND kd.revoked_at IS NULL
     ORDER BY kd.created_at, kd.id
  `);
  return result.rows.flatMap((row) =>
    isDoorAccessRule(row.access_rule)
      ? [
          {
            id: String(row.id),
            name: String(row.name),
            locationName: String(row.location_name),
            rule: row.access_rule,
            lastSeenAt: row.last_seen_at ? new Date(String(row.last_seen_at)).toISOString() : null,
            createdAt: new Date(String(row.created_at)).toISOString(),
          },
        ]
      : [],
  );
}

/** A new door at a location; its token is returned once. */
export async function createDoorDevice(
  db: TransactionalDb,
  actor: ClubActor,
  input: { locationId: string; name: string; rule: DoorAccessRule },
): Promise<{ deviceId: string; token: string } | null> {
  const secret = generateKioskSecret();
  return db.transaction(async (tx) => {
    const created = await tx.execute(sql`
      INSERT INTO club_kiosk_devices (club_id, location_id, name, kind, access_rule, secret_hash,
                                      paired_at, created_by)
      SELECT l.club_id, l.id, ${input.name}, 'door', ${input.rule}, ${sha256Hex(secret)},
             now(), ${actor.userId}
        FROM club_locations l
       WHERE l.id = ${input.locationId}::uuid AND l.active
         AND ${clubStaffWriteScope(actor, 'api.manage', 'l')}
         AND ${clubFeatureSql(actor.clubId, 'door_access')}
      RETURNING id
    `);
    const deviceId = text(created.rows[0]?.id);
    if (!deviceId) return null;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'door_device_created',
      detail: { deviceId, rule: input.rule },
    });
    return { deviceId, token: doorToken(deviceId, secret) };
  });
}

/** Revoke a door: its next request is refused. Protective — the NGO admin may. */
export async function revokeDoorDevice(
  db: TransactionalDb,
  actor: ClubActor,
  deviceId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const revoked = await tx.execute(sql`
      UPDATE club_kiosk_devices kd SET revoked_at = now()
       WHERE kd.id = ${deviceId}::uuid AND kd.kind = 'door' AND kd.revoked_at IS NULL
         AND ${clubScope(actor, 'api.manage', 'kd')}
      RETURNING kd.id
    `);
    if (revoked.rows.length === 0) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'door_device_revoked',
      detail: { deviceId },
    });
    return true;
  });
}

export interface DoorSession {
  deviceId: string;
  clubId: string;
  tier: ClubTier;
}

/**
 * The door behind a presented token, or null: malformed, unknown, revoked,
 * not a door, or its club not operating.
 */
export async function doorFromToken(presented: string): Promise<DoorSession | null> {
  const parsed = parseDoorToken(presented);
  if (!parsed) return null;
  const result = await getDb().execute(sql`
    SELECT kd.secret_hash, kd.last_seen_at, c.id AS club_id, c.tier
      FROM club_kiosk_devices kd JOIN clubs c ON c.id = kd.club_id
     WHERE kd.id = ${parsed.deviceId}::uuid AND kd.kind = 'door' AND kd.revoked_at IS NULL
       AND kd.secret_hash IS NOT NULL AND ${clubWritableSql('c')}
  `);
  const row = result.rows[0];
  if (!row || !digestsEqual(String(row.secret_hash), sha256Hex(parsed.secret))) return null;
  const tier = String(row.tier);
  if (!(CLUB_TIERS as readonly string[]).includes(tier)) return null;
  const lastSeen = row.last_seen_at ? new Date(String(row.last_seen_at)).getTime() : 0;
  if (Date.now() - lastSeen > 5 * 60_000) {
    await getDb().execute(sql`
      UPDATE club_kiosk_devices SET last_seen_at = date_trunc('minute', now())
       WHERE id = ${parsed.deviceId}::uuid
    `);
  }
  return { deviceId: parsed.deviceId, clubId: String(row.club_id), tier: tier as ClubTier };
}

/**
 * What a controller read, as a credential: a printed card's key, or a member
 * QR — the bare v2~mem token or the /skan/<token> link the portal shows.
 * A QR expires within minutes (it rotates), which is the point.
 */
export function readDoorCredential(
  scanned: string,
): { ok: true; credential: DoorCredential } | { ok: false; denial: DoorDenial } {
  const value = scanned.trim();
  if (value.length === 0 || value.length > 500) return { ok: false, denial: 'unknown_credential' };
  if (isCardKeyShape(value)) return { ok: true, credential: { kind: 'card', cardKey: value } };
  let token = value;
  const marker = value.lastIndexOf('/skan/');
  if (marker >= 0) {
    try {
      token = decodeURIComponent(value.slice(marker + '/skan/'.length).split(/[?#]/)[0] ?? '');
    } catch {
      return { ok: false, denial: 'unknown_credential' };
    }
  }
  const secret = checkinSecret();
  if (!secret) return { ok: false, denial: 'unknown_credential' };
  const verified = verifyClubToken(token, secret, 'mem');
  if (!verified.ok) {
    return {
      ok: false,
      denial: verified.reason === 'expired' ? 'expired_credential' : 'unknown_credential',
    };
  }
  return { ok: true, credential: { kind: 'member', memberId: verified.id } };
}

export type DoorDecision =
  | {
      allow: true;
      checkin: 'recorded' | 'already';
      member: { name: string };
      covered: boolean;
    }
  /** A refusal names nobody: the controller's display is not the desk. */
  | { allow: false; reason: DoorDenial };

/** Decide, and when the door opens, record the visit — one transaction. */
export async function checkDoorAccess(
  db: TransactionalDb,
  door: DoorSession,
  scanned: string,
): Promise<DoorDecision | null> {
  const read = readDoorCredential(scanned);
  if (!read.ok) return { allow: false, reason: read.denial };
  const outcome = await clubCheckIn(db, {
    method: 'door',
    clubId: door.clubId,
    deviceId: door.deviceId,
    credential: read.credential,
  });
  switch (outcome.status) {
    case 'recorded':
    case 'already':
      return {
        allow: true,
        checkin: outcome.status,
        member: { name: outcome.memberName ?? '' },
        covered: outcome.covered === true,
      };
    case 'denied':
      return { allow: false, reason: outcome.denial === 'archived' ? 'archived' : 'not_covered' };
    case 'club_closed':
      return { allow: false, reason: 'club_closed' };
    case 'not_found':
      return { allow: false, reason: 'unknown_credential' };
    default:
      // not_allowed: the door was revoked between its request and now.
      return null;
  }
}
