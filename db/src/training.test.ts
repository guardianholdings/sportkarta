import { ALLOWED_RELATIONS, EXPORT_DATASETS } from '@sportkarta/lib/opendata';
import { normalizeTraining, type TrainingInput } from '@sportkarta/lib/training';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  attachMetrics,
  attachRoute,
  deleteTraining,
  memberTrainings,
  recordTraining,
  setTrainingConsent,
  sportParticipationBoard,
  trainingConsents,
  TrainingConsentError,
} from './training.js';

/**
 * Training logs against real Postgres.
 *
 * Five properties, each of which is either a legal obligation or a rule that
 * would be quietly "simplified" away:
 *
 *  1. CONSENT GATES THE SENSITIVE TABLES, and the gate THROWS rather than
 *     skipping. An importer that silently drops data it was told to store is a
 *     bug that looks like success.
 *  2. WITHDRAWAL DELETES. A flag saying "no" while the rows are still there is a
 *     preference, not a withdrawal — and for GDPR Art. 9 data that difference is
 *     the entire obligation.
 *  3. THE EVIDENCE CHECK IS REAL. A manual row cannot claim `connected_app`, so
 *     a future importer cannot promote itself by passing a nicer string.
 *  4. IMPORTS ARE IDEMPOTENT. Re-syncing a watch must not double a member's
 *     history and every board they appear on.
 *  5. THE BOARD OBEYS CONSENT. An unpublished member is not named, and the ranks
 *     close up behind them.
 *
 * Integration test; skips without DATABASE_URL.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

interface Runner {
  execute(query: { queryChunks?: unknown }): Promise<{ rows: Record<string, unknown>[] }>;
}

const A = 'e2e_trn_a';
const B = 'e2e_trn_b';
const C = 'e2e_trn_c';

/** A far-future day, so ambient dev data cannot reach the windowed assertions. */
const WHEN = new Date('2028-05-10T07:00:00Z');

