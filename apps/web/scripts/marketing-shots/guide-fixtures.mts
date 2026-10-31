// The тренировки the front page's recordings show (guide.mjs): an organiser
// named «POPS» — the association schedules the open тренировки — and four
// public series at real places around Южен парк in Sofia, one of them a
// one-off starting in a few minutes so its QR check-in window is open while
// the recording runs. Run by guide.mjs before it captures; never against
// production (it refuses), and only against a database with the OSM places.
//
// Occurrences come from materializeSessions, the one writer of occurrences,
// exactly as the job would produce them.
import { getDb, getPool, materializeSessions, sql } from '@sportkarta/db';

import { fixtureScopeRefusal } from '../../../../db/scripts/seed-plan';
import { fixtureRetirementsRecorded } from '../../../../db/src/seed-fixtures';
import { cancelSeries, createSession } from '../../lib/sessions/sessions';
import { rsvp } from '../../lib/sessions/rsvp';

// The same two refusals as the fixture seed (db/scripts/seed.ts) — the
// production deployment's own flag, and a database that has retired the seed
// fixtures, which only production and copies of it have — plus a third: the
// database must be on this machine. An SSH tunnel to production is local too,
// which is what the retirement check is for.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const target = new URL(process.env.DATABASE_URL ?? 'postgres://unset');
if (process.env.NODE_ENV === 'production' || !LOCAL_HOSTS.has(target.hostname)) {
  throw new Error(`guide fixtures refuse to run against ${target.hostname}: local databases only`);
}
{
  const client = await getPool().connect();
  try {
    const refusal = fixtureScopeRefusal({
      env: process.env,
      retirementsRecorded: await fixtureRetirementsRecorded(client),
    });
    if (refusal) throw new Error(`guide fixtures refuse to run: ${refusal}`);
  } finally {
    client.release();
  }
}

const db = getDb();
const ORGANISER_NAME = 'POPS';
// A test account, never a person: the organiser's name is in the pictures.
const ORGANISER_EMAIL = process.env.SHOTS_ORGANISER_EMAIL ?? 'e2e@example.org';
if (!ORGANISER_EMAIL.endsWith('@example.org')) {
  throw new Error('the organiser must be an @example.org test account');
}
const NOW_TITLE = 'Баскетбол 3×3';

type Row = Record<string, unknown>;
const rows = async (query: ReturnType<typeof sql>): Promise<Row[]> =>
  (await db.execute(query)).rows as Row[];

/** Wall clock in Sofia, `YYYY-MM-DDTHH:MM`, `minutes` from now, on a 5-minute step. */
function sofiaWall(minutesFromNow: number, at?: { days: number; hour: number; minute: number }) {
  const instant = new Date(Date.now() + minutesFromNow * 60_000);
  if (at) instant.setTime(Date.now() + at.days * 86_400_000);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Sofia',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  if (at) {
    return `${parts.year}-${parts.month}-${parts.day}T${String(at.hour).padStart(2, '0')}:${String(at.minute).padStart(2, '0')}`;
  }
  const minute = Math.ceil(Number(parts.minute) / 5) * 5;
  const hour = Number(parts.hour) + Math.floor(minute / 60);
  return `${parts.year}-${parts.month}-${parts.day}T${String(hour % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

async function facilityId(slug: string): Promise<string> {
  const [row] = await rows(sql`SELECT id FROM facilities WHERE slug = ${slug}`);
  if (!row) throw new Error(`no facility ${slug} — is this the database with the OSM places?`);
  return String(row.id);
}

const [organiser] = await rows(
  sql`SELECT id FROM users WHERE email = ${ORGANISER_EMAIL} AND role = 'admin'`,
);
if (!organiser)
  throw new Error(`no admin test account ${ORGANISER_EMAIL} to organise the тренировки`);
const organiserId = String(organiser.id);
await db.execute(
  sql`UPDATE users SET display_name = ${ORGANISER_NAME} WHERE id = ${organiserId} AND coalesce(display_name, '') = ''`,
);

// A place a previous run's member ADDED is retired, so this run's member can
// add theirs on the same open ground without tripping the duplicate check —
// through facility_edits, like every other change of status.
const added = await rows(sql`
  SELECT f.id FROM facilities f
   WHERE f.source = 'crowd' AND f.status <> 'gone'
     AND EXISTS (SELECT 1 FROM facility_edits e JOIN users u ON u.id = e.actor
                  WHERE e.facility_id = f.id AND e.field = 'created'
                    AND u.email LIKE 'guide-%@example.org')
