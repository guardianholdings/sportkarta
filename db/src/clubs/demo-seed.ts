import type pg from 'pg';

/**
 * The demo club for prospects (Boss decision #53): ONE shared, view-only club with
 * made-up people and made-up numbers, slug `demo` and status `demo` (0064).
 *
 * Status `demo` is never public and never writable: the render rule
 * (clubRenderableSql) and the write rule (clubWritableSql) both need
 * 'active', and the worker's club sweeps select 'active' (and 'pending')
 * clubs only, so no mail, SMS, push, webhook or materializer run ever reaches
 * it. The web app shows it, read-only, through requireClubPage while
 * CLUBS_DEMO_ENABLED is on.
 *
 * seedDemoClub() rebuilds it in ONE transaction:
 *   1. the guard: no club, or exactly one club, has slug `demo` or status
 *      `demo`, and that one has both. Anything else refuses before any write;
 *   2. the three staff accounts: fixed ids, `.invalid` addresses, never
 *      verified, so nobody can sign in as them. Inserted once and then reused:
 *      a rebuild never deletes or re-creates a `users` row (only
 *      purgeDemoClub, the one-off rollback, removes them);
 *   3. the old demo's rows, reached from its club id only (every foreign key
 *      to `clubs` cascades), counted by table before the transaction commits;
 *   4. the club and its books, every date relative to the run day in
 *      Europe/Sofia, so the screens look like a club two months in.
 *
 * Nobody in it is real: adults are a first name and an initial, there is no
 * member e-mail, phone, sign-in link, session or kiosk device, and the only
 * minors are four made-up children with no data beyond that name.
 */

export const DEMO_CLUB_SLUG = 'demo';
export const DEMO_CLUB_STATUS = 'demo';
const TZ = 'Europe/Sofia';
/** One advisory lock for every writer of the demo (the CLI and the worker job). */
const LOCK_KEY = 'club.demo-refresh';

export interface DemoStaff {
  id: string;
  role: 'owner' | 'trainer';
  name: string;
  email: string;
}

/** Fixed ids: the weekly rebuild finds and reuses these rows. */
export const DEMO_STAFF: readonly DemoStaff[] = [
  { id: 'demo-club-owner', role: 'owner', name: 'Вашето име', email: 'owner@demo.invalid' },
  { id: 'demo-club-trainer-a', role: 'trainer', name: 'Петър К.', email: 'trainer-a@demo.invalid' },
  { id: 'demo-club-trainer-b', role: 'trainer', name: 'Нели Д.', email: 'trainer-b@demo.invalid' },
];
const OWNER = DEMO_STAFF[0] as DemoStaff;
const TRAINER_A = DEMO_STAFF[1] as DemoStaff;
const TRAINER_B = DEMO_STAFF[2] as DemoStaff;

export class DemoClubRefusal extends Error {
  constructor(message: string) {
    super(`demo club: refused: ${message}`);
    this.name = 'DemoClubRefusal';
  }
}

type Kind = 'monthly' | 'visits' | 'trial' | 'expired';

interface MemberSpec {
  name: string;
  kind: Kind;
  /** monthly/visits/trial: days since the current membership started; expired: days since it ended. */
  ago: number;
  prev?: boolean;
  unpaid?: 'overdue' | 'notdue' | 'partial';
}

/** 28 adults. */
const MEMBERS: readonly MemberSpec[] = [
  { name: 'Даниел Н.', kind: 'monthly', ago: 12, prev: true },
  { name: 'Мария П.', kind: 'monthly', ago: 2, prev: true, unpaid: 'notdue' },
  { name: 'Георги И.', kind: 'monthly', ago: 3, unpaid: 'notdue' },
  { name: 'Елена М.', kind: 'monthly', ago: 5, prev: true },
  { name: 'Мартин Х.', kind: 'monthly', ago: 6, prev: true },
  { name: 'Виктория А.', kind: 'monthly', ago: 8, prev: true, unpaid: 'partial' },
  { name: 'Стефан П.', kind: 'monthly', ago: 9 },
  { name: 'Габриела Т.', kind: 'monthly', ago: 11, prev: true },
  { name: 'Калоян В.', kind: 'monthly', ago: 13, prev: true, unpaid: 'overdue' },
  { name: 'Десислава И.', kind: 'monthly', ago: 14, prev: true },
  { name: 'Борислав Й.', kind: 'monthly', ago: 16 },
  { name: 'Яна Г.', kind: 'monthly', ago: 17, prev: true },
  { name: 'Христо Д.', kind: 'monthly', ago: 19, prev: true },
  { name: 'Теодора С.', kind: 'monthly', ago: 21, prev: true },
  { name: 'Деян М.', kind: 'monthly', ago: 23 },
  { name: 'Кристина К.', kind: 'monthly', ago: 26, prev: true },
  { name: 'Васил П.', kind: 'monthly', ago: 27, prev: true },
  { name: 'Михаела Н.', kind: 'monthly', ago: 28, prev: true },
  { name: 'Александър Г.', kind: 'visits', ago: 4 },
  { name: 'Радослава К.', kind: 'visits', ago: 10 },
  { name: 'Тодор А.', kind: 'visits', ago: 18 },
  { name: 'Силвия Х.', kind: 'visits', ago: 25 },
  { name: 'Николай Ц.', kind: 'visits', ago: 33 },
  { name: 'Бояна М.', kind: 'visits', ago: 40 },
  { name: 'Иван Л.', kind: 'trial', ago: 2 },
  { name: 'Анна В.', kind: 'trial', ago: 1 },
  { name: 'Росен Б.', kind: 'expired', ago: 3 },
  { name: 'Цветелина Р.', kind: 'expired', ago: 6 },
];

