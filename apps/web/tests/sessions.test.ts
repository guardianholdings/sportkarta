import { renderSql, type SQL } from '@sportkarta/db';
import { describe, expect, it } from 'vitest';

import { issueCheckinToken } from '@sportkarta/lib/checkin-token';
import { ATTENDANCE_AWARDS_PER_DAY } from '@sportkarta/lib/points';

import { checkIn } from '@/lib/sessions/checkin';
import { SessionError } from '@/lib/sessions/errors';
import { attendanceCounts, rsvp, withdraw } from '@/lib/sessions/rsvp';
import { normalizeSession } from '@/lib/sessions/session-input';
import { cancelOccurrence, cancelSeries, createSession } from '@/lib/sessions/sessions';

/**
 * Session logic at the statement level (docs/ROADMAP.md §6, Stage 4.1). The
 * DB-backed companions live in db/src/sessions-*.test.ts, which prove the same
 * rules against real Postgres constraints and triggers.
 */

/** Stage 5.4 fixtures: a QR secret and the occurrence its tokens name. */
const SECRET = 'a-test-check-in-secret-value-here';
const OCC = '11111111-1111-4111-8111-111111111111';

function fakeDb(rows: Record<string, unknown>[][] = []) {
  const statements: { sql: string; params: unknown[] }[] = [];
  let index = 0;
  const runner = {
    execute(query: SQL) {
      statements.push(renderSql(query));
      const answer = rows[index] ?? [];
      index += 1;
      return Promise.resolve({ rows: answer });
    },
  };
  return {
    statements,
    ...runner,
    transaction<T>(callback: (tx: typeof runner) => Promise<T>): Promise<T> {
      return callback(runner);
    },
  };
}

const validInput = {
  facilityId: '00000000-0000-4000-8000-000000000001',
  sport: 'football',
  title: '  Футбол   в  Лозенец ',
  startsAtLocal: '2099-03-02T18:00',
  rrule: 'FREQ=WEEKLY;BYDAY=TU',
  durationMinutes: 90,
};

describe('normalizeSession', () => {
  it('trims and collapses whitespace in the title', () => {
    expect(normalizeSession(validInput).title).toBe('Футбол в Лозенец');
  });

  it('stores the rule in the engine’s canonical form', () => {
    // Parsed and re-emitted, not pattern-matched: what lands in the column is
    // exactly what the materializer will expand, with no second spelling.
    expect(
      normalizeSession({ ...validInput, rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=TH,TU' }).rrule,
    ).toBe('FREQ=WEEKLY;BYDAY=TU,TH');
    expect(normalizeSession({ ...validInput, rrule: '  ' }).rrule).toBeNull();
    expect(normalizeSession({ ...validInput, rrule: null }).rrule).toBeNull();
  });

  it('keeps the start as a wall clock, never an instant', () => {
    const normalized = normalizeSession(validInput);
    expect(normalized.startsAtLocal).toBe('2099-03-02T18:00:00');
    expect(normalized.timezone).toBe('Europe/Sofia');
  });

  it('passes the recurrence engine’s own slug through', () => {
    // An organiser who asked for a monthly session is told monthly is not
    // supported — not that "something went wrong".
    expect(() => normalizeSession({ ...validInput, rrule: 'FREQ=MONTHLY' })).toThrowError(
      'rrule_unsupported_freq',
    );
    expect(() => normalizeSession({ ...validInput, rrule: 'FREQ=DAILY;BYDAY=MO' })).toThrowError(
      'rrule_byday_requires_weekly',
    );
  });

  it('rejects what the database would reject, with a translatable code', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ title: '   ' }, 'title_required'],
      [{ title: 'x'.repeat(121) }, 'title_too_long'],
      [{ description: 'x'.repeat(2001) }, 'description_too_long'],
      [{ sport: 'kabaddi' }, 'invalid_sport'],
      [{ sport: 'Football' }, 'invalid_sport'],
      [{ durationMinutes: 5 }, 'invalid_duration'],
      [{ durationMinutes: 600 }, 'invalid_duration'],
      [{ durationMinutes: 90.5 }, 'invalid_duration'],
      [{ capacity: 0 }, 'invalid_capacity'],
      [{ capacity: 501 }, 'invalid_capacity'],
      [{ skillLevel: 'expert' }, 'invalid_skill_level'],
      [{ visibility: 'secret' }, 'invalid_visibility'],
      [{ startsAtLocal: '2099-02-31T18:00' }, 'invalid_start'],
      [{ startsAtLocal: 'tuesday evening' }, 'invalid_start'],
    ];
    for (const [override, code] of cases) {
      expect(() => normalizeSession({ ...validInput, ...override }), code).toThrowError(code);
    }
  });

  it('accepts an unlimited capacity as NULL', () => {
    expect(normalizeSession(validInput).capacity).toBeNull();
    expect(normalizeSession({ ...validInput, capacity: 12 }).capacity).toBe(12);
  });
});