`);
for (const place of added) {
  await db.transaction(async (tx) => {
    const [before] = (
      await tx.execute(sql`SELECT status FROM facilities WHERE id = ${place.id}::uuid FOR UPDATE`)
    ).rows as Row[];
    await tx.execute(sql`UPDATE facilities SET status = 'gone' WHERE id = ${place.id}::uuid`);
    await tx.execute(sql`
      INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value)
      VALUES (${place.id}::uuid, ${organiserId}, 'crowd', 'status',
              ${JSON.stringify(before?.status ?? null)}::jsonb, '"gone"'::jsonb)
    `);
  });
}

const SERIES = [
  {
    title: 'Фитнес на открито за начинаещи',
    slug: 'way-1471100748',
    sport: 'fitness',
    startsAtLocal: sofiaWall(0, { days: 1, hour: 8, minute: 0 }),
    rrule: 'FREQ=WEEKLY',
    durationMinutes: 60,
    capacity: 15,
    skillLevel: 'beginner',
  },
  {
    title: 'Футбол 5×5',
    slug: 'way-1333695684',
    sport: 'football',
    startsAtLocal: sofiaWall(0, { days: 2, hour: 18, minute: 30 }),
    rrule: 'FREQ=WEEKLY',
    durationMinutes: 90,
    capacity: 10,
    skillLevel: 'any',
  },
  {
    title: 'Тенис на маса в парка',
    slug: 'node-13307755942',
    sport: 'table_tennis',
    startsAtLocal: sofiaWall(0, { days: 3, hour: 17, minute: 30 }),
    rrule: 'FREQ=WEEKLY',
    durationMinutes: 60,
    capacity: 8,
    skillLevel: 'any',
  },
];

for (const series of SERIES) {
  const [existing] = await rows(sql`
    SELECT id FROM play_sessions
     WHERE organizer_id = ${organiserId} AND title = ${series.title} AND status <> 'cancelled'
  `);
  if (existing) continue;
  await createSession(db, organiserId, {
    facilityId: await facilityId(series.slug),
    sport: series.sport,
    title: series.title,
    startsAtLocal: series.startsAtLocal,
    rrule: series.rrule,
    durationMinutes: series.durationMinutes,
    capacity: series.capacity,
    skillLevel: series.skillLevel,
    visibility: 'public',
  });
}

// The one the recording checks in to: a fresh one-off every run, starting a
// few minutes from now, so its QR window (30 minutes before the start) is open.
for (const old of await rows(sql`
  SELECT id FROM play_sessions
   WHERE organizer_id = ${organiserId} AND title = ${NOW_TITLE} AND status <> 'cancelled'
`)) {
  await cancelSeries(db, organiserId, String(old.id));
}
const { sessionId } = await createSession(db, organiserId, {
  facilityId: await facilityId('way-449278465'),
  sport: 'basketball',
  title: NOW_TITLE,
  description: 'Отборчета по трима, на един кош. Елате 10 минути по-рано.',
  startsAtLocal: sofiaWall(10),
  durationMinutes: 90,
  capacity: 12,
  skillLevel: 'intermediate',
  visibility: 'public',
});

await materializeSessions(getPool(), {});

// A few of the local test accounts are already going, so the list shows a
// place filling up rather than an empty room.
const [occurrence] = await rows(sql`
  SELECT id FROM play_session_occurrences WHERE session_id = ${sessionId}::uuid ORDER BY starts_at LIMIT 1
`);
if (!occurrence) throw new Error('the one-off was not materialised');
const others = await rows(sql`
  SELECT id FROM users
   WHERE role = 'user' AND email LIKE '%@example.org' AND email NOT LIKE 'guide-%'
   ORDER BY created_at LIMIT 4
`);
for (const other of others) await rsvp(db, String(other.id), String(occurrence.id));

console.log(JSON.stringify({ occurrenceId: String(occurrence.id), going: others.length }));
await getPool().end();
