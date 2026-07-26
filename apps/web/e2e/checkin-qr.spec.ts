import { issueCheckinToken } from '@sportkarta/lib/checkin-token';
import { POINTS_BY_EVENT } from '@sportkarta/lib/points';
import { expect, test } from '@playwright/test';
import { config } from 'dotenv';
import pg from 'pg';

import bg from '../messages/bg.json';

import { signIn } from './auth';

/**
 * The scored line with its `{points}` placeholder filled, as next-intl renders
 * it. The suite has no ICU formatter, and this message uses only a simple
 * argument, so a literal substitution is exact.
 */
function scoredMessage(points: number): string {
  return bg.Checkin.outcome.scored.replace('{points}', String(points));
}

/**
 * QR/geofence-verified scoring (Stage 5.4), end to end.
 *
 * The test knows the HMAC secret, which is the point: it can mint a token the
 * way the organiser's screen does, and then check that the things which are
 * supposed to make that token worth points actually do. What it must never be
 * able to do is score without one.
 */

config({ path: '../../.env' });

const ORGANIZER_ID = 'e2e_qr_org';
const MEMBER_EMAIL = 'e2e-qr-member@example.org';

let occurrenceId = '';
let facility = { lat: 0, lon: 0 };
let secret = '';

async function withDb<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required for the QR check-in e2e suite');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

test.beforeAll(async () => {
  secret = process.env.CHECKIN_TOKEN_SECRET?.trim() ?? '';
  await withDb(async (client) => {
    await client.query(`DELETE FROM play_sessions WHERE organizer_id = $1`, [ORGANIZER_ID]);
    await client.query(`DELETE FROM users WHERE id = $1 OR email = $2`, [
      ORGANIZER_ID,
      MEMBER_EMAIL,
    ]);
    await client.query(
      `INSERT INTO users (id, display_name, email) VALUES ($1, 'Организатор', 'e2e-qr-org@example.org')`,
      [ORGANIZER_ID],
    );
    const f = await client.query<{ id: string; lat: number; lon: number }>(
      `SELECT id, ST_Y(geom) AS lat, ST_X(geom) AS lon FROM facilities
        WHERE slug IS NOT NULL AND status <> 'gone' ORDER BY created_at LIMIT 1`,
    );
    facility = { lat: Number(f.rows[0]?.lat), lon: Number(f.rows[0]?.lon) };

    // Starting in five minutes: inside the check-in window, which opens half an
    // hour early.
    const session = await client.query<{ id: string }>(
      `INSERT INTO play_sessions
         (facility_id, sport, organizer_id, title, starts_at_local, duration_minutes, capacity)
       VALUES ($1::uuid, 'basketball', $2, 'E2E QR тренировка',
               ((now() AT TIME ZONE 'Europe/Sofia') + interval '5 minutes')::timestamp, 90, 10)
       RETURNING id`,
      [f.rows[0]?.id, ORGANIZER_ID],
    );
    const occurrence = await client.query<{ id: string }>(
      `INSERT INTO play_session_occurrences (session_id, starts_at, ends_at, starts_at_local)
       SELECT $1::uuid,
              (s.starts_at_local AT TIME ZONE 'Europe/Sofia'),
              (s.starts_at_local AT TIME ZONE 'Europe/Sofia') + interval '90 minutes',
              s.starts_at_local
         FROM play_sessions s WHERE s.id = $1::uuid
       RETURNING id`,
      [session.rows[0]?.id],
    );
    occurrenceId = occurrence.rows[0]?.id ?? '';
  });
});

test.afterAll(async () => {
  await withDb(async (client) => {
    await client.query(`DELETE FROM play_sessions WHERE organizer_id = $1`, [ORGANIZER_ID]);
    await client.query(`DELETE FROM users WHERE id = $1 OR email = $2`, [
      ORGANIZER_ID,
      MEMBER_EMAIL,
    ]);
  });
});