describe('createSession', () => {
  it('writes the series and asks for it to be materialized at once', async () => {
    const db = fakeDb([[{ status: 'active' }], [{ id: 'session_1' }]]);
    const enqueued: { queue: string; data: Record<string, unknown> }[] = [];
    const result = await createSession(db, 'user_1', validInput, async (queue, data) => {
      enqueued.push({ queue, data });
    });

    expect(result.sessionId).toBe('session_1');
    const text = db.statements.map((s) => s.sql).join('\n');
    expect(text).toMatch(/INSERT INTO play_sessions/i);
    // Occurrences are never written here — one implementation of the recurrence
    // rules, and it lives in the job.
    expect(text).not.toMatch(/INSERT INTO play_session_occurrences/i);
    // The organiser should not wait an hour for the schedule to come round.
    expect(enqueued).toEqual([{ queue: 'session.materialize', data: { sessionId: 'session_1' } }]);
  });

  it('refuses a facility that has been reported gone', async () => {
    const db = fakeDb([[{ status: 'gone' }]]);
    await expect(createSession(db, 'user_1', validInput)).rejects.toThrowError('facility_gone');
  });

  it('refuses a facility that does not exist', async () => {
    const db = fakeDb([[]]);
    await expect(createSession(db, 'user_1', validInput)).rejects.toThrowError(
      'facility_not_found',
    );
  });
});

