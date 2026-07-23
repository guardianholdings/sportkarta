import { createHash, randomBytes } from 'node:crypto';

import { getDb, sql } from '@sportkarta/db';

/**
 * Free API keys for the open-data API (Stage 6.1). Server-only.
 *
 * WHAT A KEY IS FOR, STATED FIRST, BECAUSE IT DECIDES EVERYTHING ELSE. It is
 * not an access control. The data is ODbL-public and the API answers anonymous
 * requests in full — requiring registration to read a public dataset would be
 * a contradiction, and one that institutions notice. A key does exactly two
 * things: it raises the rate limit, and it gives an abusive client a name we
 * can revoke instead of an IP range we would have to block. So issuing one is
 * instant, free, self-service and unreviewed, and losing one costs the holder
 * throughput rather than access.
 *
 * NO COLUMN STORES A KEY. `key_hash` is SHA-256 hex, and migration 0015's CHECK
 * pins it to 64 lowercase hex characters — a shape an issued key (48 characters)
 * cannot satisfy, on LENGTH rather than on alphabet: a 43-character base64url
 * secret contains neither `-` nor `_` about a quarter of the time, so an
 * argument from the character set would have been only probabilistic.
 * `api_keys_label_no_key` covers the free-text column for the same reason —
 * people paste keys into name boxes. Storing a plaintext key anywhere in this
 * table is therefore a constraint violation rather than a code review somebody
 * has to remember to do.
 *
 * NO HMAC, NO SALT, AND THAT IS DELIBERATE. A password needs a slow, salted KDF
 * because it is low-entropy and reused; this key is 256 bits from a CSPRNG and
 * exists nowhere else. Against that, a brute-force is not a compute problem but
 * a physics one, and per-key salting would only cost the lookup its index — the
 * verification path would have to scan every row. Plain SHA-256 with a unique
 * index is the right shape here; the entropy is doing the work.
 *
 * The lookup is by hash equality on a unique index, so there is no
 * secret-dependent comparison in the application to leak timing: whichever key
 * is presented, the work is one hash and one index probe.
 */

/**
 * A visible marker so a leaked key is recognisable in a log or a paste — the
 * property GitHub's secret scanning and every other scanner keys on. Without a
 * distinctive prefix a stray key is just a base64 blob nobody reports.
 */
const KEY_PREFIX = 'skbg_';

/** 32 bytes = 43 base64url characters. */
const KEY_BYTES = 32;

/** Characters of the secret kept alongside the hash so keys are tellable apart. */
const PREFIX_CHARS = 6;

/**
 * Active keys per account. Not a scarcity measure — keys are free — but a
 * bound on what one compromised session can create, and a nudge to revoke
 * rather than accumulate. Hitting it is an error the member can resolve alone.
 */
export const MAX_KEYS_PER_ACCOUNT = 5;

export interface IssuedKey {
  /** The full key. Returned ONCE, at creation, and never recoverable after. */
  key: string;
  id: string;
  prefix: string;
  label: string;
  createdAt: string;
}