test.describe('QR check-in', () => {
  test.skip(
    () => !process.env.CHECKIN_TOKEN_SECRET,
    'CHECKIN_TOKEN_SECRET is unset — QR check-in is correctly disabled',
  );

  test('a forged token is refused without saying why', async ({ page }) => {
    const forged = `v1~${occurrenceId}~29746848~AAAAAAAAAAAAAAAAAAAAAA`;
    await page.goto(`/otmetka/${forged}`);
    await expect(page.getByText(bg.Checkin.invalidHeading)).toBeVisible();
    // "Expired" and "forged" must read identically: the difference is exactly
    // the oracle the verifier is careful not to be.
    await expect(page.locator('body')).not.toContainText('signature');
    await expect(page.locator('body')).not.toContainText('expired');
  });

  test('an expired token is refused in the same words', async ({ page }) => {
    const stale = issueCheckinToken({
      occurrenceId,
      secret,
      at: new Date(Date.now() - 10 * 60_000),
    });
    await page.goto(`/otmetka/${stale}`);
    await expect(page.getByText(bg.Checkin.invalidHeading)).toBeVisible();
  });

  test('a valid token inside the geofence scores, and a repeat does not', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude: facility.lat, longitude: facility.lon });
    await signIn(page, MEMBER_EMAIL, /\/profil/);

    const token = issueCheckinToken({ occurrenceId, secret });
    await page.goto(`/otmetka/${token}`);
    await page.getByRole('button', { name: bg.Checkin.submit }).click();
    // The success line names the FIGURE (A2). Asserting the raw catalogue
    // string would pass against the literal "{points}" and therefore prove
    // nothing — fill it the way next-intl does, so this fails if the number
    // stops being interpolated or the award silently changes.
    await expect(page.getByText(scoredMessage(POINTS_BY_EVENT.session_attended))).toBeVisible();

    const scored = await withDb((client) =>
      client.query<{ scored: boolean; distance_m: number; method: string }>(
        `SELECT scored, distance_m, method FROM play_session_checkins
          WHERE occurrence_id = $1::uuid`,
        [occurrenceId],
      ),
    );
    expect(scored.rows[0]?.scored).toBe(true);
    expect(scored.rows[0]?.method).toBe('qr');
    // The DISTANCE is stored; the coordinates are not, and there is no column
    // that could hold them.
    expect(scored.rows[0]?.distance_m).toBeLessThanOrEqual(250);

    const ledger = await withDb((client) =>
      client.query<{ n: string }>(
        `SELECT count(*) AS n FROM points_ledger WHERE event = 'session_attended'
          AND idempotency_key LIKE $1`,
        [`session_attended:${occurrenceId}:%`],
      ),
    );
    expect(Number(ledger.rows[0]?.n)).toBe(1);

    // Scanning again: recorded once, paid once.
    const second = issueCheckinToken({ occurrenceId, secret });
    await page.goto(`/otmetka/${second}`);
    await page.getByRole('button', { name: bg.Checkin.submit }).click();
    await expect(page.getByText(bg.Checkin.outcome.unscored_already)).toBeVisible();

    const after = await withDb((client) =>
      client.query<{ n: string }>(
        `SELECT count(*) AS n FROM points_ledger WHERE event = 'session_attended'
          AND idempotency_key LIKE $1`,
        [`session_attended:${occurrenceId}:%`],
      ),
    );
    expect(Number(after.rows[0]?.n)).toBe(1);
  });

  test('the organiser screen is organiser-only and rotates its code', async ({ page }) => {
    // A member who is not the organiser gets a 404, not a "forbidden": they
    // have no business learning the check-in screen exists.
    await signIn(page, MEMBER_EMAIL, /\/profil/);
    const asMember = await page.goto(`/sesiya/${occurrenceId}/qr`);
    expect(asMember?.status()).toBe(404);
  });
});

test.describe('QR check-in when the secret is unset', () => {
  test.skip(
    () => Boolean(process.env.CHECKIN_TOKEN_SECRET),
    'a secret IS configured — the fail-closed path is covered by the unit tests',
  );

  test('fails closed rather than accepting anything', async ({ page }) => {
    await page.goto(`/otmetka/v1~${occurrenceId}~29746848~AAAAAAAAAAAAAAAAAAAAAA`);
    await expect(page.getByText(bg.Checkin.disabled)).toBeVisible();
  });
});