describe('cancelSeries', () => {
  it('counts the people to tell BEFORE cancelling, and enqueues a count only', async () => {
    const db = fakeDb([
      [{ status: 'scheduled', is_organizer: true, is_admin: false }],
      [{ n: 3 }], // recipients
      [{ n: 5 }], // future occurrences
      [],
    ]);
    const enqueued: { queue: string; data: Record<string, unknown> }[] = [];
    const result = await cancelSeries(db, 'user_1', 'session_1', {
      enqueue: async (queue, data) => {
        enqueued.push({ queue, data });
      },
    });

    expect(result).toEqual({ recipientCount: 3, occurrencesCancelled: 5 });
    const sqls = db.statements.map((s) => s.sql);
    // The count has to happen while the occurrences are still scheduled —
    // afterwards there is nothing left to identify them by.
    const countIndex = sqls.findIndex((s) => /count\(DISTINCT r\.user_id\)/i.test(s));
    const updateIndex = sqls.findIndex((s) =>
      /UPDATE play_sessions SET status = 'cancelled'/i.test(s),
    );
    expect(countIndex).toBeGreaterThanOrEqual(0);
    expect(countIndex).toBeLessThan(updateIndex);
    // The cascade is the database's job, not this function's.
    expect(sqls.join('\n')).not.toMatch(/UPDATE play_session_occurrences/i);
    // The payload carries a NUMBER, never a recipient list: addresses belong in
    // the query the mailer runs at send time, not in a job row that outlives
    // the account it names.
    expect(enqueued[0]?.data).toEqual({
      sessionId: 'session_1',
      reason: 'series_cancelled',
      recipientCount: 3,
    });
    expect(JSON.stringify(enqueued)).not.toMatch(/@/);
  });

  it('refuses someone else’s series, and accepts a real admin', async () => {
    const denied = fakeDb([[{ status: 'scheduled', is_organizer: false, is_admin: false }]]);
    await expect(cancelSeries(denied, 'user_2', 'session_1')).rejects.toThrowError('not_organizer');

    const allowed = fakeDb([
      [{ status: 'scheduled', is_organizer: false, is_admin: true }],
      [{ n: 0 }],
      [{ n: 0 }],
      [],
    ]);
    await expect(cancelSeries(allowed, 'admin_1', 'session_1')).resolves.toEqual({
      recipientCount: 0,
      occurrencesCancelled: 0,
    });
  });

  it('reads the admin role from the database, never from the caller', async () => {
    // An `actorIsAdmin` parameter used to exist here. It was a trap: the obvious
    // call site is requireAdmin(), which means "ambassador OR admin", so every
    // ambassador would have been able to cancel any session in the country.
    const db = fakeDb([
      [{ status: 'scheduled', is_organizer: true, is_admin: false }],
      [{ n: 0 }],
      [{ n: 0 }],
      [],
    ]);
    await cancelSeries(db, 'user_1', 'session_1');
    const authz = db.statements[0]?.sql ?? '';
    expect(authz).toMatch(/FROM users u WHERE u\.id = \$\d+ AND u\.role = 'admin'/i);
    // Ambassadors are not admins here — their authority is municipality-scoped
    // and a session has no municipality to scope against.
    expect(authz).not.toMatch(/ambassador/i);
    // The write repeats the check, so the decision and the write cannot be
    // separated by a concurrent change of organiser.
    const update = db.statements.find((st) => /UPDATE play_sessions SET status/i.test(st.sql));
    expect(update?.sql).toMatch(/organizer_id = \$\d+/);
  });

  it('refuses to cancel an already-cancelled series', async () => {
    const db = fakeDb([[{ status: 'cancelled', is_organizer: true, is_admin: false }]]);
    await expect(cancelSeries(db, 'user_1', 'session_1')).rejects.toThrowError('already_cancelled');
  });

  it('reports a missing series rather than silently succeeding', async () => {
    const db = fakeDb([[]]);
    await expect(cancelSeries(db, 'user_1', 'nope')).rejects.toThrowError('session_not_found');
  });
});

describe('cancelOccurrence', () => {
  it('cancels one date with scope=occurrence and leaves the series alone', async () => {
    const db = fakeDb([
      [
        {
          session_id: 'session_1',
          status: 'scheduled',
          started: false,
          is_organizer: true,
          is_admin: false,
        },
      ],
      [{ n: 2 }],
      [],
    ]);
    const enqueued: Record<string, unknown>[] = [];
    const result = await cancelOccurrence(db, 'user_1', 'occ_1', {
      enqueue: async (_queue, data) => {
        enqueued.push(data);
      },
    });

    expect(result).toEqual({ recipientCount: 2, occurrencesCancelled: 1 });
    const text = db.statements.map((s) => s.sql).join('\n');
    expect(text).toMatch(/cancellation_scope = 'occurrence'/i);
    expect(text).not.toMatch(/UPDATE play_sessions/i);
    expect(enqueued[0]).toEqual({
      occurrenceId: 'occ_1',
      reason: 'occurrence_cancelled',
      recipientCount: 2,
    });
  });

  it('refuses an occurrence that is already cancelled or missing', async () => {
    const cancelled = fakeDb([
      [
        {
          session_id: 'session_1',
          status: 'cancelled',
          started: false,
          is_organizer: true,
          is_admin: false,
        },
      ],
    ]);
    await expect(cancelOccurrence(cancelled, 'user_1', 'occ_1')).rejects.toThrowError(
      'already_cancelled',
    );

    const missing = fakeDb([[]]);
    await expect(cancelOccurrence(missing, 'user_1', 'occ_1')).rejects.toThrowError(
      'occurrence_not_found',
    );
  });
});