interface ClassSpec {
  title: string;
  sport: string;
  byday: readonly string[];
  at: string;
  minutes: number;
  capacity: number;
  trainer: DemoStaff;
  dropIn: number;
}

/** Every day has a class, so "today" is never empty whichever day it is opened. */
const CLASSES: readonly ClassSpec[] = [
  {
    title: 'Функционална тренировка',
    sport: 'functional',
    byday: ['MO', 'WE', 'FR'],
    at: '07:30',
    minutes: 60,
    capacity: 14,
    trainer: TRAINER_A,
    dropIn: 1200,
  },
  {
    title: 'Пилатес',
    sport: 'pilates',
    byday: ['MO', 'WE'],
    at: '18:00',
    minutes: 60,
    capacity: 10,
    trainer: TRAINER_B,
    dropIn: 1200,
  },
  {
    title: 'Йога',
    sport: 'yoga',
    byday: ['TU', 'TH'],
    at: '18:00',
    minutes: 75,
    capacity: 12,
    trainer: TRAINER_B,
    dropIn: 1200,
  },
  {
    title: 'Бокс за начинаещи',
    sport: 'boxing',
    byday: ['TU', 'TH'],
    at: '19:30',
    minutes: 90,
    capacity: 12,
    trainer: TRAINER_A,
    dropIn: 1500,
  },
  {
    title: 'Силова тренировка',
    sport: 'strength',
    byday: ['FR'],
    at: '18:00',
    minutes: 60,
    capacity: 12,
    trainer: TRAINER_A,
    dropIn: 1200,
  },
  {
    title: 'Стречинг',
    sport: 'stretching',
    byday: ['SA', 'SU'],
    at: '10:00',
    minutes: 60,
    capacity: 15,
    trainer: TRAINER_B,
    dropIn: 1000,
  },
  {
    title: 'TRX',
    sport: 'trx',
    byday: ['SU'],
    at: '17:30',
    minutes: 60,
    capacity: 10,
    trainer: TRAINER_A,
    dropIn: 1200,
  },
];
const DOW: Readonly<Record<string, number>> = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 };
const METHODS = [
  'cash',
  'cash',
  'cash',
  'cash',
  'cash',
  'card_desk',
  'card_desk',
  'card_desk',
  'bank',
  'bank',
] as const;

interface LeadSpec {
  name: string;
  daysAgo: number;
  source: 'inquiry' | 'social' | 'phone';
  assigned: DemoStaff;
  contacted?: number;
  next?: number;
  lost?: readonly [number, 'schedule'];
}

/** Three prospects with no membership; the two trial clients are leads too (see writeDemoClub). */
const LEADS: readonly LeadSpec[] = [
  { name: 'Йордан К.', daysAgo: 1, source: 'inquiry', assigned: OWNER, next: 0 },
  { name: 'Симона Д.', daysAgo: 4, source: 'social', assigned: TRAINER_A, contacted: 3, next: 2 },
  {
    name: 'Любомир Т.',
    daysAgo: 20,
    source: 'phone',
    assigned: OWNER,
    contacted: 19,
    lost: [12, 'schedule'],
  },
];
/** The trial clients' lead sources, in MEMBERS order. */
const TRIAL_LEAD_SOURCES = ['referral', 'social'] as const;
/** Four made-up kids: [name, MEMBERS index of the parent]. */
const KIDS: readonly (readonly [string, number])[] = [
  ['Борис М.', 3],
  ['Ема М.', 3],
  ['Мила Д.', 12],
  ['Петя С.', 13],
];
/** The open day's places: MEMBERS indexes, plus the second lead. */
const OPEN_DAY_PLACES = [1, 2, 5, 10, 14, 18, 21] as const;

/** Occurrences from this far back, so attendance and the reports have a month behind them. */
const PAST_DAYS = 29;
const HORIZON_WEEKS = 9;

