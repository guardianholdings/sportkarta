import { sql, type SQL } from '@sportkarta/db';

/**
 * Weekly-digest opt-in (docs/ROADMAP.md §6, Stage 4.4).
 *
 * Signed-in members only: the address is already verified by OTP sign-in, so
 * there is no double-opt-in flow to build and nobody can subscribe somebody
 * else. Every subscription carries its own random token so unsubscribing is one
 * click with no session — a person who has lost interest must not have to sign
 * in to make the mail stop.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface DigestSubscriptionRow {
  municipalityId: number;
  nameBg: string;
  nameEn: string;
  unsubscribeToken: string;
}

/**
 * URL-safe, 32 chars, from the platform CSPRNG — matching the shape CHECK on
 * the column, which exists so a truncated or predictable generator fails closed
 * rather than storing something guessable.
 */
export function newUnsubscribeToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}

export async function subscriptionsFor(
  db: SqlRunner,
  userId: string,
): Promise<DigestSubscriptionRow[]> {
  const result = await db.execute(sql`
    SELECT d.municipality_id, m.name_bg, m.name_en, d.unsubscribe_token
      FROM digest_subscriptions d
      JOIN municipalities m ON m.id = d.municipality_id
     WHERE d.user_id = ${userId}
     ORDER BY m.name_bg
  `);
  return result.rows.map((row) => ({
    municipalityId: Number(row.municipality_id),
    nameBg: String(row.name_bg),
    nameEn: String(row.name_en),
    unsubscribeToken: String(row.unsubscribe_token),
  }));
}

/**
 * Opt in. Idempotent by the primary key, so a double-submitted toggle is a
 * no-op that KEEPS the original token — re-issuing it would silently break the
 * unsubscribe link in every digest already sitting in the member's inbox.
 */
export async function subscribe(
  db: SqlRunner,
  userId: string,
  municipalityId: number,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO digest_subscriptions (user_id, municipality_id, unsubscribe_token)
    VALUES (${userId}, ${municipalityId}, ${newUnsubscribeToken()})
    ON CONFLICT (user_id, municipality_id) DO NOTHING
  `);
}

export async function unsubscribe(
  db: SqlRunner,
  userId: string,
  municipalityId: number,
): Promise<void> {
  await db.execute(sql`
    DELETE FROM digest_subscriptions
     WHERE user_id = ${userId} AND municipality_id = ${municipalityId}
  `);
}

/**
 * One-click unsubscribe, no session. Returns the city name for the confirmation
 * page, or null when the token is unknown — which is also what a second click
 * on the same link produces, and the UI says so rather than pretending to fail.
 */
export async function unsubscribeByToken(
  db: SqlRunner,
  token: string,
): Promise<{ nameBg: string; nameEn: string } | null> {
  const result = await db.execute(sql`
    DELETE FROM digest_subscriptions d
     USING municipalities m
     WHERE m.id = d.municipality_id AND d.unsubscribe_token = ${token}
    RETURNING m.name_bg, m.name_en
  `);
  const row = result.rows[0];
  if (!row) return null;
  return { nameBg: String(row.name_bg), nameEn: String(row.name_en) };
}

export interface DigestCity {
  id: number;
  nameBg: string;
  nameEn: string;
}

/**
 * Cities worth offering on the profile: those with at least one scheduled
 * session, plus any the member is already subscribed to (so an opt-in never
 * disappears from the list just because a city went quiet this week).
 *
 * Deliberately not "every municipality" — there are 265, and a list that long
 * is not a choice, it is a wall.
 */
export async function digestCities(db: SqlRunner, userId: string): Promise<DigestCity[]> {
  const result = await db.execute(sql`
    SELECT m.id, m.name_bg, m.name_en
      FROM municipalities m
     WHERE EXISTS (
             SELECT 1
               FROM play_sessions s
               JOIN facilities f ON f.id = s.facility_id
              WHERE f.municipality_id = m.id AND s.status = 'scheduled'
           )
        OR EXISTS (
             SELECT 1 FROM digest_subscriptions d
              WHERE d.municipality_id = m.id AND d.user_id = ${userId}
           )
     ORDER BY m.name_bg
  `);
  return result.rows.map((row) => ({
    id: Number(row.id),
    nameBg: String(row.name_bg),
    nameEn: String(row.name_en),
  }));
}