describe('checkIn authorization', () => {
  const open = {
    status: 'scheduled',
    within_window: true,
    actor_is_organizer: false,
    facility_id: '00000000-0000-4000-8000-000000000001',
    distance_m: null,
  };

  it('lets a member check themselves in', async () => {
    const db = fakeDb([[open], [{ id: 'checkin_1' }]]);
    await expect(
      checkIn(db, { occurrenceId: 'occ_1', userId: 'user_1', actorId: 'user_1' }),
    ).resolves.toEqual({
      checkinId: 'checkin_1',
      created: true,
      // Stage 5.4: a self check-in is recorded and never paid.
      outcome: 'unscored_method',
      distanceM: null,
      pointsAwarded: 0,
    });
    // A self check-in is not "recorded by" anybody else.
    expect(db.statements[1]?.params).toContain(null);
    // And it writes no ledger row at all.
    expect(db.statements.map((st) => st.sql).join('\n')).not.toMatch(/points_ledger/i);
  });

  it('refuses to let one member check ANOTHER in as `self`', async () => {
    // A check-in is a claim that a named person was somewhere, and Stage 5
    // scores off it. Writing one for somebody else must not be possible.
    const db = fakeDb([[open]]);
    await expect(
      checkIn(db, { occurrenceId: 'occ_1', userId: 'victim', actorId: 'attacker' }),
    ).rejects.toThrowError('not_organizer');
    // Rejected before any statement runs at all.
    expect(db.statements).toHaveLength(0);
  });

  it('refuses `organizer` from someone who does not organise THIS series', async () => {
    const db = fakeDb([[{ ...open, actor_is_organizer: false }]]);
    await expect(
      checkIn(db, {
        occurrenceId: 'occ_1',
        userId: 'victim',
        actorId: 'attacker',
        method: 'organizer',
      }),
    ).rejects.toThrowError('not_organizer');
    // The organiser test is a database read, not a caller claim.
    expect(db.statements[0]?.sql).toMatch(/s\.organizer_id = \$\d+/);
  });

  it('lets the real organiser mark somebody present, and records who did', async () => {
    const db = fakeDb([[{ ...open, actor_is_organizer: true }], [{ id: 'checkin_2' }]]);
    await expect(
      checkIn(db, {
        occurrenceId: 'occ_1',
        userId: 'player_1',
        actorId: 'organizer_1',
        method: 'organizer',
      }),
    ).resolves.toEqual({
      checkinId: 'checkin_2',
      created: true,
      // Vouching is not evidence: it records attendance and pays nothing.
      outcome: 'unscored_method',
      distanceM: null,
      pointsAwarded: 0,
    });
    expect(db.statements[1]?.params).toContain('organizer_1');
  });

  it('refuses a qr check-in with no token', async () => {
    const db = fakeDb([[open]]);
    await expect(
      checkIn(db, {
        occurrenceId: 'occ_1',
        userId: 'user_1',
        actorId: 'user_1',
        method: 'qr',
        secret: SECRET,
      }),
    ).rejects.toThrowError('invalid_checkin_token');
    // Rejected before any statement runs.
    expect(db.statements).toHaveLength(0);
  });

  it('refuses a qr check-in when no secret is configured — fail closed', async () => {
    const db = fakeDb([[open]]);
    const token = issueCheckinToken({ occurrenceId: OCC, secret: SECRET });
    await expect(
      checkIn(db, {
        occurrenceId: OCC,
        userId: 'user_1',
        actorId: 'user_1',
        method: 'qr',
        token,
        secret: undefined,
      }),
    ).rejects.toThrowError('invalid_checkin_token');
  });

  it('refuses a token issued for a DIFFERENT occurrence', async () => {
    const db = fakeDb([[open]]);
    const token = issueCheckinToken({
      occurrenceId: '99999999-9999-4999-8999-999999999999',
      secret: SECRET,
    });
    await expect(
      checkIn(db, {
        occurrenceId: OCC,
        userId: 'user_1',
        actorId: 'user_1',
        method: 'qr',
        token,
        secret: SECRET,
      }),
    ).rejects.toThrowError('invalid_checkin_token');
  });

  it('refuses to let one member redeem a QR on behalf of another', async () => {
    // The QR is displayed to everybody in the park; who is checked in is the
    // session cookie on the request, never a field in the form.
    const db = fakeDb([[open]]);
    await expect(
      checkIn(db, {
        occurrenceId: OCC,
        userId: 'victim',
        actorId: 'attacker',
        method: 'qr',
        token: issueCheckinToken({ occurrenceId: OCC, secret: SECRET }),
        secret: SECRET,
      }),
    ).rejects.toThrowError('not_organizer');
    expect(db.statements).toHaveLength(0);
  });

  it('scores a QR check-in inside the geofence, and awards once', async () => {
    const db = fakeDb([
      [{ ...open, distance_m: 40 }],
      [{ n: 0 }], // no awards yet today
      [{ id: 'checkin_qr' }],
      [{ points: 2 }],
    ]);
    await expect(
      checkIn(db, {
        occurrenceId: OCC,
        userId: 'user_1',
        actorId: 'user_1',
        method: 'qr',
        token: issueCheckinToken({ occurrenceId: OCC, secret: SECRET }),
        secret: SECRET,
        lat: 42.68,
        lon: 23.34,
      }),
    ).resolves.toMatchObject({ outcome: 'scored', distanceM: 40, pointsAwarded: 2 });

    const text = db.statements.map((st) => st.sql).join('\n');
    expect(text).toMatch(/INSERT INTO points_ledger/i);
    // The award is keyed by occurrence, so a weekly regular is paid every week
    // and a retry is paid once.
    expect(db.statements.at(-1)?.params).toContain(`session_attended:${OCC}:user_1`);
  });

  it('records but does not pay a QR check-in outside the geofence', async () => {
    const db = fakeDb([[{ ...open, distance_m: 5000 }], [{ id: 'checkin_far' }]]);
    await expect(
      checkIn(db, {
        occurrenceId: OCC,
        userId: 'user_1',
        actorId: 'user_1',
        method: 'qr',
        token: issueCheckinToken({ occurrenceId: OCC, secret: SECRET }),
        secret: SECRET,
        lat: 43.2,
        lon: 24.5,
      }),
    ).resolves.toMatchObject({
      outcome: 'unscored_out_of_range',
      distanceM: 5000,
      pointsAwarded: 0,
    });
    // Attendance is a fact and is always recorded; only the payment stops.
    expect(db.statements[1]?.sql).toMatch(/INSERT INTO play_session_checkins/i);
    expect(db.statements.map((st) => st.sql).join('\n')).not.toMatch(/points_ledger/i);
  });

  it('records but does not pay when no location was offered', async () => {
    const db = fakeDb([[{ ...open, distance_m: null }], [{ id: 'checkin_nogeo' }]]);
    await expect(
      checkIn(db, {
        occurrenceId: OCC,
        userId: 'user_1',
        actorId: 'user_1',
        method: 'qr',
        token: issueCheckinToken({ occurrenceId: OCC, secret: SECRET }),
        secret: SECRET,
      }),
    ).resolves.toMatchObject({ outcome: 'unscored_no_location', pointsAwarded: 0 });
  });

  it('stops paying at the daily cap without refusing the check-in', async () => {
    const db = fakeDb([
      [{ ...open, distance_m: 20 }],
      [{ n: ATTENDANCE_AWARDS_PER_DAY }],
      [{ id: 'checkin_capped' }],
    ]);
    await expect(
      checkIn(db, {
        occurrenceId: OCC,
        userId: 'user_1',
        actorId: 'user_1',
        method: 'qr',
        token: issueCheckinToken({ occurrenceId: OCC, secret: SECRET }),
        secret: SECRET,
        lat: 42.68,
        lon: 23.34,
      }),
    ).resolves.toMatchObject({ outcome: 'unscored_daily_cap', pointsAwarded: 0 });
    // The attendance still landed.
    expect(db.statements[2]?.sql).toMatch(/INSERT INTO play_session_checkins/i);
  });

  it('never sends the raw coordinates anywhere but the distance query', async () => {
    const db = fakeDb([
      [{ ...open, distance_m: 40 }],
      [{ n: 0 }],
      [{ id: 'checkin_qr' }],
      [{ points: 2 }],
    ]);
    await checkIn(db, {
      occurrenceId: OCC,
      userId: 'user_1',
      actorId: 'user_1',
      method: 'qr',
      token: issueCheckinToken({ occurrenceId: OCC, secret: SECRET }),
      secret: SECRET,
      lat: 42.681234,
      lon: 23.341234,
    });
    // Where a named person stands on a Tuesday evening is the most sensitive
    // record this project could keep. The coordinates may appear ONLY in the
    // statement that turns them into a distance.
    const writes = db.statements.filter((st) => /INSERT|UPDATE/i.test(st.sql));
    for (const write of writes) {
      expect(write.params).not.toContain(42.681234);
      expect(write.params).not.toContain(23.341234);
    }
  });

  it('evaluates the time window in SQL, not against the app clock', async () => {
    const db = fakeDb([[{ ...open, within_window: false }]]);
    await expect(
      checkIn(db, { occurrenceId: 'occ_1', userId: 'user_1', actorId: 'user_1' }),
    ).rejects.toThrowError('checkin_window_closed');
    // Clock skew between the web container and the database must not be able to
    // open check-in early or hold it open late.
    expect(db.statements[0]?.sql).toMatch(/now\(\)/);
  });

  it('refuses a cancelled occurrence, and is idempotent on a repeat', async () => {
    const cancelled = fakeDb([[{ ...open, status: 'cancelled' }]]);
    await expect(
      checkIn(cancelled, { occurrenceId: 'occ_1', userId: 'user_1', actorId: 'user_1' }),
    ).rejects.toThrowError('occurrence_cancelled');

    // ON CONFLICT DO NOTHING returned nothing → already checked in.
    const repeat = fakeDb([[open], [], [{ id: 'checkin_1' }]]);
    await expect(
      checkIn(repeat, { occurrenceId: 'occ_1', userId: 'user_1', actorId: 'user_1' }),
    ).resolves.toMatchObject({
      checkinId: 'checkin_1',
      created: false,
      // Reporting a repeat as freshly scored would be a lie to the UI.
      outcome: 'unscored_already',
      pointsAwarded: 0,
    });
  });
});

