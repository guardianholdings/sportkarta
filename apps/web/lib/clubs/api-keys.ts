import { getDb, sql, type SQL } from '@sportkarta/db';
import {
  CLUB_API_KEYS_MAX,
  CLUB_TIERS,
  isClubApiScope,
  isClubRole,
  type ClubApiScope,
  type ClubTier,
} from '@sportkarta/lib/clubs';
import {
  clubApiKeyPrefixOf,
  generateClubApiKey,
  isClubApiKeyShape,
  sha256Hex,
} from '@sportkarta/lib/clubs/secrets';

import { clubWritableSql } from './access';
import { recordClubAudit } from './audit';
import { clubFeatureSql } from './features';
import { clubScope, clubStaffWriteScope, type ClubActor } from './scope';

/**
 * A club's API keys (0057) — the open-data key discipline
 * (apps/web/lib/opendata/keys.ts) applied to a key that DOES gate access.
 *
 *  - The key exists in plaintext only in the response that shows it once;
 *    the table holds its SHA-256 (CHECK-pinned) and six characters.
 *  - A key ACTS AS ITS CREATOR: verification returns a ClubActor for the
 *    member of staff who issued it, with their role as it is NOW, and every
 *    request runs the office's own scoped statements as them. Only the
 *    club's own management may issue one (clubStaffWriteScope — the NGO admin
 *    reads the list, and may revoke, but never mints a key for a club). A key
 *    verifies only while its creator's account is not suspended and they hold
 *    the SAME staff grant they held when they issued it: removed from the
 *    club, their keys die, and adding them back later does not revive them
 *    (the grant is newer than the key).
 *  - The lookup is one hash and one unique-index probe whichever key is
 *    presented; last_used_at moves at most once a minute (0015's reasoning:
 *    a column for spotting unused keys, not an activity log).
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

function iso(value: unknown): string | null {
  return value === null || value === undefined ? null : new Date(String(value)).toISOString();
}

function scopesOf(value: unknown): ClubApiScope[] {
  return Array.isArray(value) ? value.filter(isClubApiScope) : [];
}

function isTier(value: unknown): value is ClubTier {
  return typeof value === 'string' && (CLUB_TIERS as readonly string[]).includes(value);
}

export interface ClubApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  scopes: ClubApiScope[];
  creatorName: string | null;
  /** False once the creator left the club: the key no longer verifies. */
  creatorActive: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export async function listClubApiKeys(actor: ClubActor): Promise<ClubApiKeySummary[]> {
  const result = await getDb().execute(sql`
    SELECT ak.id, ak.name, ak.prefix, ak.scopes, ak.created_at, ak.last_used_at,
           coalesce(nullif(btrim(st.display_name), ''), nullif(btrim(u.display_name), '')) AS creator_name,
           (st.user_id IS NOT NULL AND st.created_at <= ak.created_at
            AND u.suspended_at IS NULL) AS creator_active
      FROM club_api_keys ak
      LEFT JOIN club_staff st ON st.club_id = ak.club_id AND st.user_id = ak.created_by
      LEFT JOIN users u ON u.id = ak.created_by
     WHERE ${clubScope(actor, 'api.manage', 'ak')} AND ak.revoked_at IS NULL
     ORDER BY ak.created_at DESC, ak.id
  `);
  return result.rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    prefix: String(row.prefix),
    scopes: scopesOf(row.scopes),
    creatorName: text(row.creator_name),
    creatorActive: row.creator_active === true,
    createdAt: iso(row.created_at) ?? '',
    lastUsedAt: iso(row.last_used_at),
  }));
}

export type IssueKeyResult =
  { ok: true; id: string; key: string } | { ok: false; error: 'too_many_keys' | 'not_allowed' };

