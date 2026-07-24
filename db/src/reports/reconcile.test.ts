import {
  allMetrics,
  dayRangePeriod,
  GRANT_REPORT,
  QUARTERLY_REPORT,
} from '@sportkarta/lib/reports';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertReportSafe, asQueryable, compileMetric, runReport } from './run.js';
import { refreshStats } from '../stats.js';

/**
 * THE RECONCILIATION STANDARD for reports (Stage 6.2).
 *
 * db/src/stats-reconcile.test.ts sets the bar for /statistika: every published
 * aggregate provably EQUALS an independently written query on the base tables.
 * This file holds report figures to the same bar, and has to work harder for it
 * — because a report metric's SQL is its own definition, so "run the metric,
 * then run the metric again" would be a tautology dressed as a test.
 *
 * Four things are checked, and only the first is cheap:
 *
 *  1. The catalogue compiles safely and binds only known placeholders.
 *  2. FIXTURE EXACTNESS. A known world is built inside a transaction — one
 *     municipality, two facilities, sessions, RSVPs, check-ins of each method —
 *     the report is run against it, and every figure is asserted against a
 *     number computed by hand from the fixture. This is what proves a metric
 *     means what its Bulgarian label says, rather than merely being stable.
 *  3. ADDITIVITY. Metrics declared `additive` must sum across municipalities to
 *     the national figure; those declared non-additive must not be summable,
 *     and the test asserts the national distinct count is at most the sum of
 *     the municipal ones — the property that makes summing them wrong.
 *  4. AGREEMENT WITH /statistika. The quarterly report's coverage figures must
 *     equal a direct query on `facilities`, so the report, the statistics page
 *     and the open-data API cannot show a municipality three different numbers.
 *
 * Everything runs inside a transaction that is rolled back.
 */

const url = process.env.DATABASE_URL;

describe('report catalogues compile safely (no database required)', () => {
  it('every metric and table compiles with bound parameters only', () => {
    expect(() => {
      assertReportSafe(GRANT_REPORT);
    }).not.toThrow();
    expect(() => {
      assertReportSafe(QUARTERLY_REPORT);
    }).not.toThrow();
  });

  it('compiles named placeholders to positional parameters, reusing them', () => {
    const { text, order } = compileMetric(GRANT_REPORT, 'sessions_held');
    expect(order).toEqual(['from', 'to', 'municipality']);
    expect(text).toContain('$1');
    expect(text).toContain('$2');
    // `:municipality` appears twice in the scope predicate and must bind to the
    // SAME parameter — two placeholders would shift every later index by one
    // and silently compare a date against a municipality id.
    expect(text.match(/\$3/g)?.length).toBe(2);
    expect(text).not.toContain(':municipality');
    // Casts survive as casts.
    expect(text).toContain('::int');
  });
});