describe('rsvp', () => {
  it('redraws the arrival ticket only for a re-join', async () => {
    const db = fakeDb([
      [{ status: 'scheduled', started: false }],
      // No prior row: this is a first join.
      [],
      [{ id: 'rsvp_1' }],
      [{ position: 3, rsvp_status: 'waitlisted', seq: 7 }],
    ]);
    await expect(rsvp(db, 'user_1', 'occ_1')).resolves.toEqual({
      rsvpId: 'rsvp_1',
      position: 3,
      status: 'waitlisted',
      seq: 7,
      joined: true,
    });
    const insert = db.statements[2]?.sql ?? '';
    // A double-submitted form keeps its place; only a withdrawal sends someone
    // to the back of the queue.
    expect(insert).toMatch(/WHEN play_session_rsvps\.state = 'withdrawn'/i);
    expect(insert).toMatch(/nextval\('play_session_rsvp_seq'\)/i);
    // Joining a full session is a waitlist place, not an error.
    expect(insert).not.toMatch(/capacity/i);
  });

  it('reports joined:false for an idempotent repeat, so no second mail goes', async () => {
    const db = fakeDb([
      [{ status: 'scheduled', started: false }],
      // Already active — a double-submitted form, not a new sign-up.
      [{ state: 'active' }],
      [{ id: 'rsvp_1' }],
      [{ position: 1, rsvp_status: 'going', seq: 7 }],
    ]);
    await expect(rsvp(db, 'user_1', 'occ_1')).resolves.toMatchObject({ joined: false });
    // The prior state is read under a row lock, which also serialises the two
    // halves of a double submit.
    expect(db.statements[1]?.sql ?? '').toMatch(/FOR UPDATE/i);
  });

  it('treats a re-join after withdrawing as a new sign-up', async () => {
    const db = fakeDb([
      [{ status: 'scheduled', started: false }],
      [{ state: 'withdrawn' }],
      [{ id: 'rsvp_1' }],
      [{ position: 4, rsvp_status: 'waitlisted', seq: 12 }],
    ]);
    // A fresh ticket means a fresh confirmation: the notification ledger is
    // keyed by seq precisely so this is not swallowed.
    await expect(rsvp(db, 'user_1', 'occ_1')).resolves.toMatchObject({
      joined: true,
      seq: 12,
    });
  });

  it('refuses a cancelled or already-started occurrence', async () => {
    const cancelled = fakeDb([[{ status: 'cancelled', started: false }]]);
    await expect(rsvp(cancelled, 'user_1', 'occ_1')).rejects.toThrowError('occurrence_cancelled');

    const started = fakeDb([[{ status: 'scheduled', started: true }]]);
    await expect(rsvp(started, 'user_1', 'occ_1')).rejects.toThrowError('occurrence_started');

    const missing = fakeDb([[]]);
    await expect(rsvp(missing, 'user_1', 'occ_1')).rejects.toThrowError('occurrence_not_found');
  });

  it('reports withdrawing from something you are not attending', async () => {
    const db = fakeDb([[]]);
    await expect(withdraw(db, 'user_1', 'occ_1')).rejects.toThrowError('not_attending');
    // Withdrawal only ever touches the caller's own row. Statement 0 is the
    // "who is going" read taken before the update, so the UPDATE is next.
    const update = db.statements.find((st) => /UPDATE play_session_rsvps/i.test(st.sql));
    expect(update?.sql).toMatch(/user_id = \$\d+ AND state = 'active'/i);
  });
});

describe('attendanceCounts', () => {
  it('reads capacity from the series, not from the position rows', async () => {
    // With nobody signed up there are no position rows, so max(capacity) over
    // them would be NULL — indistinguishable from "unlimited".
    const db = fakeDb([[{ going: 0, waitlisted: 0, capacity: 12 }]]);
    await expect(attendanceCounts(db, 'occ_1')).resolves.toEqual({
      going: 0,
      waitlisted: 0,
      capacity: 12,
    });
    expect(db.statements[0]?.sql).toMatch(/s\.capacity/i);
  });

  it('reports an unlimited session as null capacity', async () => {
    const db = fakeDb([[{ going: 4, waitlisted: 0, capacity: null }]]);
    await expect(attendanceCounts(db, 'occ_1')).resolves.toEqual({
      going: 4,
      waitlisted: 0,
      capacity: null,
    });
  });
});

describe('SessionError', () => {
  it('carries a code and no user input', () => {
    const error = new SessionError('invalid_sport');
    expect(error.code).toBe('invalid_sport');
    expect(error.message).toBe('invalid_sport');
  });
});
