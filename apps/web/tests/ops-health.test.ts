import { renderSql, type SQL } from '@sportkarta/db';
import { describe, expect, it } from 'vitest';

import {
  classifyHeartbeat,
  HEARTBEAT_STALE_SECONDS,
  jobErrorMessage,
  mailOutcomes,
  NEVER_BEATEN_GRACE_SECONDS,
  queueHealth,
  readWorkerHeartbeat,
  summarizeMailOutputs,
  workerRequired,
} from '@/lib/ops-health';

/**
 * Operator visibility (pre-launch audit findings 57, 90, 133), at the
 * statement and pure-function level. pg-boss's schema does not exist in the
 * CI database (no worker runs there), so the reads are proven against scripted
 * answers; the heartbeat's end-to-end behaviour is the worker's boot ping.
 */

function fakeDb(responses: Record<string, unknown>[][] = []) {
  const statements: { sql: string; params: unknown[] }[] = [];
  const queue = [...responses];
  return {
    statements,
    execute(query: SQL) {
      statements.push(renderSql(query));
      return Promise.resolve({ rows: queue.shift() ?? [] });
    },
  };
}

describe('classifyHeartbeat', () => {
  it('is ok while the last beat is recent', () => {
    expect(classifyHeartbeat(0, 5)).toBe('ok');
    expect(classifyHeartbeat(HEARTBEAT_STALE_SECONDS, 99_999)).toBe('ok');
  });

  it('is stale once the last beat is old — even right after this process started', () => {
    // An OLD beat is a worker that stopped, not a boot race: a deploy made
    // while the worker is dead must not pass the gate on a grace period.
    expect(classifyHeartbeat(HEARTBEAT_STALE_SECONDS + 1, 1)).toBe('stale');
  });

  it('gives a database that has never seen a beat a grace period, then calls it stale', () => {
    expect(classifyHeartbeat(null, 0)).toBe('starting');
    expect(classifyHeartbeat(null, NEVER_BEATEN_GRACE_SECONDS - 1)).toBe('starting');
    expect(classifyHeartbeat(null, NEVER_BEATEN_GRACE_SECONDS)).toBe('stale');
  });
});

describe('workerRequired', () => {
  it('is production only, so `pnpm dev` without a worker stays healthy', () => {
    expect(workerRequired({ NODE_ENV: 'production' })).toBe(true);
    expect(workerRequired({ NODE_ENV: 'development' })).toBe(false);
    expect(workerRequired({})).toBe(false);
  });
});

describe('readWorkerHeartbeat', () => {
  it('reads the last COMPLETED health.ping from the live table and the archive', async () => {
    const db = fakeDb([
      [{ present: true }],
      [{ last_beat: new Date('2026-09-30T10:00:00Z'), age_seconds: 42.4 }],
    ]);
    const beat = await readWorkerHeartbeat(db, 3600);

    expect(beat).toEqual({ status: 'ok', lastBeatAt: '2026-09-30T10:00:00.000Z', ageSeconds: 42 });
    const text = db.statements[1]?.sql ?? '';
    expect(text).toMatch(/pgboss\.job/);
    expect(text).toMatch(/pgboss\.archive/);
    expect(text).toMatch(/state = 'completed'/);
    // Age on the DATABASE clock, not the web container's.
    expect(text).toMatch(/now\(\) - last_beat/);
    expect(db.statements[1]?.params).toContain('health.ping');
  });

  it('does not query pg-boss tables that do not exist', async () => {
    const db = fakeDb([[{ present: false }]]);
    const beat = await readWorkerHeartbeat(db, 10);

    expect(beat.status).toBe('starting');
    expect(db.statements).toHaveLength(1);
  });

  it('turns a never-beaten worker stale after the grace period', async () => {
    const db = fakeDb([[{ present: true }], [{ last_beat: null, age_seconds: null }]]);
    const beat = await readWorkerHeartbeat(db, NEVER_BEATEN_GRACE_SECONDS + 1);
    expect(beat).toEqual({ status: 'stale', lastBeatAt: null, ageSeconds: null });
  });
});