export interface ApiKeySummary {
  id: string;
  label: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** `skbg_` + 43 base64url characters. */
export function generateApiKey(): string {
  return KEY_PREFIX + randomBytes(KEY_BYTES).toString('base64url');
}

/** The displayable head of a key: the marker plus six characters of secret. */
export function keyPrefixOf(key: string): string {
  return key.slice(0, KEY_PREFIX.length + PREFIX_CHARS);
}

/**
 * A well-formed key, checked before it is hashed or looked up.
 *
 * Cheap rejection of anything that could not have been issued — a truncated
 * paste, a `Bearer` header somebody filled in with a session cookie — so
 * garbage never reaches the database. It is not a security boundary; the hash
 * lookup is.
 */
const KEY_SHAPE = new RegExp(`^${KEY_PREFIX}[A-Za-z0-9_-]{43}$`);

export function looksLikeApiKey(value: string): boolean {
  return KEY_SHAPE.test(value);
}

export class TooManyKeysError extends Error {
  constructor() {
    super('api key limit reached');
    this.name = 'TooManyKeysError';
  }
}

/**
 * A label that contains a key. `api_keys_label_no_key` forbids it in the
 * database — people paste their key into the name box, and stored there it
 * would sit in cleartext, be rendered back on the keys page, and go into every
 * backup while the hash carried on authenticating it.
 *
 * Checked here as well as in the constraint so the member gets a sentence
 * telling them what to do, rather than a 500 from SQLSTATE 23514. The
 * constraint is what makes it true; this is what makes it kind.
 */
export function labelLooksLikeKey(label: string): boolean {
  return label.includes(KEY_PREFIX);
}

export class LabelLooksLikeKeyError extends Error {
  constructor() {
    super('api key label contains a key');
    this.name = 'LabelLooksLikeKeyError';
  }
}

/**
 * Issue a key. The plaintext exists in memory for the length of this call and
 * in the response that renders it once; nothing else ever sees it again.
 */
export async function issueApiKey(userId: string, label: string): Promise<IssuedKey> {
  const db = getDb();
  const trimmed = label.trim().slice(0, 60);
  if (labelLooksLikeKey(trimmed)) throw new LabelLooksLikeKeyError();
  const key = generateApiKey();

  const result = await db.execute(sql`
    INSERT INTO api_keys (user_id, label, key_hash, prefix)
    SELECT ${userId}, ${trimmed}, ${hashApiKey(key)}, ${keyPrefixOf(key)}
    -- The cap rides along in the INSERT rather than being a separate SELECT,
    -- which narrows the race to a single statement but does NOT close it: at
    -- READ COMMITTED two concurrent inserts can both see four keys and both
    -- write, leaving six. That is accepted rather than fixed, and the reason is
    -- proportion — keys are free, the cap is a bound on what one compromised
    -- session can create rather than a scarce resource, and closing it properly
    -- means an advisory lock or a serialized retry on every issue. Do not read
    -- this as an enforced maximum; it is a limit that holds for people using
    -- the form the ordinary way.
    WHERE (
      SELECT count(*) FROM api_keys
      WHERE user_id = ${userId} AND revoked_at IS NULL
    ) < ${MAX_KEYS_PER_ACCOUNT}
    RETURNING id, prefix, label, created_at
  `);

  const row = result.rows[0];
  if (!row) throw new TooManyKeysError();

  return {
    key,
    id: String(row.id),
    prefix: String(row.prefix),
    label: String(row.label),
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

/** A member's own keys. Never returns a hash — there is nothing to show. */
export async function listApiKeys(userId: string): Promise<ApiKeySummary[]> {
  const db = getDb();
  const result = await db.execute(sql`
    SELECT id, label, prefix, created_at, last_used_at
    FROM api_keys
    WHERE user_id = ${userId} AND revoked_at IS NULL
    ORDER BY created_at DESC
  `);
  return result.rows.map((row) => ({
    id: String(row.id),
    label: String(row.label),
    prefix: String(row.prefix),
    createdAt: new Date(String(row.created_at)).toISOString(),
    lastUsedAt: row.last_used_at ? new Date(String(row.last_used_at)).toISOString() : null,
  }));
}

/**
 * Revoke by setting `revoked_at`, not by deleting.
 *
 * The row is worth keeping: a deleted row frees its hash, and while a
 * collision is not a practical worry, "this key was revoked on the 4th" is an
 * answer somebody will eventually need and a missing row cannot give. Scoped to
 * the owner in the statement, so a wrong id updates zero rows rather than
 * somebody else's key — the same shape as the municipality-scoped moderation
 * writes.
 */
export async function revokeApiKey(userId: string, keyId: string): Promise<boolean> {
  const db = getDb();
  const result = await db.execute(sql`
    UPDATE api_keys
    SET revoked_at = now()
    WHERE id = ${keyId}::uuid AND user_id = ${userId} AND revoked_at IS NULL
    RETURNING id
  `);
  return result.rows.length > 0;
}

export interface VerifiedKey {
  id: string;
  userId: string;
}

/**
 * Verify a presented key.
 *
 * `last_used_at` is bumped in the same statement, but ONLY when it is more than
 * a minute stale. That is not a micro-optimisation: without the guard every
 * request would write a row, turning a read-only public API into a write per
 * request — and, worse, turning `last_used_at` into a precise activity timeline
 * for an identified account. Minute granularity keeps the column useful for its
 * one purpose (spotting a key nobody uses before revoking it) and useless as a
 * log of when somebody was working.
 */
export async function verifyApiKey(presented: string): Promise<VerifiedKey | null> {
  if (!looksLikeApiKey(presented)) return null;
  const db = getDb();
  const result = await db.execute(sql`
    UPDATE api_keys
    SET last_used_at = date_trunc('minute', now())
    WHERE key_hash = ${hashApiKey(presented)}
      AND revoked_at IS NULL
      AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')
    RETURNING id, user_id
  `);
  const updated = result.rows[0];
  if (updated) return { id: String(updated.id), userId: String(updated.user_id) };

  // Used again inside the same minute: the UPDATE matched nothing because of
  // the staleness guard, not because the key is unknown. Fall back to a read.
  const read = await db.execute(sql`
    SELECT id, user_id FROM api_keys
    WHERE key_hash = ${hashApiKey(presented)} AND revoked_at IS NULL
  `);
  const row = read.rows[0];
  return row ? { id: String(row.id), userId: String(row.user_id) } : null;
}