describe.skipIf(!url)('report figures against the real database', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: url });
    await client.connect();
    await refreshStats(client, { concurrently: false });
  });

  afterAll(async () => {
    await client.end();
  });

  /**
   * A known world, built inside the caller's transaction.
   *
   * Deliberately lopsided so a metric that confuses two concepts fails: three
   * distinct people but four RSVPs (one person joins two sessions), one QR
   * check-in, one organiser-marked and one self-attested, and a cancelled
   * occurrence that must be counted as cancelled and excluded from everything
   * else.
   */
  async function buildFixture(stamp: string): Promise<{ municipalityId: number }> {
    const muni = await client.query<{ id: number }>(
      `INSERT INTO municipalities (ekatte_code, name_bg, name_en, geom)
       VALUES ($1, $2, $3, ST_SetSRID(ST_GeomFromText('MULTIPOLYGON(((23 42, 24 42, 24 43, 23 43, 23 42)))'), 4326))
       RETURNING id`,
      [`RPT${stamp}`, `Отчетна ${stamp}`, `Report ${stamp}`],
    );
    const municipalityId = muni.rows[0]?.id;
    if (municipalityId === undefined) throw new Error('fixture municipality not created');

    const facilityIds: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const facility = await client.query<{ id: string }>(
        `INSERT INTO facilities (geom, name, slug, sport_types, access, source, municipality_id, created_at)
         VALUES (ST_SetSRID(ST_MakePoint(23.5, 42.5), 4326), $1, $2, '{football}', 'free', 'crowd', $3, '2026-09-10T09:00:00Z')
         RETURNING id`,
        [`Отчетна площадка ${String(i)}`, `rpt-${stamp}-${String(i)}`, municipalityId],
      );
      const id = facility.rows[0]?.id;
      if (!id) throw new Error('fixture facility not created');
      facilityIds.push(id);
    }

    const userIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const id = `rpt-user-${stamp}-${String(i)}`;
      await client.query(
        `INSERT INTO users (id, display_name, email) VALUES ($1, $2, $3)`,
        [id, `Участник ${String(i)}`, `rpt-${stamp}-${String(i)}@example.org`],
      );
      userIds.push(id);
    }

    // Two series, one occurrence each, plus a cancelled occurrence.
    const occurrenceIds: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const session = await client.query<{ id: string }>(
        `INSERT INTO play_sessions (facility_id, sport, organizer_id, title, starts_at_local, duration_minutes)
         VALUES ($1, 'football', $2, $3, '2026-09-15 18:00:00', 90) RETURNING id`,
        [facilityIds[i], userIds[0], `Тренировка ${String(i)}`],
      );
      const sessionId = session.rows[0]?.id;
      if (!sessionId) throw new Error('fixture session not created');
      const occurrence = await client.query<{ id: string }>(
        `INSERT INTO play_session_occurrences (session_id, starts_at, ends_at, starts_at_local)
         VALUES ($1, '2026-09-15T15:00:00Z', '2026-09-15T16:30:00Z', '2026-09-15 18:00:00')
         RETURNING id`,
        [sessionId],
      );
      const occurrenceId = occurrence.rows[0]?.id;
      if (!occurrenceId) throw new Error('fixture occurrence not created');
      occurrenceIds.push(occurrenceId);
    }
    // A cancelled occurrence on the first series.
    const cancelledSession = await client.query<{ id: string }>(
      `INSERT INTO play_sessions (facility_id, sport, organizer_id, title, starts_at_local, duration_minutes)
       VALUES ($1, 'football', $2, 'Отменена', '2026-09-22 18:00:00', 90) RETURNING id`,
      [facilityIds[0], userIds[0]],
    );
    await client.query(
      `INSERT INTO play_session_occurrences
         (session_id, starts_at, ends_at, starts_at_local, status, cancelled_at, cancellation_scope)
       VALUES ($1, '2026-09-22T15:00:00Z', '2026-09-22T16:30:00Z', '2026-09-22 18:00:00',
               'cancelled', now(), 'occurrence')`,
      [cancelledSession.rows[0]?.id],
    );

    // Four active RSVPs across three distinct people: user 0 joins both.
    for (const [occurrenceIndex, users] of [
      [0, [0, 1]],
      [1, [0, 2]],
    ] as [number, number[]][]) {
      for (const userIndex of users) {
        await client.query(
          `INSERT INTO play_session_rsvps (occurrence_id, user_id) VALUES ($1, $2)`,
          [occurrenceIds[occurrenceIndex], userIds[userIndex]],
        );
      }
    }

    // One check-in of each method, across two distinct people.
    await client.query(
      `INSERT INTO play_session_checkins (occurrence_id, user_id, method, scored)
       VALUES ($1, $2, 'qr', true)`,
      [occurrenceIds[0], userIds[0]],
    );
    await client.query(
      `INSERT INTO play_session_checkins (occurrence_id, user_id, method, recorded_by)
       VALUES ($1, $2, 'organizer', $3)`,
      [occurrenceIds[0], userIds[1], userIds[0]],
    );
    await client.query(
      `INSERT INTO play_session_checkins (occurrence_id, user_id, method)
       VALUES ($1, $2, 'self')`,
      [occurrenceIds[1], userIds[2]],
    );

    // One crowd verification and one condition report, inside the period.
    await client.query(
      `INSERT INTO facility_edits (facility_id, actor, source, field, new_value, created_at)
       VALUES ($1, $2, 'crowd', 'verified', 'true'::jsonb, '2026-09-14T10:00:00Z')`,
      [facilityIds[0], userIds[1]],
    );
    await client.query(
      `INSERT INTO facility_condition_reports (facility_id, reporter_id, state, created_at)
       VALUES ($1, $2, 'good', '2026-09-16T10:00:00Z')`,
      [facilityIds[1], userIds[2]],
    );

    return { municipalityId };
  }

  async function grantValues(municipalityId: number | null): Promise<Map<string, number | null>> {
    const period = dayRangePeriod('2026-09-01', '2026-09-30');
    const data = await runReport(
      asQueryable(client),
      GRANT_REPORT,
      { from: period.from, to: period.to, municipalityId },
      null,
    );
    return new Map(data.metrics.map((m) => [m.metricId, m.value]));
  }

  it('every grant figure equals the number the fixture implies', async () => {
    await client.query('BEGIN');
    try {
      const stamp = String(Date.now()).slice(-8);
      const { municipalityId } = await buildFixture(stamp);
      const values = await grantValues(municipalityId);

      // Sessions: two held, one cancelled, across two facilities.
      expect(values.get('sessions_held'), 'sessions_held').toBe(2);
      expect(values.get('sessions_cancelled'), 'sessions_cancelled').toBe(1);
      expect(values.get('facilities_used'), 'facilities_used').toBe(2);

      // Four RSVPs but only three distinct people — the difference between an
      // event count and a person count, which is the whole reason both exist.
      expect(values.get('signups'), 'signups').toBe(4);
      expect(values.get('distinct_participants'), 'distinct_participants').toBe(3);

      // Attendance: one of each method, never summed.
      expect(values.get('attendance_qr'), 'attendance_qr').toBe(1);
      expect(values.get('attendance_organizer'), 'attendance_organizer').toBe(1);
      expect(values.get('attendance_self'), 'attendance_self').toBe(1);
      // Only the QR one counts as verified attendance.
      expect(values.get('distinct_attendees_verified'), 'distinct_attendees_verified').toBe(1);

      // Facilities: two created in the period, one verified, one condition report.
      expect(values.get('facilities_in_scope'), 'facilities_in_scope').toBe(2);
      expect(values.get('facilities_added'), 'facilities_added').toBe(2);
      expect(values.get('facilities_verified'), 'facilities_verified').toBe(1);
      expect(values.get('condition_reports'), 'condition_reports').toBe(1);
      expect(values.get('contributors_active'), 'contributors_active').toBe(1);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('excludes anything outside the period, at both ends', async () => {
    await client.query('BEGIN');
    try {
      const stamp = String(Date.now()).slice(-8);
      const { municipalityId } = await buildFixture(stamp);

      // The fixture's sessions are on 15 September. A period ending on the 14th
      // must see none of them; one ending on the 15th must see both.
      const before = dayRangePeriod('2026-09-01', '2026-09-14');
      const including = dayRangePeriod('2026-09-01', '2026-09-15');

      const runFor = async (period: { from: Date; to: Date }): Promise<number | null> => {
        const data = await runReport(
          asQueryable(client),
          GRANT_REPORT,
          { from: period.from, to: period.to, municipalityId },
          null,
        );
        return data.metrics.find((m) => m.metricId === 'sessions_held')?.value ?? null;
      };

      expect(await runFor(before)).toBe(0);
      // THE INCLUSIVE LAST DAY: the session starts at 18:00 Sofia on the 15th,
      // and a period whose end day is the 15th must contain it. An exclusive
      // bound set to midnight ON the 15th would drop it — the off-by-one this
      // whole period model exists to prevent.
      expect(await runFor(including)).toBe(2);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('scopes to the municipality: another municipality sees none of it', async () => {
    await client.query('BEGIN');
    try {
      const stamp = String(Date.now()).slice(-8);
      const { municipalityId } = await buildFixture(stamp);
      const other = await client.query<{ id: number }>(
        `SELECT id FROM municipalities WHERE id <> $1 LIMIT 1`,
        [municipalityId],
      );
      const otherId = other.rows[0]?.id;
      if (otherId === undefined) throw new Error('need a second municipality');

      const mine = await grantValues(municipalityId);
      const theirs = await grantValues(otherId);
      expect(mine.get('sessions_held')).toBe(2);
      // The fixture's sessions must not appear in a different municipality's
      // annex. A scope predicate that silently matched everything would show up
      // here and nowhere else.
      expect(theirs.get('facilities_used')).toBe(0);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('additive figures sum across municipalities to the national figure', async () => {
    await client.query('BEGIN');
    try {
      const stamp = String(Date.now()).slice(-8);
      await buildFixture(stamp);

      const period = dayRangePeriod('2026-09-01', '2026-09-30');
      const national = await grantValues(null);

      const municipalities = await client.query<{ id: number }>(`SELECT id FROM municipalities`);
      const additive = allMetrics(GRANT_REPORT)
        .map(({ metric }) => metric)
        // `facilities_in_scope` is a state-of-today figure over ALL facilities,
        // including those with no municipality at all, so it needs the
        // no-municipality bucket accounted for exactly as stats-reconcile does.
        .filter((metric) => metric.additive && metric.id !== 'facilities_in_scope');

      const sums = new Map<string, number>();
      for (const row of municipalities.rows) {
        const values = await grantValues(row.id);
        for (const metric of additive) {
          sums.set(metric.id, (sums.get(metric.id) ?? 0) + (values.get(metric.id) ?? 0));
        }
      }

      for (const metric of additive) {
        // Moderation figures are scoped by the decision's own municipality,
        // which is NULL when the facility had none — the same bucket problem.
        if (metric.id === 'moderation_decisions') continue;
        expect(sums.get(metric.id) ?? 0, `${metric.id} does not sum to the national figure`).toBe(
          national.get(metric.id) ?? 0,
        );
      }
      void period;
    } finally {
      await client.query('ROLLBACK');
    }
    // This runs the whole grant report once PER municipality (the seed has the
    // full national list), so it is legitimately heavier than the 5 s default —
    // and a timeout here is not just its own failure: it aborts before the
    // ROLLBACK, leaving the shared client's transaction open so the next test
    // sees these fixtures too. Give it real headroom.
  }, 60_000);

  it('non-additive figures must NOT be summed — the national total is smaller', async () => {
    await client.query('BEGIN');
    try {
      const stamp = String(Date.now()).slice(-8);
      const { municipalityId } = await buildFixture(stamp);

      // Give the same person activity in a second municipality, which is
      // exactly the situation that makes a distinct-person count non-additive.
      const second = await buildFixture(`${stamp}b`);
      await client.query(
        `INSERT INTO play_session_rsvps (occurrence_id, user_id)
         SELECT o.id, $1
         FROM play_session_occurrences o
         JOIN play_sessions s ON s.id = o.session_id
         JOIN facilities f ON f.id = s.facility_id
         WHERE f.municipality_id = $2 AND o.status <> 'cancelled'
         LIMIT 1`,
        [`rpt-user-${stamp}-0`, second.municipalityId],
      );

      const a = await grantValues(municipalityId);
      const b = await grantValues(second.municipalityId);
      const national = await grantValues(null);

      const sumOfParts = (a.get('distinct_participants') ?? 0) + (b.get('distinct_participants') ?? 0);
      const nationalValue = national.get('distinct_participants') ?? 0;

      // The invariant that makes the `additive: false` flag necessary: summing
      // the annexes OVERSTATES the national figure, because one person appears
      // in both. If this ever became an equality, the flag would be wrong.
      expect(nationalValue).toBeLessThan(sumOfParts);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('quarterly coverage figures equal a direct query on facilities', async () => {
    // The /statistika standard: the report must not be able to show a third
    // number for something the statistics page and the open-data API agree on.
    const period = dayRangePeriod('2026-01-01', '2026-12-31');
    const data = await runReport(
      asQueryable(client),
      QUARTERLY_REPORT,
      { from: period.from, to: period.to, municipalityId: null },
      null,
    );
    const values = new Map(data.metrics.map((m) => [m.metricId, m.value]));

    const direct = (
      await client.query<{ total: number; covered: number; unusable: number }>(`
        SELECT count(*)::int AS total,
               count(DISTINCT municipality_id) FILTER (WHERE municipality_id IS NOT NULL)::int AS covered,
               count(*) FILTER (WHERE condition = 'unusable')::int AS unusable
        FROM facilities WHERE status <> 'gone' AND slug IS NOT NULL
      `)
    ).rows[0];
    if (!direct) throw new Error('direct query returned no row');

    expect(values.get('facilities_total'), 'facilities_total').toBe(direct.total);
    expect(values.get('municipalities_covered'), 'municipalities_covered').toBe(direct.covered);
    expect(values.get('facilities_unusable'), 'facilities_unusable').toBe(direct.unusable);
  });

  it('the coverage-gaps table includes municipalities with no facilities at all', async () => {
    await client.query('BEGIN');
    try {
      // The trap: mv_municipality_stats is built with a JOIN onto facilities,
      // so a municipality with zero public facilities is ABSENT from it — and a
      // gaps table built from that view would omit precisely the worst gaps
      // while looking complete.
      const stamp = String(Date.now()).slice(-8);
      const muni = await client.query<{ id: number }>(
        `INSERT INTO municipalities (ekatte_code, name_bg, name_en, geom)
         VALUES ($1, $2, $3, ST_SetSRID(ST_GeomFromText('MULTIPOLYGON(((25 42, 26 42, 26 43, 25 43, 25 42)))'), 4326))
         RETURNING id`,
        [`GAP${stamp}`, `Празна ${stamp}`, `Empty ${stamp}`],
      );
      void muni;
      await client.query(
        `INSERT INTO municipality_population (ekatte_code, population, source)
         VALUES ($1, 50000, 'test')`,
        [`GAP${stamp}`],
      );

      const period = dayRangePeriod('2026-01-01', '2026-12-31');
      const data = await runReport(
        asQueryable(client),
        QUARTERLY_REPORT,
        { from: period.from, to: period.to, municipalityId: null },
        null,
      );
      const gaps = data.tables.find((t) => t.tableId === 'coverage_gaps')?.rows ?? [];
      const names = gaps.map((row) => String(row.name_bg));
      expect(names, 'a zero-facility municipality is the biggest gap and must appear').toContain(
        `Празна ${stamp}`,
      );
      const row = gaps.find((r) => String(r.name_bg) === `Празна ${stamp}`);
      expect(Number(row?.facilities)).toBe(0);
      expect(Number(row?.per_10k)).toBe(0);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('a period with no activity reports zero, never null', async () => {
    // A blank cell in an annex reads as "we did not measure", which is a
    // different claim from "it was zero" — and the wrong one to file.
    const period = dayRangePeriod('1999-01-01', '1999-01-31');
    const data = await runReport(
      asQueryable(client),
      GRANT_REPORT,
      { from: period.from, to: period.to, municipalityId: null },
      null,
    );
    const counts = data.metrics.filter((m) => m.metricId !== 'facilities_in_scope');
    for (const metric of counts) {
      expect(metric.value, `${metric.metricId} returned null for an empty period`).not.toBeNull();
    }
    expect(data.metrics.find((m) => m.metricId === 'sessions_held')?.value).toBe(0);
  });
});