describe('jobErrorMessage', () => {
  it('reads a thrown error and a timeout, scrubbed', () => {
    expect(jobErrorMessage({ name: 'Error', message: 'boom', stack: 'at x' })).toBe('boom');
    expect(jobErrorMessage({ value: { message: 'job failed by timeout in active state' } })).toBe(
      'job failed by timeout in active state',
    );
    expect(
      jobErrorMessage({ message: 'connect postgres://sk:secret@db:5432/sk refused for a@b.org' }),
    ).toBe('connect postgres://[redacted]@db:5432/sk refused for [email]');
  });

  it('is null for a report or nothing', () => {
    expect(jobErrorMessage({ report: 'done' })).toBeNull();
    expect(jobErrorMessage(null)).toBeNull();
    expect(jobErrorMessage('text')).toBeNull();
  });
});

describe('summarizeMailOutputs', () => {
  it('sums per-recipient failures that did NOT fail the job', () => {
    const outcomes = summarizeMailOutputs([
      { name: 'session.notify', state: 'completed', output: { sent: 3, failed: 1, skipped: 0 } },
      { name: 'session.notify', state: 'completed', output: { sent: 2, failed: 0, skipped: 1 } },
      {
        name: 'session.reminders',
        state: 'completed',
        output: {
          reminder_24h: { candidates: 4, sent: 4, skipped: 0, failed: 0 },
          reminder_2h: { candidates: 2, sent: 0, skipped: 0, failed: 2 },
        },
      },
      { name: 'digest.weekly', state: 'failed', output: { message: 'SMTP down' } },
      { name: 'passport.evaluate', state: 'completed', output: null },
    ]);

    expect(outcomes).toEqual([
      { queue: 'session.notify', jobs: 2, failedJobs: 0, sent: 5, failed: 1 },
      { queue: 'session.reminders', jobs: 1, failedJobs: 0, sent: 4, failed: 2 },
      { queue: 'digest.weekly', jobs: 1, failedJobs: 1, sent: 0, failed: 0 },
    ]);
  });

  it('ignores malformed outputs rather than throwing', () => {
    const outcomes = summarizeMailOutputs([
      { name: 'session.notify', state: 'completed', output: { sent: 'many', failed: -3 } },
      { name: 'session.reminders', state: 'completed', output: { reminder_2h: 'x' } },
    ]);
    expect(outcomes[0]).toMatchObject({ sent: 0, failed: 0, jobs: 1 });
    expect(outcomes[1]).toMatchObject({ sent: 0, failed: 0, jobs: 1 });
  });
});

describe('queueHealth / mailOutcomes', () => {
  it('reads backlog from the live table only and hides pg-boss internals', async () => {
    const db = fakeDb([
      [{ present: true }],
      [
        {
          name: 'session.notify',
          due: '3',
          oldest_due_seconds: 1800.2,
          active: '0',
          completed_24h: '10',
          failed_24h: '1',
          last_completed: new Date('2026-09-30T09:00:00Z'),
          last_failed: new Date('2026-09-30T08:00:00Z'),
          last_error_output: { message: 'relay refused ivan@example.org' },
        },
      ],
    ]);
    const rows = await queueHealth(db);

    expect(rows[0]).toMatchObject({
      name: 'session.notify',
      due: 3,
      oldestDueSeconds: 1800,
      failed24h: 1,
      lastError: 'relay refused [email]',
    });
    const text = db.statements[1]?.sql ?? '';
    expect(text).toMatch(/left\(q\.name, 8\) <> '__pgboss'/);
    // The backlog CTE reads pgboss.job alone — an expired job in the archive is
    // history, not a queue.
    const waiting = text.slice(text.indexOf('waiting AS'), text.indexOf('outcomes AS'));
    expect(waiting).toMatch(/FROM pgboss\.job/);
    expect(waiting).not.toMatch(/archive/);
  });

  it('reports every mail queue, even with no pg-boss schema', async () => {
    const outcomes = await mailOutcomes(fakeDb([[{ present: false }]]));
    expect(outcomes.map((o) => o.queue)).toEqual([
      'session.notify',
      'session.reminders',
      'digest.weekly',
    ]);
  });
});
