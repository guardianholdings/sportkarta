import { expect, test } from '@playwright/test';
import { config } from 'dotenv';
import pg from 'pg';

import bg from '../messages/bg.json';

import { signIn } from './auth';

/**
 * RSVP, the session page and the calendar endpoints (Stage 4.2).
 *
 * What the WEB APP owns is asserted here: the page renders, joining moves the
 * member into "you are going", withdrawing puts them back, and both .ics
 * endpoints serve a well-formed calendar with the right cache and robots
 * headers. Sending is the worker's job and is covered by the unit tests in
 * lib/src/email and the ledger tests in db/src — a Playwright run has no worker,
 * so asserting on delivered mail here would only ever assert on nothing.
 */

config({ path: '../../.env' });

const ORGANIZER_ID = 'e2e_rsvp_org';
const MEMBER_EMAIL = 'e2e-rsvp@example.org';
const FEED_TOKEN = 'e2ecalendarfeedtoken12345';

let occurrenceId = '';

async function withDb<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required for the RSVP e2e suite');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

test.beforeAll(async () => {
  occurrenceId = await withDb(async (client) => {
    await client.query(`DELETE FROM play_sessions WHERE organizer_id = $1`, [ORGANIZER_ID]);
    await client.query(`DELETE FROM users WHERE id = $1`, [ORGANIZER_ID]);
    await client.query(
      `INSERT INTO users (id, display_name, email) VALUES ($1, 'Организатор', 'e2e-rsvp-org@example.org')`,
      [ORGANIZER_ID],
    );
    const facility = await client.query<{ id: string }>(
      `SELECT id FROM facilities WHERE slug IS NOT NULL AND status <> 'gone' ORDER BY created_at LIMIT 1`,
    );
    // Far enough out that it is open for RSVP whenever the suite runs, and
    // outside both reminder windows so a live worker would not mail anybody.
    const session = await client.query<{ id: string; starts_at_local: string }>(
      `INSERT INTO play_sessions
         (facility_id, sport, organizer_id, title, starts_at_local, duration_minutes, capacity)
       VALUES ($1::uuid, 'football', $2, 'E2E тренировка',
               (date_trunc('hour', now() AT TIME ZONE 'Europe/Sofia') + interval '30 days')::timestamp,
               90, 10)
       RETURNING id, starts_at_local`,
      [facility.rows[0]?.id, ORGANIZER_ID],
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
    return occurrence.rows[0]?.id ?? '';
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

test.describe('session page and RSVP', () => {
  test('shows the session to a signed-out visitor without offering to sign them up', async ({
    page,
  }) => {
    await page.goto(`/sesiya/${occurrenceId}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('E2E тренировка');
    await expect(page.getByText(bg.Session.signInToJoin)).toBeVisible();
    // The organiser IS named — organising a session strangers are invited to is
    // a public act, and somebody has to be answerable for it.
    await expect(page.getByRole('definition').filter({ hasText: 'Организатор' })).toBeVisible();
    // No attendee list, ever, and no address: a public page naming people next
    // to a place and a recurring time publishes where they reliably are.
    await expect(page.locator('body')).not.toContainText(MEMBER_EMAIL);
    await expect(page.locator('body')).not.toContainText('@example.org');
  });

  test('a member joins, sees their place, and can withdraw', async ({ page }) => {
    await signIn(page, MEMBER_EMAIL, /\/profil/);
    await page.goto(`/sesiya/${occurrenceId}`);

    await page.getByRole('button', { name: bg.Session.join }).click();
    await expect(page.getByText(bg.Session.youAreGoing)).toBeVisible();

    await page.getByRole('button', { name: bg.Session.leave }).click();
    await expect(page.getByText(bg.Session.youAreGoing)).toBeHidden();
    await expect(page.getByRole('button', { name: bg.Session.join })).toBeVisible();
  });
});

test.describe('calendar endpoints', () => {
  test('the per-session .ics is a well-formed download', async ({ request }) => {
    const response = await request.get(`/kalendar/sesiya/${occurrenceId}.ics`);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/calendar');
    expect(response.headers()['content-disposition']).toContain('attachment');

    const ics = await response.text();
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain(`UID:occurrence-${occurrenceId}@`);
    // The instants are absolute, so no copy of Bulgaria's DST rules ships here.
    expect(ics).not.toContain('VTIMEZONE');
  });

  test('the private feed is bearer-authenticated, uncacheable and noindex', async ({ request }) => {
    await withDb((client) =>
      client.query(
        `INSERT INTO calendar_tokens (user_id, token) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET token = EXCLUDED.token`,
        [ORGANIZER_ID, FEED_TOKEN],
      ),
    );

    const response = await request.get(`/kalendar/${FEED_TOKEN}.ics`);
    expect(response.status()).toBe(200);
    // The URL IS the credential: it must never sit in a shared cache, and a
    // leaked token must not also become a search result.
    expect(response.headers()['cache-control']).toContain('no-store');
    expect(response.headers()['cache-control']).toContain('private');
    expect(response.headers()['x-robots-tag']).toContain('noindex');

    const ics = await response.text();
    // The organiser's own series appears in their feed.
    expect(ics).toContain(`UID:occurrence-${occurrenceId}@`);
  });

  test('an unknown or malformed token is a flat 404', async ({ request }) => {
    // Nothing distinguishes "never existed" from "rotated" — saying which would
    // confirm a guess.
    expect((await request.get('/kalendar/aaaaaaaaaaaaaaaaaaaaaaaaaa.ics')).status()).toBe(404);
    expect((await request.get('/kalendar/short.ics')).status()).toBe(404);
  });
});