/** Issue a key acting as `actor`. The plaintext is returned once and never again. */
export async function issueClubApiKey(
  db: TransactionalDb,
  actor: ClubActor,
  input: { name: string; scopes: readonly ClubApiScope[] },
): Promise<IssueKeyResult> {
  const key = generateClubApiKey();
  return db.transaction(async (tx) => {
    // One issue at a time per club, so the cap is a real maximum.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`club_api_keys:${actor.clubId}`}, 0))`,
    );
    const created = await tx.execute(sql`
      INSERT INTO club_api_keys (club_id, name, key_hash, prefix, scopes, created_by)
      SELECT ak.club_id, ${input.name}, ${sha256Hex(key)}, ${clubApiKeyPrefixOf(key)},
             ${sql.param([...input.scopes])}::text[], ${actor.userId}
        -- The creator's own staff row: the key acts as them.
        FROM club_staff ak
       WHERE ak.user_id = ${actor.userId} AND ${clubStaffWriteScope(actor, 'api.manage', 'ak')}
         AND ${clubFeatureSql(actor.clubId, 'api')}
         AND (SELECT count(*) FROM club_api_keys k
               WHERE k.club_id = ak.club_id AND k.revoked_at IS NULL) < ${CLUB_API_KEYS_MAX}
      RETURNING id
    `);
    const id = text(created.rows[0]?.id);
    if (!id) {
      const live = await tx.execute(sql`
        SELECT count(*)::int AS n FROM club_api_keys
         WHERE club_id = ${actor.clubId}::uuid AND revoked_at IS NULL
      `);
      const full = Number(live.rows[0]?.n ?? 0) >= CLUB_API_KEYS_MAX;
      return { ok: false, error: full ? 'too_many_keys' : 'not_allowed' } as const;
    }
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'api_key_created',
      detail: { key: id, scopes: [...input.scopes].sort().join(',') },
    });
    return { ok: true, id, key } as const;
  });
}

/**
 * Revoke: setting revoked_at, never deleting. Protective, so it works while
 * the club is read-only too (a lapsed club must still be able to stop a
 * leaked key), and the NGO admin may do it.
 */
export async function revokeClubApiKey(
  db: TransactionalDb,
  actor: ClubActor,
  keyId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const revoked = await tx.execute(sql`
      UPDATE club_api_keys ak
         SET revoked_at = now(), revoked_by = ${actor.userId}
       WHERE ak.id = ${keyId}::uuid AND ak.revoked_at IS NULL
         AND ${clubScope(actor, 'api.manage', 'ak')}
      RETURNING ak.id
    `);
    if (revoked.rows.length === 0) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'api_key_revoked',
      detail: { key: keyId },
    });
    return true;
  });
}

export interface VerifiedClubKey {
  keyId: string;
  clubId: string;
  clubSlug: string;
  tier: ClubTier;
  scopes: ClubApiScope[];
  /** The creator, with their role now — what every statement runs as. */
  actor: ClubActor;
}

/**
 * A presented key, or null: unknown, revoked, its creator gone from the club
 * (or re-added since), their account suspended, or the club not operating
 * (pending, suspended, archived, past its grace).
 * One statement; last_used_at is bumped in it when a minute stale.
 */
export async function verifyClubApiKey(presented: string): Promise<VerifiedClubKey | null> {
  if (!isClubApiKeyShape(presented)) return null;
  const result = await getDb().execute(sql`
    WITH k AS (
      SELECT ak.id, ak.club_id, ak.scopes, ak.created_by, st.role, c.slug, c.tier
        FROM club_api_keys ak
        JOIN club_staff st ON st.club_id = ak.club_id AND st.user_id = ak.created_by
                          AND st.created_at <= ak.created_at
        JOIN users u ON u.id = ak.created_by AND u.suspended_at IS NULL
        JOIN clubs c ON c.id = ak.club_id
       WHERE ak.key_hash = ${sha256Hex(presented)} AND ak.revoked_at IS NULL
         AND ${clubWritableSql('c')}
    ), touched AS (
      UPDATE club_api_keys SET last_used_at = date_trunc('minute', now())
       WHERE id IN (SELECT id FROM k)
         AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')
      RETURNING id
    )
    SELECT k.* FROM k
  `);
  const row = result.rows[0];
  if (!row || !isClubRole(row.role) || !isTier(row.tier)) return null;
  const clubId = String(row.club_id);
  const keyId = String(row.id);
  return {
    keyId,
    clubId,
    clubSlug: String(row.slug),
    tier: row.tier,
    scopes: scopesOf(row.scopes),
    actor: {
      userId: String(row.created_by),
      clubId,
      role: row.role,
      ngoAdmin: false,
      apiKeyId: keyId,
    },
  };
}