/** A deterministic sequence, fresh for every run, so two runs on one day write the same books. */
function sequence(start: number): () => number {
  let seed = start;
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DemoGuardState {
  /** The existing demo club's id, or null when there is none yet. */
  clubId: string | null;
}

/**
 * The guard every writer runs first, inside its transaction: refuses unless
 * no club, or exactly one club, has slug `demo` or status `demo`, and that one
 * has both. Locks the row it finds. Prints nothing about any club.
 */
export async function demoClubGuard(client: pg.ClientBase): Promise<DemoGuardState> {
  const found = await client.query<{ id: string; slug: string; status: string }>(
    `SELECT id, slug, status FROM clubs WHERE slug = $1 OR status = $2 ORDER BY id FOR UPDATE`,
    [DEMO_CLUB_SLUG, DEMO_CLUB_STATUS],
  );
  if (found.rows.length === 0) return { clubId: null };
  const [only] = found.rows;
  if (found.rows.length > 1 || !only) {
    throw new DemoClubRefusal(`${String(found.rows.length)} clubs have the demo slug or status`);
  }
  if (only.slug !== DEMO_CLUB_SLUG || only.status !== DEMO_CLUB_STATUS) {
    throw new DemoClubRefusal('the club with the demo slug or status is not the demo club');
  }
  return { clubId: only.id };
}

/** Exact row counts of every base table in the public schema, by table name. */
export async function countRowsByTable(client: pg.ClientBase): Promise<Map<string, number>> {
  const tables = await client.query<{ name: string }>(
    `SELECT c.relname AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
      ORDER BY c.relname`,
  );
  const counts = new Map<string, number>();
  for (const { name } of tables.rows) {
    const quoted = `"${name.replaceAll('"', '""')}"`;
    const row = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.${quoted}`,
    );
    counts.set(name, Number(row.rows[0]?.n ?? '0'));
  }
  return counts;
}

/** Per table, how many rows `after` has fewer (or more, negative) than `before`; zeros left out. */
export function rowCountChanges(
  before: Map<string, number>,
  after: Map<string, number>,
): Map<string, number> {
  const changes = new Map<string, number>();
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const delta = (before.get(name) ?? 0) - (after.get(name) ?? 0);
    if (delta !== 0) changes.set(name, delta);
  }
  return changes;
}

function toRecord(map: Map<string, number>, sign = 1): Record<string, number> {
  return Object.fromEntries(
    [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v * sign]),
  );
}

/**
 * The three staff accounts: inserted once with their fixed ids, then reused.
 * Refuses when an id belongs to an account that isn't the demo's (another
 * address, a verified address, a role, a session or a sign-in method), so a
 * rebuild never touches a real account. Returns how many rows it inserted.
 */
async function ensureDemoStaff(client: pg.ClientBase): Promise<number> {
  let inserted = 0;
  for (const staff of DEMO_STAFF) {
    const result = await client.query(
      `INSERT INTO users (id, display_name, email, email_verified) VALUES ($1, $2, $3, false)
       ON CONFLICT (id) DO NOTHING`,
      [staff.id, staff.name, staff.email],
    );
    inserted += result.rowCount ?? 0;
  }
  await checkDemoStaff(client);
  return inserted;
}

/** Refuses unless each staff id is the demo's own account, as ensureDemoStaff describes. */
async function checkDemoStaff(client: pg.ClientBase): Promise<void> {
  const ids = DEMO_STAFF.map((staff) => staff.id);
  const rows = await client.query<{
    id: string;
    email: string;
    email_verified: boolean;
    role: string;
  }>(
    `SELECT id, email, email_verified, role::text AS role FROM users WHERE id = ANY($1::text[]) FOR UPDATE`,
    [ids],
  );
  for (const staff of DEMO_STAFF) {
    const row = rows.rows.find((r) => r.id === staff.id);
    if (!row || row.email !== staff.email || row.email_verified || row.role !== 'user') {
      throw new DemoClubRefusal(
        "a demo staff id belongs to an account that is not the demo club's",
      );
    }
  }
  const signIns = await client.query<{ n: string }>(
    `SELECT ((SELECT count(*) FROM sessions WHERE user_id = ANY($1::text[]))
           + (SELECT count(*) FROM accounts WHERE user_id = ANY($1::text[])))::text AS n`,
    [ids],
  );
  if (Number(signIns.rows[0]?.n ?? '0') !== 0) {
    throw new DemoClubRefusal('a demo staff account has a session or a sign-in method');
  }
}

/**
 * Deletes the demo club's row, and with it (every foreign key to `clubs`
 * cascades) every row reached from its id. The club tables' delete guards
 * refuse unless the transaction names the club first (pops.purging_club).
 */
async function deleteDemoClubRow(client: pg.ClientBase, clubId: string): Promise<void> {
  await client.query(`SELECT set_config('pops.purging_club', $1, true)`, [clubId]);
  const deleted = await client.query(
    `DELETE FROM clubs WHERE id = $1 AND slug = $2 AND status = $3`,
    [clubId, DEMO_CLUB_SLUG, DEMO_CLUB_STATUS],
  );
  if (deleted.rowCount !== 1) throw new DemoClubRefusal('the demo club row was not deleted');
  await client.query(`SELECT set_config('pops.purging_club', '', true)`);
}

export interface DemoSeedReport {
  /** The run day in Europe/Sofia, which every date is relative to. */
  today: string;
  /** Staff accounts inserted by this run (3 on the first run, then 0). */
  staffInserted: number;
  /** Rows the old demo had, by table: what the rebuild removed (empty on the first run). */
  removed: Record<string, number>;
  /** Rows the new demo has, by table. */
  written: Record<string, number>;
}

export interface DemoSeedOptions {
  /** Sees the report after every write and before COMMIT; throwing rolls the run back. */
  beforeCommit?: (report: DemoSeedReport) => void | Promise<void>;
}

/**
 * Rebuilds the demo club in one transaction (see the header). Refuses, with
 * nothing written, unless the guard passes; never deletes a `users` row.
 */
export async function seedDemoClub(
  pool: pg.Pool,
  options: DemoSeedOptions = {},
): Promise<DemoSeedReport> {
  const client = await pool.connect();
  try {
    // One snapshot for every count (and the users check): rows other sessions commit meanwhile are not ours.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [LOCK_KEY]);
    const guard = await demoClubGuard(client);
    const staffInserted = await ensureDemoStaff(client);
    const atStart = await countRowsByTable(client);
    if (guard.clubId) await deleteDemoClubRow(client, guard.clubId);
    const afterPurge = await countRowsByTable(client);
    const today = await writeDemoClub(client);
    const atEnd = await countRowsByTable(client);
    const report: DemoSeedReport = {
      today,
      staffInserted,
      removed: toRecord(rowCountChanges(atStart, afterPurge)),
      written: toRecord(rowCountChanges(afterPurge, atEnd), -1),
    };
    if ('users' in report.removed || 'users' in report.written) {
      throw new DemoClubRefusal('the rebuild changed the users table');
    }
    await options.beforeCommit?.(report);
    await client.query('COMMIT');
    return report;
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface DemoPurgeReport {
  /** Rows the purge removed, by table: the club's rows and the three staff accounts. */
  removed: Record<string, number>;
}

export interface DemoPurgeOptions {
  /** Sees the report before COMMIT; throwing rolls the purge back. */
  beforeCommit?: (report: DemoPurgeReport) => void | Promise<void>;
}

/**
 * The rollback purge, and the only path that deletes `users` rows: the demo
 * club with every row reached from its id, then its three staff accounts.
 * Refuses, with nothing removed, unless exactly one club has both the demo
 * slug and status, and each staff id is still the demo's own account.
 */
export async function purgeDemoClub(
  pool: pg.Pool,
  options: DemoPurgeOptions = {},
): Promise<DemoPurgeReport> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [LOCK_KEY]);
    const guard = await demoClubGuard(client);
    if (!guard.clubId) throw new DemoClubRefusal('there is no demo club to purge');
    await checkDemoStaff(client);
    const atStart = await countRowsByTable(client);
    await deleteDemoClubRow(client, guard.clubId);
    const staff = await client.query(
      `DELETE FROM users WHERE id = ANY($1::text[]) AND email = ANY($2::text[]) AND NOT email_verified`,
      [DEMO_STAFF.map((s) => s.id), DEMO_STAFF.map((s) => s.email)],
    );
    if (staff.rowCount !== DEMO_STAFF.length)
      throw new DemoClubRefusal('the demo staff accounts were not all deleted');
    const report: DemoPurgeReport = {
      removed: toRecord(rowCountChanges(atStart, await countRowsByTable(client))),
    };
    if (Object.values(report.removed).some((n) => n < 0))
      throw new DemoClubRefusal('the purge added rows');
    await options.beforeCommit?.(report);
    await client.query('COMMIT');
    return report;
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** The club and its books; returns the run day. Runs inside seedDemoClub's transaction. */
async function writeDemoClub(client: pg.ClientBase): Promise<string> {
  const rand = sequence(20261101);
  const today =
    (await client.query<{ d: string }>(`SELECT (now() AT TIME ZONE '${TZ}')::date::text AS d`))
      .rows[0]?.d ?? '';

  // Published, with two months of books, so the dashboard's checklist and working day read as a real
  // club's would. Status `demo` keeps it off every public page all the same.
  const club = await client.query<{ id: string }>(
    `INSERT INTO clubs (slug, name_bg, name_en, kind, tier, status, visible, description_bg, sports, locale,
                        applied_at, approved_at, paid_until, accent)
     VALUES ($1, 'Демо клуб', 'Demo club', 'gym', 'pro', $2, true,
             'Квартална зала с групови тренировки сутрин и вечер.',
             ARRAY['functional','strength','trx','yoga','pilates','stretching','boxing'], 'bg',
             now() - interval '62 days', now() - interval '60 days', current_date + 365, 'green')
     RETURNING id`,
    [DEMO_CLUB_SLUG, DEMO_CLUB_STATUS],
  );
  const clubId = club.rows[0]?.id ?? '';
  const location = await client.query<{ id: string }>(
    `INSERT INTO club_locations (club_id, name, address) VALUES ($1, 'Основна зала', 'ул. Примерна 12, София')
     RETURNING id`,
    [clubId],
  );
  const locationId = location.rows[0]?.id ?? '';
  await client.query(
    `INSERT INTO club_staff (club_id, user_id, role, display_name, created_at) VALUES
       ($1, $2, 'owner', $3, now() - interval '60 days'),
       ($1, $4, 'trainer', $5, now() - interval '58 days'),
       ($1, $6, 'trainer', $7, now() - interval '58 days')`,
    [clubId, OWNER.id, OWNER.name, TRAINER_A.id, TRAINER_A.name, TRAINER_B.id, TRAINER_B.name],
  );

  const plan = async (
    nameBg: string,
    nameEn: string,
    kind: string,
    cents: number,
    sizes: readonly (number | null)[],
    order: number,
  ) =>
    (
      await client.query<{ id: string }>(
        `INSERT INTO club_plans (club_id, name_bg, name_en, kind, price_cents, validity_months, validity_days,
                                 visits_count, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          clubId,
          nameBg,
          nameEn,
          kind,
          cents,
          sizes[0] ?? null,
          sizes[1] ?? null,
          sizes[2] ?? null,
          order,
        ],
      )
    ).rows[0]?.id ?? '';
  // sizes: [validity months, validity days, visits]
  const monthlyPlan = await plan(
    'Месечен абонамент',
    'Monthly membership',
    'unlimited',
    4500,
    [1, null, null],
    1,
  );
  const visitsPlan = await plan(
    'Карта 10 посещения',
    '10-visit card',
    'visits',
    6000,
    [2, null, 10],
    2,
  );
  const trialPlan = await plan('Пробна тренировка', 'Trial class', 'trial', 0, [null, 7, 1], 3);

  // Members: a first name and an initial only; no e-mail, no phone, no sign-in link.
  const memberIds: string[] = [];
  for (const [index, spec] of MEMBERS.entries()) {
    const member = await client.query<{ id: string }>(
      `INSERT INTO club_members (club_id, display_name, source, created_at)
       VALUES ($1, $2, 'staff', now() - make_interval(days => $3::int))
       RETURNING id`,
      [clubId, spec.name, spec.ago + (spec.prev ? 32 : 2)],
    );
    const memberId = member.rows[0]?.id ?? '';
    memberIds.push(memberId);

    // Windows as [starts_on, ends_on] SQL over the run day ($4 below), from the constants above only.
    const ago = String(spec.ago);
    const windows: { planId: string; starts: string; ends: string; current: boolean }[] = [];
    if (spec.kind === 'monthly') {
      const start = `($4::date - ${ago})`;
      windows.push({
        planId: monthlyPlan,
        starts: start,
        ends: `((${start} + interval '1 month')::date - 1)`,
        current: true,
      });
      if (spec.prev) {
        windows.unshift({
          planId: monthlyPlan,
          starts: `((${start} - interval '1 month')::date)`,
          ends: `(${start} - 1)`,
          current: false,
        });
      }
    } else if (spec.kind === 'expired') {
      const end = `($4::date - ${ago})`;
      windows.push({
        planId: monthlyPlan,
        starts: `(((${end} + 1) - interval '1 month')::date)`,
        ends: end,
        current: false,
      });
    } else if (spec.kind === 'visits') {
      const start = `($4::date - ${ago})`;
      windows.push({
        planId: visitsPlan,
        starts: start,
        ends: `((${start} + interval '2 months')::date - 1)`,
        current: true,
      });
    } else {
      const start = `($4::date - ${ago})`;
      windows.push({ planId: trialPlan, starts: start, ends: `(${start} + 6)`, current: true });
    }

    for (const w of windows) {
      const ms = await client.query<{ id: string; price: number; starts: string }>(
        `INSERT INTO club_memberships (club_id, member_id, plan_id, plan_name, kind, audience, price_cents, visits_total,
                                       starts_on, ends_on, sold_by, created_at)
         SELECT p.club_id, $2, p.id, p.name_bg, p.kind, p.audience, p.price_cents, p.visits_count,
                ${w.starts}, ${w.ends}, $5, (${w.starts} + time '09:00') AT TIME ZONE '${TZ}'
           FROM club_plans p WHERE p.club_id = $1 AND p.id = $3
         RETURNING id, price_cents AS price, starts_on::text AS starts`,
        [clubId, memberId, w.planId, today, OWNER.id],
      );
      const row = ms.rows[0];
      if (!row) throw new Error('demo club: a membership insert returned nothing');
      if (row.price <= 0) continue;
      const charge = await client.query<{ id: string }>(
        `INSERT INTO club_charges (club_id, member_id, membership_id, kind, label, amount_cents, issued_on, due_on,
                                   created_by, created_at)
         SELECT m.club_id, m.member_id, m.id, 'membership', m.plan_name, m.price_cents, m.starts_on, m.starts_on + 7,
                $2, (m.starts_on + time '09:05') AT TIME ZONE '${TZ}'
           FROM club_memberships m WHERE m.id = $1
         RETURNING id`,
        [row.id, OWNER.id],
      );
      const chargeId = charge.rows[0]?.id ?? '';
      const unpaid = w.current ? spec.unpaid : undefined;
      if (unpaid === 'overdue' || unpaid === 'notdue') continue;
      await client.query(
        `INSERT INTO club_payments (club_id, charge_id, member_id, kind, amount_cents, method, received_on,
                                    recorded_by, recorded_at)
         SELECT $1, $2, $3, 'payment', $4, $5, d, $6,
                least(now(), (d + make_interval(hours => 9, mins => $7::int)) AT TIME ZONE '${TZ}')
           FROM (SELECT least($8::date + $9::int, $10::date) AS d) x`,
        [
          clubId,
          chargeId,
          memberId,
          unpaid === 'partial' ? 2000 : row.price,
          METHODS[index % METHODS.length],
          OWNER.id,
          Math.floor(rand() * 600),
          row.starts,
          Math.floor(rand() * 3),
          today,
        ],
      );
    }
  }

  // Classes: weekly series whose first date is the first matching weekday four weeks back.
  const monday =
    (
      await client.query<{ d: string }>(
        `SELECT (date_trunc('week', $1::date)::date - 28)::text AS d`,
        [today],
      )
    ).rows[0]?.d ?? '';
  const classIds: { id: string; spec: ClassSpec }[] = [];
  for (const k of CLASSES) {
    const first = Math.min(...k.byday.map((d) => DOW[d] ?? 0));
    const created = await client.query<{ id: string }>(
      `INSERT INTO club_classes (club_id, location_id, title, sport, instructor_user_id, starts_at_local, rrule,
                                 duration_minutes, capacity, drop_in_price_cents, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, ($6::date + $7::int) + $8::time, $9, $10, $11, $12, $13, now() - interval '35 days')
       RETURNING id`,
      [
        clubId,
        locationId,
        k.title,
        k.sport,
        k.trainer.id,
        monday,
        first,
        k.at,
        `FREQ=WEEKLY;BYDAY=${k.byday.join(',')}`,
        k.minutes,
        k.capacity,
        k.dropIn,
        OWNER.id,
      ],
    );
    classIds.push({ id: created.rows[0]?.id ?? '', spec: k });
  }

  // Occurrences, written here in this transaction: the materializer sweeps only active and pending clubs.
  // From PAST_DAYS back (never before the series' first week) to HORIZON_WEEKS ahead; no class is set in
  // the hour the clocks skip, so every local time is exact.
  for (const c of classIds) {
    await client.query(
      `INSERT INTO club_class_occurrences (club_id, class_id, starts_at, ends_at, starts_at_local, dst_resolution,
                                           created_at)
       SELECT $1, $2, (x.d + $3::time) AT TIME ZONE '${TZ}',
              ((x.d + $3::time) AT TIME ZONE '${TZ}') + make_interval(mins => $4::int),
              x.d + $3::time, 'exact', now() - interval '35 days'
         FROM (SELECT t::date AS d
                 FROM generate_series(greatest($5::date, $6::date - $7::int)::timestamp,
                                      ($6::date + $8::int * 7)::timestamp, interval '1 day') AS t) x
        WHERE extract(isodow FROM x.d)::int - 1 = ANY($9::int[])
        ORDER BY x.d`,
      [
        clubId,
        c.id,
        c.spec.at,
        c.spec.minutes,
        monday,
        today,
        PAST_DAYS,
        HORIZON_WEEKS,
        c.spec.byday.map((day) => DOW[day] ?? 0),
      ],
    );
  }

  // Attendance. A class that has started takes no booking (0042's trigger refuses it), so the past is
  // check-ins and the next seven days are places booked at the desk (booked_by set). A visit card and the
  // trial stop at their visit count; the first boxing class ahead is booked two over, so it has a waitlist.
  const held = (
    await client.query<{
      id: string;
      member: string;
      total: number | null;
      starts: string;
      ends: string;
    }>(
      `SELECT id, member_id AS member, visits_total AS total, starts_on::text AS starts, ends_on::text AS ends
         FROM club_memberships WHERE club_id = $1 AND cancelled_at IS NULL
        ORDER BY starts_on, array_position($2::uuid[], member_id), ends_on, visits_total NULLS FIRST, plan_name`,
      // Ordered by the seed's own member order, never by the random ids, so a refresh draws the same rows.
      [clubId, memberIds],
    )
  ).rows;
  const used = new Map<string, number>();
  const coverFor = (day: string): [string, string][] => {
    const byMember = new Map<string, string>();
    for (const m of held) {
      if (m.starts > day || m.ends < day) continue;
      if (m.total !== null && (used.get(m.id) ?? 0) >= m.total) continue;
      byMember.set(m.member, m.id);
    }
    return [...byMember.entries()];
  };
  function shuffled<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      const a = out[i] as T;
      out[i] = out[j] as T;
      out[j] = a;
    }
    return out;
  }
  const classById = new Map(classIds.map((c) => [c.id, c.spec] as const));
  const ahead = (
    await client.query<{ id: string; klass: string; day: string; starts: string; past: boolean }>(
      `SELECT id, class_id AS klass, (starts_at AT TIME ZONE '${TZ}')::date::text AS day, starts_at::text AS starts,
              starts_at < now() AS past
         FROM club_class_occurrences
        WHERE club_id = $1 AND starts_at < now() + interval '7 days'
        ORDER BY starts_at, array_position($2::uuid[], class_id)`,
      [clubId, classIds.map((c) => c.id)],
    )
  ).rows;
  let waitlistDone = false;
  for (const o of ahead) {
    const spec = classById.get(o.klass);
    if (!spec) continue;
    const pool = shuffled(coverFor(o.day));
    if (o.past) {
      const chosen = pool.slice(
        0,
        Math.min(pool.length, Math.round(spec.capacity * (0.45 + rand() * 0.4))),
      );
      if (chosen.length === 0) continue;
      const methods = chosen.map(() => {
        const r = rand();
        return r < 0.55 ? 'qr_kiosk' : r < 0.85 ? 'qr_member' : 'desk';
      });
      await client.query(
        `INSERT INTO club_checkins (club_id, member_id, occurrence_id, location_id, method, recorded_by,
                                    consumed_membership_id, covered, sofia_day, checked_in_at)
         SELECT $1, x.member, $2, $3, x.method, CASE WHEN x.method = 'qr_kiosk' THEN NULL ELSE $4 END,
                x.membership, true, $5::date, $6::timestamptz - make_interval(mins => x.early)
           FROM unnest($7::uuid[], $8::text[], $9::uuid[], $10::int[]) AS x(member, method, membership, early)`,
        [
          clubId,
          o.id,
          locationId,
          spec.trainer.id,
          o.day,
          o.starts,
          chosen.map(([m]) => m),
          methods,
          chosen.map(([, ms]) => ms),
          chosen.map(() => 2 + Math.floor(rand() * 13)),
        ],
      );
      for (const [, ms] of chosen) used.set(ms, (used.get(ms) ?? 0) + 1);
      continue;
    }
    const over = spec.sport === 'boxing' && !waitlistDone;
    if (over) waitlistDone = true;
    const want = over ? spec.capacity + 2 : Math.round(spec.capacity * (0.35 + rand() * 0.45));
    const chosen = pool.slice(0, Math.min(pool.length, want));
    if (chosen.length === 0) continue;
    // One row at a time, so each draws its ticket (seq) in this order and the last two are the waitlist.
    for (const [index, [member]] of chosen.entries()) {
      await client.query(
        `INSERT INTO club_bookings (club_id, occurrence_id, member_id, booked_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, now() - make_interval(hours => $5::int), now() - make_interval(hours => $5::int))`,
        [clubId, o.id, member, OWNER.id, 40 - index],
      );
    }
  }

  // Belts: one boxing ladder of 6 ranks from the closed palette (0056 numbers them) and 12 awards, all dated
  // in the past: 8 first belts and 1 orange brought from another club, recorded on the day the client joined,
  // and 3 yellow belts by exam, each over a month after the first belt, as the rank asks.
  const ladderId =
    (
      await client.query<{ id: string }>(
        `INSERT INTO club_rank_ladders (club_id, name_bg, name_en, sport, created_by, created_at)
         VALUES ($1, 'Пояси по бокс', 'Boxing belts', 'boxing', $2, now() - interval '55 days') RETURNING id`,
        [clubId, OWNER.id],
      )
    ).rows[0]?.id ?? '';
  // [name_bg, name_en, colour, check-ins asked, months at the rank before]
  const BELTS: readonly [string, string, string, number | null, number | null][] = [
    ['Бял пояс', 'White belt', 'white', null, null],
    ['Жълт пояс', 'Yellow belt', 'yellow', 12, 1],
    ['Оранжев пояс', 'Orange belt', 'orange', 24, 2],
    ['Зелен пояс', 'Green belt', 'green', 36, 3],
    ['Син пояс', 'Blue belt', 'blue', 60, 6],
    ['Черен пояс', 'Black belt', 'black', 120, 12],
  ];
  const rankIds: string[] = [];
  for (const [nameBg, nameEn, colour, attendances, months] of BELTS) {
    const rank = await client.query<{ id: string }>(
      `INSERT INTO club_ranks (club_id, ladder_id, name_bg, name_en, colour, min_attendances, min_months, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() - interval '55 days') RETURNING id`,
      [clubId, ladderId, nameBg, nameEn, colour, attendances, months],
    );
    rankIds.push(rank.rows[0]?.id ?? '');
  }
  // [MEMBERS index, BELTS index, reason, days ago (null: the day the client joined)]
  const AWARDS: readonly [number, number, 'prior' | 'exam', number | null][] = [
    [0, 0, 'prior', null],
    [3, 0, 'prior', null],
    [4, 0, 'prior', null],
    [7, 0, 'prior', null],
    [8, 0, 'prior', null],
    [9, 0, 'prior', null],
    [12, 0, 'prior', null],
    [13, 0, 'prior', null],
    [11, 2, 'prior', null],
    [12, 1, 'exam', 14],
    [0, 1, 'exam', 10],
    [7, 1, 'exam', 8],
  ];
  for (const [member, rank, reason, daysAgo] of AWARDS) {
    await client.query(
      `INSERT INTO club_member_ranks (club_id, ladder_id, rank_id, member_id, awarded_on, reason, awarded_by)
       SELECT m.club_id, $2, $3, m.id,
              CASE WHEN $5::int IS NULL THEN (m.created_at AT TIME ZONE '${TZ}')::date ELSE $4::date - $5::int END,
              $6, $7
         FROM club_members m WHERE m.club_id = $1 AND m.id = $8`,
      [clubId, ladderId, rankIds[rank], today, daysAgo, reason, TRAINER_A.id, memberIds[member]],
    );
  }

  // Leads (0052): the stage is derived from the books (club_lead_stages), so three prospects with no
  // membership sit at new, contacted and lost, and the two trial clients, leads from the day their record
  // was made, read trial_booked, or visited once a check-in falls after that.
  const leadIds: string[] = [];
  for (const lead of LEADS) {
    const row = await client.query<{ id: string }>(
      `INSERT INTO club_members (club_id, display_name, source, created_at, lead_opened_at, lead_source,
                                 lead_contacted_at, lead_next_action_on, lead_assigned_to, lead_lost_at, lead_lost_reason)
       VALUES ($1, $2, 'staff', now() - make_interval(days => $3::int), now() - make_interval(days => $3::int), $4,
               CASE WHEN $5::int IS NULL THEN NULL ELSE now() - make_interval(days => $5::int) END,
               CASE WHEN $6::int IS NULL THEN NULL ELSE $7::date + $6::int END,
               $8,
               CASE WHEN $9::int IS NULL THEN NULL ELSE now() - make_interval(days => $9::int) END,
               $10)
       RETURNING id`,
      [
        clubId,
        lead.name,
        lead.daysAgo,
        lead.source,
        lead.contacted ?? null,
        lead.next ?? null,
        today,
        lead.assigned.id,
        lead.lost?.[0] ?? null,
        lead.lost?.[1] ?? null,
      ],
    );
    leadIds.push(row.rows[0]?.id ?? '');
  }
  const trialIndexes = MEMBERS.flatMap((spec, index) => (spec.kind === 'trial' ? [index] : []));
  for (const [n, index] of trialIndexes.entries()) {
    await client.query(
      `UPDATE club_members
          SET lead_opened_at = created_at, lead_source = $3, lead_contacted_at = created_at + interval '2 hours',
              lead_assigned_to = $4
        WHERE club_id = $1 AND id = $2`,
      [clubId, memberIds[index], TRIAL_LEAD_SOURCES[n] ?? 'other', TRAINER_A.id],
    );
  }

  // Four made-up kids under three made-up parents: a first name and an initial and nothing else (the
  // schema keeps no date of birth); only a minor's record may name a guardian.
  for (const [name, parent] of KIDS) {
    await client.query(
      `INSERT INTO club_members (club_id, display_name, source, is_minor, guardian_member_id, created_at)
       SELECT p.club_id, $3::text, 'staff', true, p.id, p.created_at + interval '10 minutes'
         FROM club_members p WHERE p.club_id = $1 AND p.id = $2`,
      [clubId, memberIds[parent], name],
    );
  }

  // The open training day: Saturday of next week (6 to 12 days ahead), published, one ticket at no
  // charge and 8 places taken at the desk, so it writes no charge row; it holds no room (no resource),
  // so 0053's closure trigger writes no time block.
  const event = await client.query<{ id: string }>(
    `INSERT INTO club_events (club_id, kind, title_bg, title_en, description_bg, description_en, location_id,
                              starts_at, ends_at, capacity, payment, cancel_deadline_hours, public, status,
                              created_by, created_at)
     SELECT $1::uuid, 'event', $2::text, $3::text, $4::text, $5::text, $6::uuid,
            (x.d + time '11:30') AT TIME ZONE '${TZ}', (x.d + time '13:30') AT TIME ZONE '${TZ}',
            20, 'desk', 24, true, 'published', $7::text, now() - interval '9 days'
       FROM (SELECT date_trunc('week', $8::date)::date + 12 AS d) x
     RETURNING id`,
    [
      clubId,
      'Ден на отворените врати',
      'Open day',
      'Пробвайте бокс, функционална тренировка и стречинг с треньорите на клуба. Ръкавици и бинтове осигуряваме ние.',
      "Try boxing, functional training and stretching with the club's coaches. Gloves and wraps are on us.",
      locationId,
      OWNER.id,
      today,
    ],
  );
  const eventId = event.rows[0]?.id ?? '';
  const ticket = await client.query<{ id: string }>(
    `INSERT INTO club_event_tickets (club_id, event_id, name_bg, name_en, price_cents, audience, sort_order, created_at)
     VALUES ($1, $2, 'Вход свободен', 'Free entry', 0, 'all', 0, now() - interval '9 days')
     RETURNING id`,
    [clubId, eventId],
  );
  const ticketId = ticket.rows[0]?.id ?? '';
  // The seat trigger draws the arrival number and stamps the times; a confirmed place at no charge needs no hold.
  const places = [...OPEN_DAY_PLACES.map((index) => memberIds[index] ?? ''), leadIds[1] ?? ''];
  for (const memberId of places) {
    await client.query(
      `INSERT INTO club_event_registrations (club_id, event_id, ticket_id, member_id, state, price_cents,
                                             cancel_deadline_hours, booked_by)
       VALUES ($1, $2, $3, $4, 'confirmed', 0, 24, $5)`,
      [clubId, eventId, ticketId, memberId, OWNER.id],
    );
  }
  return today;
}