describe.skipIf(!hasDb)('training logs (requires running database)', () => {
  let client: pg.Client;
  let db: Runner;

  const handleFor = (n: number) => `cafecafecafecafe${String(n).padStart(8, '0')}`;

  async function member(id: string, n: number, visible = true): Promise<void> {
    await client.query(
      `INSERT INTO users (id, display_name, email, email_verified, public_handle, profile_visibility)
       VALUES ($1, $2, $3, true, $4, $5)
       ON CONFLICT (id) DO UPDATE SET public_handle = EXCLUDED.public_handle,
                                      profile_visibility = EXCLUDED.profile_visibility`,
      [id, `Trn ${String(n)}`, `${id}@example.test`, visible ? handleFor(n) : null,
       visible ? 'public' : 'private'],
    );
  }

  const training = (over: Partial<TrainingInput> = {}) => {
    const result = normalizeTraining(
      { sport: 'running', startedAt: WHEN, durationS: 40 * 60, ...over },
      new Date('2028-05-11T00:00:00Z'),
    );
    if (!result.ok) throw new Error(`fixture invalid: ${result.problems.join(',')}`);
    return result.value;
  };

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const { drizzle } = await import('drizzle-orm/node-postgres');
    db = drizzle(client) as unknown as Runner;
  });

  afterAll(async () => {
    await cleanup();
    await client.end();
  });

  async function cleanup(): Promise<void> {
    // training_logs cascades to routes and metrics; users cascades to logs.
    await client.query(`DELETE FROM users WHERE id LIKE 'e2e_trn_%'`);
  }

  beforeEach(async () => {
    await cleanup();
    await member(A, 1);
    await member(B, 2);
    await member(C, 3, false);
  });

  it('records a manual training and reads it back', async () => {
    const id = await recordTraining(db, A, training());
    expect(id).not.toBe('');

    const rows = await memberTrainings(db, A);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sport).toBe('running');
    expect(rows[0]?.sofiaDay).toBe('2028-05-10');
    expect(rows[0]?.evidence).toBe('self_reported');
    expect(rows[0]?.hasRoute).toBe(false);
    expect(rows[0]?.hasMetrics).toBe(false);
  });

  it('never returns another member’s trainings', async () => {
    await recordTraining(db, A, training());
    expect(await memberTrainings(db, B)).toHaveLength(0);
  });

  it('deletes only the owner’s own row', async () => {
    const id = await recordTraining(db, A, training());
    expect(await deleteTraining(db, B, id)).toBe(false);
    expect(await deleteTraining(db, A, id)).toBe(true);
  });

  /**
   * IMPORT IDEMPOTENCY. Without the partial unique index a member who reconnects
   * their watch doubles their entire history and every board they appear on.
   */
  it('re-syncing the same external activity updates rather than duplicates', async () => {
    const first = await recordTraining(
      db,
      A,
      training({ source: 'strava', externalId: 'act-1' }),
    );
    const second = await recordTraining(
      db,
      A,
      training({ source: 'strava', externalId: 'act-1', durationS: 55 * 60 }),
    );
    expect(second).toBe(first);

    const rows = await memberTrainings(db, A);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.durationS).toBe(55 * 60);
    expect(rows[0]?.evidence).toBe('connected_app');
  });

  /**
   * THE CROSS-ACCOUNT CORRUPTION THIS ALMOST SHIPPED WITH.
   *
   * The dedupe key was first written as `(source, external_id)` without the
   * member. External ids are provider-local and often DEVICE-local — Apple
   * Health and Google Fit hand out per-device ordinals — so two members
   * genuinely collide. Keyed on the pair alone, B's import took the ON CONFLICT
   * path against A's row, overwrote A's sport, time and duration while leaving
   * `user_id` as A, and handed B the id of A's row; B's subsequent route and
   * metrics writes then matched zero rows and vanished with no error.
   */
  it('does not let one member’s import overwrite another’s identical external id', async () => {
    const a = await recordTraining(
      db,
      A,
      training({ source: 'apple_health', externalId: 'workout-1', durationS: 30 * 60 }),
    );
    const b = await recordTraining(
      db,
      B,
      training({ source: 'apple_health', externalId: 'workout-1', sport: 'cycling', durationS: 90 * 60 }),
    );

    expect(b).not.toBe(a);

    const mineA = await memberTrainings(db, A);
    const mineB = await memberTrainings(db, B);
    expect(mineA).toHaveLength(1);
    expect(mineB).toHaveLength(1);
    // A's row is untouched by B's import.
    expect(mineA[0]?.sport).toBe('running');
    expect(mineA[0]?.durationS).toBe(30 * 60);
    expect(mineB[0]?.sport).toBe('cycling');
  });

  it('lets two manual trainings on the same day both stand', async () => {
    await recordTraining(db, A, training());
    await recordTraining(db, A, training({ startedAt: new Date('2028-05-10T17:00:00Z') }));
    expect(await memberTrainings(db, A)).toHaveLength(2);
  });

  /**
   * THE EVIDENCE CHECK, attacked directly in SQL rather than through the
   * normalizer — the whole reason it is a CHECK is that it must hold for callers
   * who never went through the normalizer.
   */
  it('refuses a manual row claiming connected_app evidence', async () => {
    await expect(
      client.query(
        `INSERT INTO training_logs (user_id, sport, started_at, sofia_day, duration_s, source, evidence)
         VALUES ($1, 'running', now(), current_date, 600, 'manual', 'connected_app')`,
        [A],
      ),
    ).rejects.toThrow(/training_logs_evidence_matches_source/);
  });

  /**
   * The tier is pinned EXACTLY, not merely bounded. An earlier draft allowed
   * `evidence IN ('connected_app','qr_verified')` for any non-manual source,
   * which let any importer assert the top tier by passing a nicer string — while
   * the comment beside it claimed the opposite. There are two tiers now and an
   * import can only ever be the lower one.
   */
  it('has exactly two evidence tiers, and an import cannot exceed connected_app', async () => {
    const labels = await client.query(
      `SELECT unnest(enum_range(NULL::training_evidence))::text AS v ORDER BY 1`,
    );
    expect(labels.rows.map((r) => String(r.v)).sort()).toEqual(['connected_app', 'self_reported']);

    await expect(
      client.query(
        `INSERT INTO training_logs (user_id, sport, started_at, sofia_day, duration_s, source, evidence, external_id)
         VALUES ($1, 'running', now(), current_date, 600, 'strava', 'self_reported', 'x1')`,
        [A],
      ),
    ).rejects.toThrow(/training_logs_evidence_matches_source/);
  });

  it('bounds both time columns against infinity', async () => {
    await expect(
      client.query(
        `INSERT INTO training_logs (user_id, sport, started_at, sofia_day, duration_s)
         VALUES ($1, 'running', 'infinity'::timestamptz, current_date, 600)`,
        [A],
      ),
    ).rejects.toThrow(/training_logs_started_finite/);

    await expect(
      client.query(
        `INSERT INTO training_logs (user_id, sport, started_at, sofia_day, duration_s)
         VALUES ($1, 'running', now(), DATE '2500-01-01', 600)`,
        [A],
      ),
    ).rejects.toThrow(/training_logs_day_sane/);
  });

  it('refuses a metrics row that asserts health processing but holds no health data', async () => {
    const id = await recordTraining(db, A, training({ source: 'garmin', externalId: 'g9' }));
    await setTrainingConsent(db, A, 'health', true);

    // Through the raw client, because drizzle wraps the driver error and hides
    // the constraint name — and the name is the point: it proves WHICH rule
    // refused, not merely that something did.
    await expect(
      client.query(`INSERT INTO training_metrics (training_log_id) VALUES ($1)`, [id]),
    ).rejects.toThrow(/training_metrics_not_empty/);

    // And the writer surfaces it rather than swallowing it into a no-op row.
    await expect(attachMetrics(db, A, id, {})).rejects.toThrow();
    const rows = await client.query(`SELECT count(*)::int AS n FROM training_metrics`);
    expect(Number(rows.rows[0].n)).toBe(0);
  });

  it('refuses a max heart rate below the average', async () => {
    const id = await recordTraining(db, A, training({ source: 'garmin', externalId: 'g10' }));
    await expect(
      client.query(
        `INSERT INTO training_metrics (training_log_id, avg_heart_rate, max_heart_rate)
         VALUES ($1, 170, 120)`,
        [id],
      ),
    ).rejects.toThrow(/training_metrics_max_ge_avg/);
  });

  it('refuses an import with no external id, and a manual row carrying one', async () => {
    await expect(
      client.query(
        `INSERT INTO training_logs (user_id, sport, started_at, sofia_day, duration_s, source, evidence)
         VALUES ($1, 'running', now(), current_date, 600, 'strava', 'connected_app')`,
        [A],
      ),
    ).rejects.toThrow(/training_logs_external_id_matches_source/);

    await expect(
      client.query(
        `INSERT INTO training_logs (user_id, sport, started_at, sofia_day, duration_s, source, evidence, external_id)
         VALUES ($1, 'running', now(), current_date, 600, 'manual', 'self_reported', 'x')`,
        [A],
      ),
    ).rejects.toThrow(/training_logs_external_id_matches_source/);
  });

  /* ---------------------------------------------------------------- consent */

  it('refuses a route with no recorded consent, loudly', async () => {
    const id = await recordTraining(db, A, training({ source: 'garmin', externalId: 'g1' }));
    await expect(
      attachRoute(db, A, id, [
        { lat: 42.69, lon: 23.32 },
        { lat: 42.7, lon: 23.33 },
      ]),
    ).rejects.toBeInstanceOf(TrainingConsentError);

    const rows = await client.query(`SELECT count(*)::int AS n FROM training_routes`);
    expect(Number(rows.rows[0].n)).toBe(0);
  });

  it('refuses health metrics with no recorded consent, loudly', async () => {
    const id = await recordTraining(db, A, training({ source: 'garmin', externalId: 'g2' }));
    await expect(attachMetrics(db, A, id, { avgHeartRate: 150 })).rejects.toBeInstanceOf(
      TrainingConsentError,
    );
  });

  it('stores a route once consent is recorded, with the timestamp', async () => {
    const id = await recordTraining(db, A, training({ source: 'garmin', externalId: 'g3' }));
    await setTrainingConsent(db, A, 'route', true, new Date('2028-05-01T10:00:00Z'));

    const consents = await trainingConsents(db, A);
    expect(consents.routeAt?.toISOString()).toBe('2028-05-01T10:00:00.000Z');
    expect(consents.healthAt).toBeNull();

    await attachRoute(db, A, id, [
      { lat: 42.69, lon: 23.32 },
      { lat: 42.7, lon: 23.33 },
    ]);
    const stored = await client.query(
      `SELECT point_count, ST_SRID(geom) AS srid, ST_GeometryType(geom) AS kind FROM training_routes`,
    );
    expect(Number(stored.rows[0].point_count)).toBe(2);
    expect(Number(stored.rows[0].srid)).toBe(4326);
    expect(String(stored.rows[0].kind)).toBe('ST_LineString');
  });

  /**
   * WITHDRAWAL DELETES. The training history survives; the route does not.
   */
  it('withdrawing route consent deletes the routes and keeps the trainings', async () => {
    const id = await recordTraining(db, A, training({ source: 'garmin', externalId: 'g4' }));
    await setTrainingConsent(db, A, 'route', true);
    await attachRoute(db, A, id, [
      { lat: 42.69, lon: 23.32 },
      { lat: 42.7, lon: 23.33 },
    ]);
    expect(Number((await client.query(`SELECT count(*)::int n FROM training_routes`)).rows[0].n)).toBe(1);

    await setTrainingConsent(db, A, 'route', false);
    expect(Number((await client.query(`SELECT count(*)::int n FROM training_routes`)).rows[0].n)).toBe(0);
    expect(await memberTrainings(db, A)).toHaveLength(1);
    expect((await trainingConsents(db, A)).routeAt).toBeNull();
  });

  it('withdrawing health consent deletes only the metrics, not the routes', async () => {
    const id = await recordTraining(db, A, training({ source: 'garmin', externalId: 'g5' }));
    await setTrainingConsent(db, A, 'route', true);
    await setTrainingConsent(db, A, 'health', true);
    await attachRoute(db, A, id, [
      { lat: 42.69, lon: 23.32 },
      { lat: 42.7, lon: 23.33 },
    ]);
    await attachMetrics(db, A, id, { avgHeartRate: 148, maxHeartRate: 176, caloriesKcal: 420 });

    await setTrainingConsent(db, A, 'health', false);
    expect(Number((await client.query(`SELECT count(*)::int n FROM training_metrics`)).rows[0].n)).toBe(0);
    expect(Number((await client.query(`SELECT count(*)::int n FROM training_routes`)).rows[0].n)).toBe(1);
  });

  it('one member’s withdrawal does not touch another member’s data', async () => {
    for (const id of [A, B]) {
      const log = await recordTraining(db, id, training({ source: 'garmin', externalId: `g-${id}` }));
      await setTrainingConsent(db, id, 'route', true);
      await attachRoute(db, id, log, [
        { lat: 42.69, lon: 23.32 },
        { lat: 42.7, lon: 23.33 },
      ]);
    }
    await setTrainingConsent(db, A, 'route', false);
    expect(Number((await client.query(`SELECT count(*)::int n FROM training_routes`)).rows[0].n)).toBe(1);
  });

  it('erasing the account takes the routes and the metrics with it', async () => {
    const id = await recordTraining(db, A, training({ source: 'garmin', externalId: 'g6' }));
    await setTrainingConsent(db, A, 'route', true);
    await setTrainingConsent(db, A, 'health', true);
    await attachRoute(db, A, id, [
      { lat: 42.69, lon: 23.32 },
      { lat: 42.7, lon: 23.33 },
    ]);
    await attachMetrics(db, A, id, { avgHeartRate: 150 });

    await client.query(`DELETE FROM users WHERE id = $1`, [A]);
    expect(Number((await client.query(`SELECT count(*)::int n FROM training_routes`)).rows[0].n)).toBe(0);
    expect(Number((await client.query(`SELECT count(*)::int n FROM training_metrics`)).rows[0].n)).toBe(0);
    expect(Number((await client.query(`SELECT count(*)::int n FROM training_logs`)).rows[0].n)).toBe(0);
  });

  /* ------------------------------------------------------------------ board */

  it('ranks by session COUNT, not by minutes or distance', async () => {
    // B trains twice, briefly. A trains once, for a long time. B leads.
    await recordTraining(db, A, training({ durationS: 3 * 3600, distanceM: 40_000 }));
    await recordTraining(db, B, training({ durationS: 20 * 60 }));
    await recordTraining(
      db,
      B,
      training({ startedAt: new Date('2028-05-09T07:00:00Z'), durationS: 20 * 60 }),
    );

    const board = await sportParticipationBoard(db, { sport: 'running', now: new Date('2028-05-12T00:00:00Z'), days: 30 });
    const mine = board.filter((row) => row.handle === handleFor(1) || row.handle === handleFor(2));
    expect(mine[0]?.handle).toBe(handleFor(2));
    expect(mine[0]?.sessions).toBe(2);
    expect(mine[1]?.sessions).toBe(1);
    expect(mine[1]?.minutes).toBe(180);
  });

  /**
   * The consent rule every public ranking in this codebase inherits: a member
   * who has not published their passport is not on the board at all.
   */
  it('omits a member whose passport is private', async () => {
    await recordTraining(db, C, training());
    const board = await sportParticipationBoard(db, {
      sport: 'running',
      now: new Date('2028-05-12T00:00:00Z'),
      days: 30,
    });
    expect(board.map((r) => r.displayName)).not.toContain('Trn 3');
    expect(JSON.stringify(board)).not.toContain(handleFor(3));
  });

  it('honours the evidence floor when one is asked for', async () => {
    await recordTraining(db, A, training());
    await recordTraining(db, B, training({ source: 'strava', externalId: 'ev1' }));

    const all = await sportParticipationBoard(db, {
      sport: 'running', now: new Date('2028-05-12T00:00:00Z'), days: 30,
    });
    const strict = await sportParticipationBoard(db, {
      sport: 'running', now: new Date('2028-05-12T00:00:00Z'), days: 30,
      minEvidence: 'connected_app',
    });
    expect(all.length).toBeGreaterThan(strict.length);
    expect(strict.map((r) => r.handle)).toEqual([handleFor(2)]);
  });

  it('respects the rolling civil-day window', async () => {
    await recordTraining(db, A, training({ startedAt: new Date('2028-01-02T09:00:00Z') }));
    const recent = await sportParticipationBoard(db, {
      sport: 'running', now: new Date('2028-05-12T00:00:00Z'), days: 30,
    });
    expect(recent.map((r) => r.handle)).not.toContain(handleFor(1));
  });
});

/**
 * The open-data boundary, asserted rather than assumed.
 *
 * `ALLOWED_RELATIONS` is default-deny, so these tables are excluded by not being
 * listed — which is exactly the kind of protection that survives until somebody
 * adds a "training statistics" dataset in good faith. `training_logs` carries a
 * `user_id`; the other two carry a home-address-shaped line and Art. 9 health
 * data. Needs no database, so it runs everywhere.
 */
describe('training data is not open data', () => {
  it('keeps all three training tables off the relation allowlist', () => {
    for (const relation of ['training_logs', 'training_routes', 'training_metrics']) {
      expect(ALLOWED_RELATIONS as readonly string[], relation).not.toContain(relation);
    }
  });

  it('has no exported dataset reading a training relation', () => {
    for (const dataset of EXPORT_DATASETS) {
      expect(JSON.stringify(dataset), dataset.id).not.toContain('training');
    }
  });
});
