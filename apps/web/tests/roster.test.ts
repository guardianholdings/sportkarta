import { renderSql, type SQL } from '@sportkarta/db';
import { describe, expect, it } from 'vitest';

import { SessionError } from '@/lib/sessions/errors';
import { occurrenceRoster } from '@/lib/sessions/roster';

/**
 * Roster logic at the statement level (Stage 4.3). The DB-backed companion is
 * db/src/sessions-roster.test.ts, which proves the same reads against the real
 * view and constraints.
 */

const OCC = '22222222-2222-4222-8222-222222222222';

function fakeDb(rows: Record<string, unknown>[][] = []) {
  const statements: { sql: string; params: unknown[] }[] = [];
  let index = 0;
  return {
    statements,
    execute(query: SQL) {
      statements.push(renderSql(query));
      const answer = rows[index] ?? [];
      index += 1;
      return Promise.resolve({ rows: answer });
    },
  };
}

const gateRow = (over: Record<string, unknown> = {}) => ({
  session_id: '33333333-3333-4333-8333-333333333333',
  title: 'Футбол в Лозенец',
  starts_at_local: '2099-03-02T18:00:00',
  cancelled: false,
  started: false,
  checkin_open: true,
  capacity: 10,
  is_organizer: true,
  is_admin: false,
  ...over,
});

describe('occurrenceRoster', () => {
  it('refuses an unknown occurrence', async () => {
    const db = fakeDb([[]]);
    await expect(occurrenceRoster(db, 'org_1', OCC)).rejects.toThrowError(
      new SessionError('occurrence_not_found'),
    );
  });

  it('refuses a viewer who is neither the organiser nor an admin', async () => {
    const db = fakeDb([[gateRow({ is_organizer: false, is_admin: false })]]);
    await expect(occurrenceRoster(db, 'member_1', OCC)).rejects.toThrowError(
      new SessionError('not_organizer'),
    );
    // The refusal must come from the database's answer, and the question must
    // have actually been asked: organiser on the row, admin from users.role.
    expect(db.statements[0]?.sql).toMatch(/organizer_id = \$/);
    expect(db.statements[0]?.sql).toMatch(/u\.role = 'admin'/);
    // Nothing after the gate: names were never read.
    expect(db.statements).toHaveLength(1);
  });

  it('admits an admin who is not the organiser', async () => {
    const db = fakeDb([[gateRow({ is_organizer: false, is_admin: true })], [], []]);
    const roster = await occurrenceRoster(db, 'admin_1', OCC);
    expect(roster.members).toEqual([]);
    expect(roster.walkIns).toEqual([]);
  });

  it('maps members in queue order with their check-in state, and walk-ins separately', async () => {
    const db = fakeDb([
      [gateRow()],
      [
        {
          user_id: 'member_1',
          display_name: 'Мария',
          position: '1',
          rsvp_status: 'going',
          checkin_method: 'qr',
        },
        {
          user_id: 'member_2',
          display_name: null,
          position: '2',
          rsvp_status: 'waitlisted',
          checkin_method: null,
        },
      ],
      [{ user_id: 'walkin_1', display_name: 'Георги', checkin_method: 'self' }],
    ]);
    const roster = await occurrenceRoster(db, 'org_1', OCC);

    expect(roster.members).toEqual([
      {
        userId: 'member_1',
        displayName: 'Мария',
        position: 1,
        rsvpStatus: 'going',
        checkinMethod: 'qr',
      },
      {
        userId: 'member_2',
        displayName: null,
        position: 2,
        rsvpStatus: 'waitlisted',
        checkinMethod: null,
      },
    ]);
    expect(roster.walkIns).toEqual([
      { userId: 'walkin_1', displayName: 'Георги', checkinMethod: 'self' },
    ]);
    // Checked in = one member + one walk-in.
    expect(roster.checkedInCount).toBe(2);

    // The member read joins the position view to users for names — the ONE
    // sanctioned crossing of the no-names line — and the walk-in read is
    // anti-joined on the view.
    expect(db.statements[1]?.sql).toMatch(/play_session_rsvp_positions/);
    expect(db.statements[1]?.sql).toMatch(/JOIN users/);
    expect(db.statements[2]?.sql).toMatch(/p\.rsvp_id IS NULL/);
  });

  it('reports a cancelled occurrence rather than hiding its roster', async () => {
    const db = fakeDb([[gateRow({ cancelled: true })], [], []]);
    const roster = await occurrenceRoster(db, 'org_1', OCC);
    expect(roster.cancelled).toBe(true);
  });

  it('reports the check-in window with the same expression checkIn evaluates', async () => {
    const db = fakeDb([[gateRow({ checkin_open: false })], [], []]);
    const roster = await occurrenceRoster(db, 'org_1', OCC);
    expect(roster.checkinOpen).toBe(false);
    // The window must be asked of the DATABASE's clock, like checkIn does —
    // not computed from the application's idea of now.
    expect(db.statements[0]?.sql).toMatch(/make_interval/);
    expect(db.statements[0]?.sql).toMatch(/now\(\)/);
  });
});
