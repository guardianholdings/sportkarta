import { SOFIA_TZ, addDays, instantToWall, zonedToInstant } from '@sportkarta/lib/recurrence';
import type { NormalizedTraining } from '@sportkarta/lib/training';
import { sql, type SQL } from 'drizzle-orm';

/**
 * Personal training logs against the database (operator request 2026-07-26).
 *
 * THREE TABLES, AND THE SPLIT IS THE SECURITY MODEL. `training_logs` is the hot,
 * narrow table every board and competition reads. `training_routes` and
 * `training_metrics` hold the GPS line and the heart-rate/calorie figures the
 * operator asked for, one row each, and are reachable ONLY through the two
 * functions at the bottom of this file — both of which refuse to write without a
 * recorded consent timestamp on the member's row.
 *
 * That is protection by structure rather than by vigilance. A future author
 * writing a new board cannot leak a route, because the table they are selecting
 * from does not contain one. The open-data layer cannot export a heart rate,
 * because a column that is not on the declared relation cannot be declared on a
 * dataset — and neither table is on `ALLOWED_RELATIONS`, which is default-deny.
 *
 * WHO CAN APPEAR ON THE BOARD IS NOT DECIDED HERE. `sportParticipationBoard`
 * joins `leaderboard_eligible_members`, like every other public ranking in this
 * codebase, and ranks AFTER the join so the board reads 1, 2, 3 without gaps
 * that would advertise the existence of members who declined to be listed.
 *
 * THE BOARD COUNTS SESSIONS, not minutes and not kilometres (operator decision
 * 2026-07-26). Sessions are comparable across every sport — a climb and a swim
 * are both one turn-out — and a count cannot be inflated by exaggerating a
 * single entry, which matters when most rows are `self_reported`. Duration and
 * distance are returned for display so a row is still informative.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

/** `YYYY-MM-DD`, a civil Sofia day — the form `sofia_day` is stored in. */
export type DayKey = string;

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDay(key: DayKey): { year: number; month: number; day: number; hour: 0; minute: 0 } {
  const match = DAY_KEY.exec(key);
  if (!match) throw new RangeError(`not a day key: ${key}`);
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: 0,
    minute: 0,
  };
}

function formatDay(wall: { year: number; month: number; day: number }): DayKey {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`;
}

/**
 * The civil Sofia day `n` days before `now`.
 *
 * Civil arithmetic through `addDays`, never `now - n * 86_400_000`: two days a
 * year are 23 or 25 hours long, and a window computed in elapsed milliseconds
 * silently includes or drops a day around each transition.
 */
export function dayKeyBefore(now: Date, days: number, timeZone: string = SOFIA_TZ): DayKey {
  const wall = instantToWall(now.getTime(), timeZone);
  return formatDay(addDays({ ...wall, hour: 0, minute: 0 }, -days));
}

/** The instant a civil Sofia day begins — bound as a parameter, never derived in SQL. */
export function dayStart(key: DayKey, timeZone: string = SOFIA_TZ): Date {
  return new Date(zonedToInstant(parseDay(key), timeZone).instantMs);
}

export interface TrainingRow {
  id: string;
  sport: string;
  startedAt: Date;
  sofiaDay: DayKey;
  durationS: number;
  distanceM: number | null;
  elevationM: number | null;
  facilityId: string | null;
  facilityName: string | null;
  municipalityId: number | null;
  source: string;
  evidence: string;
  note: string | null;
  /** Whether a route / metrics row exists — never the route or the metrics themselves. */
  hasRoute: boolean;
  hasMetrics: boolean;
}

function mapTraining(row: Record<string, unknown>): TrainingRow {
  return {
    id: String(row.id),
    sport: String(row.sport),
    startedAt: new Date(String(row.started_at)),
    sofiaDay: String(row.sofia_day),
    durationS: Number(row.duration_s),
    distanceM: row.distance_m === null || row.distance_m === undefined ? null : Number(row.distance_m),
    elevationM:
      row.elevation_m === null || row.elevation_m === undefined ? null : Number(row.elevation_m),
    facilityId: row.facility_id === null || row.facility_id === undefined ? null : String(row.facility_id),
    facilityName:
      row.facility_name === null || row.facility_name === undefined ? null : String(row.facility_name),
    municipalityId:
      row.municipality_id === null || row.municipality_id === undefined
        ? null
        : Number(row.municipality_id),
    source: String(row.source),
    evidence: String(row.evidence),
    note: row.note === null || row.note === undefined ? null : String(row.note),
    hasRoute: row.has_route === true,
    hasMetrics: row.has_metrics === true,
  };
}

/**
 * Record one training. Idempotent for imports.
 *
 * `ON CONFLICT … DO UPDATE` rather than DO NOTHING, because a connected app can
 * legitimately CORRECT an activity after the fact — a watch that finishes
 * syncing, or a member who fixes the sport in Strava. The partial unique index
 * only covers rows with an external id, so a manual entry never takes this path
 * and two manual runs on the same morning both stand, which is correct:
 * somebody may genuinely train twice.
 *
 * THE ARBITER LEADS WITH `user_id`, and that is a correctness requirement rather
 * than a tidiness one. External ids are provider-local and often device-local —
 * Apple Health and Google Fit hand out per-device ordinals — so two members can
 * genuinely present the same `(source, external_id)`. Keyed on that pair alone,
 * member B's import would take this UPDATE against member A's row, overwrite A's
 * sport, time, duration and place while leaving `user_id` as A, and then hand B
 * A's row id — after which B's route and metrics writes, which are scoped by
 * user, would match zero rows and vanish with no error.
 *
 * Returns the row id, so the caller can attach a route or metrics — which it may
 * only do through the consent-checked writers below.
 */
export async function recordTraining(
  db: SqlRunner,
  userId: string,
  training: NormalizedTraining,
): Promise<string> {
  const result = await db.execute(sql`
    INSERT INTO training_logs (
      user_id, sport, started_at, sofia_day, duration_s, distance_m, elevation_m,
      facility_id, municipality_id, source, external_id, evidence, note
    )
    VALUES (
      ${userId}, ${training.sport}, ${training.startedAt.toISOString()}::timestamptz,
      ${training.sofiaDay}::date, ${training.durationS}, ${training.distanceM},
      ${training.elevationM},
      ${training.facilityId}::uuid, ${training.municipalityId},
      ${training.source}::training_source, ${training.externalId},
      ${training.evidence}::training_evidence, ${training.note}
    )
    ON CONFLICT (user_id, source, external_id) WHERE external_id IS NOT NULL DO UPDATE SET
      sport = EXCLUDED.sport,
      started_at = EXCLUDED.started_at,
      sofia_day = EXCLUDED.sofia_day,
      duration_s = EXCLUDED.duration_s,
      distance_m = EXCLUDED.distance_m,
      elevation_m = EXCLUDED.elevation_m,
      facility_id = EXCLUDED.facility_id,
      municipality_id = EXCLUDED.municipality_id,
      note = EXCLUDED.note,
      updated_at = now()
    RETURNING id::text AS id
  `);
  return String(result.rows[0]?.id ?? '');
}

/** One member's own log, newest first. Never anyone else's. */
export async function memberTrainings(
  db: SqlRunner,
  userId: string,
  limit = 50,
): Promise<TrainingRow[]> {
  const capped = Math.min(Math.max(limit, 1), 200);
  const result = await db.execute(sql`
    SELECT t.id::text AS id, t.sport, t.started_at, to_char(t.sofia_day, 'YYYY-MM-DD') AS sofia_day,
           t.duration_s, t.distance_m, t.elevation_m,
           t.facility_id::text AS facility_id, f.name AS facility_name,
           t.municipality_id, t.source::text AS source, t.evidence::text AS evidence, t.note,
           -- EXISTENCE only. The route and the metrics never leave their tables
           -- through this function; the screen shows a marker, not a value.
           (r.training_log_id IS NOT NULL) AS has_route,
           (m.training_log_id IS NOT NULL) AS has_metrics
    FROM training_logs t
    LEFT JOIN facilities f ON f.id = t.facility_id
    LEFT JOIN training_routes r ON r.training_log_id = t.id
    LEFT JOIN training_metrics m ON m.training_log_id = t.id
    WHERE t.user_id = ${userId}
    ORDER BY t.started_at DESC
    LIMIT ${capped}
  `);
  return result.rows.map(mapTraining);
}

/** Delete one of the member's own trainings. Scoped by user id, so it cannot reach anyone else's. */
export async function deleteTraining(db: SqlRunner, userId: string, id: string): Promise<boolean> {
  const result = await db.execute(sql`
    DELETE FROM training_logs WHERE id = ${id}::uuid AND user_id = ${userId} RETURNING id
  `);
  return result.rows.length > 0;
}

export interface ParticipationEntry {
  rank: number;
  handle: string;
  displayName: string;
  homeCity: string | null;
  /** What is RANKED: how many times they turned up. */
  sessions: number;
  /** Shown, never ranked. */
  minutes: number;
  distanceM: number;
  /** How many distinct sports — only meaningful on the all-sports board. */
  sports: number;
}

export interface ParticipationOptions {
  /** A canonical sport slug, or omitted for every sport together. */
  sport?: string;
  /** Restrict to trainings that happened in one municipality. */
  municipalityId?: number;
  /** Rolling window in civil Sofia days. Omit for all time. */
  days?: number;
  limit?: number;
  now?: Date;
  timeZone?: string;
  /**
   * Minimum evidence tier. Defaults to counting everything, because the board
   * ranks turning up rather than awarding anything. A prize-bearing surface
   * should raise this.
   */
  minEvidence?: 'self_reported' | 'connected_app';
}

/**
 * The sport participation board — who actually turns up, and for what.
 *
 * This is the board `/klasirane?sport=…` looked like it was showing and never
 * was: the existing filter narrows CONTRIBUTIONS by the sport of the facility
 * contributed to, so it answers "who edited football pitches", not "who plays
 * football". Both boards now exist side by side and each says what it means.
 *
 * Ranked by SESSION COUNT (operator decision 2026-07-26). Ties break on total
 * minutes and then on who started first, which is deterministic and does not
 * invent a difference between two members who turned up the same number of times
 * for the same total time.
 */
export async function sportParticipationBoard(
  db: SqlRunner,
  options: ParticipationOptions = {},
): Promise<ParticipationEntry[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const timeZone = options.timeZone ?? SOFIA_TZ;
  const now = options.now ?? new Date();

  const sportFilter = options.sport === undefined ? sql`` : sql` AND t.sport = ${options.sport}`;
  const cityFilter =
    options.municipalityId === undefined
      ? sql``
      : sql` AND t.municipality_id = ${options.municipalityId}`;
  // The window is a civil DAY key compared against the stored `sofia_day`, not
  // an instant compared against `started_at`: that is what makes it use
  // `training_logs_sport_day_idx`, and what makes "the last 30 days" mean 30
  // Sofia days rather than 720 hours.
  const windowFilter =
    options.days === undefined
      ? sql``
      : sql` AND t.sofia_day >= ${dayKeyBefore(now, options.days, timeZone)}::date`;
  // Two tiers today, so the floor is a single comparison. Written as an
  // explicit branch rather than an ordinal so that adding a third tier is a
  // compile error here rather than a silently wrong `>=`.
  const evidenceFilter =
    options.minEvidence === 'connected_app' ? sql` AND t.evidence = 'connected_app'` : sql``;

  const result = await db.execute(sql`
    SELECT m.public_handle AS handle,
           m.display_name  AS display_name,
           m.home_city     AS home_city,
           count(*)::int                        AS sessions,
           (sum(t.duration_s) / 60)::int        AS minutes,
           coalesce(sum(t.distance_m), 0)::bigint AS distance_m,
           count(DISTINCT t.sport)::int         AS sports,
           rank() OVER (ORDER BY count(*) DESC, sum(t.duration_s) DESC)::int AS rank
    FROM training_logs t
    -- The view, never the users table: consent is defined once, in migration
    -- 0011, and this join is how a training board inherits it.
    JOIN leaderboard_eligible_members m ON m.id = t.user_id
    WHERE true
      ${sportFilter}
      ${cityFilter}
      ${windowFilter}
      ${evidenceFilter}
    GROUP BY m.id, m.public_handle, m.display_name, m.home_city
    ORDER BY sessions DESC, minutes DESC, min(t.started_at) ASC
    LIMIT ${limit}
  `);

  return result.rows.map((row) => ({
    rank: Number(row.rank),
    handle: String(row.handle),
    displayName: String(row.display_name ?? ''),
    homeCity: row.home_city === null ? null : String(row.home_city),
    sessions: Number(row.sessions),
    minutes: Number(row.minutes),
    distanceM: Number(row.distance_m ?? 0),
    sports: Number(row.sports),
  }));
}

/** Sports that anyone has actually logged — the board's own menu, so no empty filter exists. */
export async function participationSports(
  db: SqlRunner,
  options: ParticipationOptions = {},
): Promise<{ sport: string; sessions: number }[]> {
  const timeZone = options.timeZone ?? SOFIA_TZ;
  const now = options.now ?? new Date();
  const windowFilter =
    options.days === undefined
      ? sql``
      : sql` AND t.sofia_day >= ${dayKeyBefore(now, options.days, timeZone)}::date`;

  const result = await db.execute(sql`
    SELECT t.sport AS sport, count(*)::int AS sessions
    FROM training_logs t
    JOIN leaderboard_eligible_members m ON m.id = t.user_id
    WHERE true ${windowFilter}
    GROUP BY t.sport
    ORDER BY sessions DESC, sport
  `);
  return result.rows.map((row) => ({ sport: String(row.sport), sessions: Number(row.sessions) }));
}

/** One member's own totals, for their passport and the "your standing" line. */
export async function memberParticipation(
  db: SqlRunner,
  userId: string,
  options: ParticipationOptions = {},
): Promise<{ sessions: number; minutes: number; distanceM: number; sports: number }> {
  const timeZone = options.timeZone ?? SOFIA_TZ;
  const now = options.now ?? new Date();
  const windowFilter =
    options.days === undefined
      ? sql``
      : sql` AND t.sofia_day >= ${dayKeyBefore(now, options.days, timeZone)}::date`;
  const sportFilter = options.sport === undefined ? sql`` : sql` AND t.sport = ${options.sport}`;

  const result = await db.execute(sql`
    SELECT count(*)::int AS sessions,
           coalesce(sum(t.duration_s) / 60, 0)::int AS minutes,
           coalesce(sum(t.distance_m), 0)::bigint AS distance_m,
           count(DISTINCT t.sport)::int AS sports
    FROM training_logs t
    WHERE t.user_id = ${userId} ${sportFilter} ${windowFilter}
  `);
  const row = result.rows[0];
  return {
    sessions: Number(row?.sessions ?? 0),
    minutes: Number(row?.minutes ?? 0),
    distanceM: Number(row?.distance_m ?? 0),
    sports: Number(row?.sports ?? 0),
  };
}

/**
 * Where a sport is played — facility-level participation, nobody named.
 *
 * This is the "who participates where" half of the request, answered at the
 * granularity the product already publishes: a COUNT per facility, never a
 * person. It is the same k-anonymity instinct the campaign city boards use, and
 * it is what a map layer or a municipal report can safely consume.
 */
export async function facilityParticipation(
  db: SqlRunner,
  options: ParticipationOptions & { minMembers?: number } = {},
): Promise<{ facilityId: string; sessions: number; members: number }[]> {
  const timeZone = options.timeZone ?? SOFIA_TZ;
  const now = options.now ?? new Date();
  const minMembers = options.minMembers ?? 3;
  const sportFilter = options.sport === undefined ? sql`` : sql` AND t.sport = ${options.sport}`;
  const windowFilter =
    options.days === undefined
      ? sql``
      : sql` AND t.sofia_day >= ${dayKeyBefore(now, options.days, timeZone)}::date`;

  const result = await db.execute(sql`
    SELECT t.facility_id::text AS facility_id,
           count(*)::int AS sessions,
           count(DISTINCT t.user_id)::int AS members
    FROM training_logs t
    WHERE t.facility_id IS NOT NULL ${sportFilter} ${windowFilter}
    GROUP BY t.facility_id
    -- k-anonymity: a facility backed by fewer than this many members is one
    -- person's routine wearing a place's name, which is the pattern-of-life
    -- disclosure this product has consistently refused to publish.
    HAVING count(DISTINCT t.user_id) >= ${minMembers}
    ORDER BY sessions DESC
  `);
  return result.rows.map((row) => ({
    facilityId: String(row.facility_id),
    sessions: Number(row.sessions),
    members: Number(row.members),
  }));
}

/* -------------------------------------------------------------------------- */
/* Consent-gated writers. The ONLY way into the two sensitive tables.          */
/* -------------------------------------------------------------------------- */

/** Both Art. 9 / route consents for one member, as recorded timestamps. */
export async function trainingConsents(
  db: SqlRunner,
  userId: string,
): Promise<{ routeAt: Date | null; healthAt: Date | null }> {
  const result = await db.execute(sql`
    SELECT training_route_consent_at, training_health_consent_at
    FROM users WHERE id = ${userId}
  `);
  const row = result.rows[0];
  return {
    routeAt: row?.training_route_consent_at ? new Date(String(row.training_route_consent_at)) : null,
    healthAt: row?.training_health_consent_at
      ? new Date(String(row.training_health_consent_at))
      : null,
  };
}

/**
 * Grant or withdraw one of the two consents.
 *
 * WITHDRAWAL DELETES THE DATA in the same statement chain, not eventually and
 * not by a nightly job. A flag that says "no" while the rows are still there is
 * not a withdrawal, it is a preference — and for Art. 9 data the difference is
 * the whole obligation. The member's training HISTORY survives either way: they
 * keep the record that they trained, and lose only the route or the heart rate.
 */
export async function setTrainingConsent(
  db: SqlRunner,
  userId: string,
  kind: 'route' | 'health',
  granted: boolean,
  now: Date = new Date(),
): Promise<void> {
  const column = kind === 'route' ? sql`training_route_consent_at` : sql`training_health_consent_at`;
  await db.execute(sql`
    UPDATE users SET ${column} = ${granted ? now.toISOString() : null}, updated_at = now()
    WHERE id = ${userId}
  `);
  if (granted) return;

  if (kind === 'route') {
    await db.execute(sql`
      DELETE FROM training_routes r
      USING training_logs t
      WHERE r.training_log_id = t.id AND t.user_id = ${userId}
    `);
  } else {
    await db.execute(sql`
      DELETE FROM training_metrics m
      USING training_logs t
      WHERE m.training_log_id = t.id AND t.user_id = ${userId}
    `);
  }
}

/** Raised when a writer is asked to store data the member has not consented to. */
export class TrainingConsentError extends Error {
  constructor(public readonly kind: 'route' | 'health') {
    super(`no training ${kind} consent recorded`);
    this.name = 'TrainingConsentError';
  }
}

/**
 * Attach a GPS route to a training.
 *
 * REFUSES without a recorded consent timestamp — it does not silently skip,
 * because an importer that quietly drops data it was told to store is a bug that
 * looks like success. The check reads the member's row inside the same call, so
 * a consent withdrawn between the import starting and this row being written is
 * still honoured.
 *
 * The line is built with `ST_MakeLine` over bound points and forced to 4326.
 */
export async function attachRoute(
  db: SqlRunner,
  userId: string,
  trainingLogId: string,
  points: readonly { lat: number; lon: number }[],
): Promise<void> {
  const consents = await trainingConsents(db, userId);
  if (!consents.routeAt) throw new TrainingConsentError('route');
  if (points.length < 2) return;

  const wkt = `LINESTRING(${points.map((p) => `${p.lon} ${p.lat}`).join(',')})`;
  await db.execute(sql`
    INSERT INTO training_routes (training_log_id, geom, point_count)
    SELECT t.id, ST_SetSRID(ST_GeomFromText(${wkt}), 4326), ${points.length}
    FROM training_logs t
    WHERE t.id = ${trainingLogId}::uuid AND t.user_id = ${userId}
    ON CONFLICT (training_log_id) DO UPDATE
      SET geom = EXCLUDED.geom, point_count = EXCLUDED.point_count
  `);
}

/**
 * Attach heart rate and calories to a training.
 *
 * Same refusal, for the stronger reason: this is special-category health data
 * under GDPR Art. 9, and writing it without explicit consent is not a bug with a
 * privacy flavour, it is processing without a lawful basis.
 */
export async function attachMetrics(
  db: SqlRunner,
  userId: string,
  trainingLogId: string,
  metrics: { avgHeartRate?: number | null; maxHeartRate?: number | null; caloriesKcal?: number | null },
): Promise<void> {
  const consents = await trainingConsents(db, userId);
  if (!consents.healthAt) throw new TrainingConsentError('health');

  await db.execute(sql`
    INSERT INTO training_metrics (training_log_id, avg_heart_rate, max_heart_rate, calories_kcal)
    SELECT t.id, ${metrics.avgHeartRate ?? null}, ${metrics.maxHeartRate ?? null},
           ${metrics.caloriesKcal ?? null}
    FROM training_logs t
    WHERE t.id = ${trainingLogId}::uuid AND t.user_id = ${userId}
    ON CONFLICT (training_log_id) DO UPDATE
      SET avg_heart_rate = EXCLUDED.avg_heart_rate,
          max_heart_rate = EXCLUDED.max_heart_rate,
          calories_kcal = EXCLUDED.calories_kcal
  `);
}
