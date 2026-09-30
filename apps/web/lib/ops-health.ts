import { sql, type SQL } from '@sportkarta/db';
import { scrubText } from '@sportkarta/lib/error-report';

import { HEALTH_QUEUE } from './admin-boss';

/**
 * Operator visibility (pre-launch audit findings 57, 90 and 133).
 *
 * Everything here is READ from pg-boss's own tables — pgboss.job (live and
 * recently finished jobs), pgboss.archive (the last seven days), pgboss.queue
 * and pgboss.schedule. There is no health table of our own: the queue already
 * records when each job was created, started, finished and how it ended, and a
 * second copy would only be a second thing to keep in sync.
 *
 * The worker heartbeat is the `health.ping` job (apps/worker/src/index.ts): the
 * worker schedules one every five minutes and sends one as the LAST step of
 * booting, so "the last ping that COMPLETED" answers "is a worker alive and
 * fully started?" without the worker writing anything new.
 *
 * pgboss.* may not exist at all (a fresh database nobody has enqueued into), so
 * every reader checks for the tables first rather than letting a missing
 * relation surface as "database unreachable".
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Twenty minutes: four missed five-minute beats, well past any slow boot. */
export const HEARTBEAT_STALE_SECONDS = 20 * 60;

/**
 * How long a freshly started web process gives a worker that has NEVER beaten.
 * Only the never-beaten case gets it: a brand-new database, or the first deploy
 * of the heartbeat itself. A beat that exists and is old is not a boot race —
 * it is a worker that stopped — and waiting would only hide it.
 */
export const NEVER_BEATEN_GRACE_SECONDS = 10 * 60;

export type WorkerStatus = 'ok' | 'starting' | 'stale' | 'unknown';

export interface WorkerHeartbeat {
  status: WorkerStatus;
  /** ISO time the last ping completed, or null when none ever did. */
  lastBeatAt: string | null;
  /** Seconds since then, on the DATABASE clock. */
  ageSeconds: number | null;
}

/** Pure: the verdict for a heartbeat age. */
export function classifyHeartbeat(
  ageSeconds: number | null,
  webUptimeSeconds: number,
): Exclude<WorkerStatus, 'unknown'> {
  if (ageSeconds !== null) return ageSeconds <= HEARTBEAT_STALE_SECONDS ? 'ok' : 'stale';
  return webUptimeSeconds < NEVER_BEATEN_GRACE_SECONDS ? 'starting' : 'stale';
}

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** True when pg-boss has installed its schema in this database. */
export async function pgBossInstalled(db: SqlRunner): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT to_regclass('pgboss.job') IS NOT NULL
       AND to_regclass('pgboss.archive') IS NOT NULL AS present
  `);
  return result.rows[0]?.present === true;
}

export async function readWorkerHeartbeat(
  db: SqlRunner,
  webUptimeSeconds: number,
): Promise<WorkerHeartbeat> {
  let lastBeatAt: string | null = null;
  let ageSeconds: number | null = null;
  if (await pgBossInstalled(db)) {
    // GREATEST ignores NULLs, so either table alone is enough. Completed pings
    // move to the archive after twelve hours, which is why both are read.
    const result = await db.execute(sql`
      SELECT last_beat, extract(epoch FROM now() - last_beat)::float8 AS age_seconds
      FROM (
        SELECT GREATEST(
          (SELECT max(completed_on) FROM pgboss.job
            WHERE name = ${HEALTH_QUEUE} AND state = 'completed'),
          (SELECT max(completed_on) FROM pgboss.archive
            WHERE name = ${HEALTH_QUEUE} AND state = 'completed')
        ) AS last_beat
      ) beat
    `);
    const row = result.rows[0];
    lastBeatAt = toIso(row?.last_beat);
    ageSeconds = lastBeatAt === null ? null : toNumber(row?.age_seconds);
  }
  return {
    status: classifyHeartbeat(ageSeconds, webUptimeSeconds),
    lastBeatAt,
    ageSeconds: ageSeconds === null ? null : Math.max(0, Math.round(ageSeconds)),
  };
}

/**
 * Whether a stale worker makes /api/health fail.
 *
 * Production only. There the worker is part of the deployment and is the sole
 * sender of session mail, so a dead one must turn the deploy gate and the web
 * container's healthcheck red. In development and the e2e suite it is optional
 * (`pnpm dev` does not start it), and a health check that failed ten minutes
 * into every local session would teach everybody to ignore it.
 */
export function workerRequired(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV === 'production';
}

/**
 * The human-readable reason a job failed, from pg-boss's `output`.
 *
 * A handler that throws is stored as the serialised error ({ name, message,
 * stack }); a job that timed out as `{ value: { message } }`. Only the message
 * is kept — never the stack — and it is scrubbed, because a Postgres error can
 * quote a row and a connection error can quote its connection string.
 */
export function jobErrorMessage(output: unknown): string | null {
  if (typeof output !== 'object' || output === null) return null;
  const direct = (output as { message?: unknown }).message;
  const nested = (output as { value?: { message?: unknown } | null }).value?.message;
  const message = typeof direct === 'string' ? direct : typeof nested === 'string' ? nested : null;
  return message ? scrubText(message).slice(0, 500) : null;
}

export interface QueueHealthRow {
  name: string;
  /** Jobs whose start time has come and that nobody has picked up. */
  due: number;
  /** How long the oldest of those has been waiting, in seconds. */
  oldestDueSeconds: number | null;
  active: number;
  /** Jobs that threw and are waiting for pg-boss's next attempt. */
  retrying: number;
  completed24h: number;
  failed24h: number;
  lastCompletedAt: string | null;
  lastFailedAt: string | null;
  /** The latest failure's message — a final failure or a pending retry. */
  lastError: string | null;
}

export async function queueHealth(db: SqlRunner): Promise<QueueHealthRow[]> {
  if (!(await pgBossInstalled(db))) return [];
  // Waiting and running are read from the LIVE table only: the archive also
  // holds jobs that expired unrun, and those are history, not a backlog.
  const result = await db.execute(sql`
    WITH finished AS (
      SELECT name, state, completed_on, output FROM pgboss.job
        WHERE state IN ('completed', 'failed')
      UNION ALL
      SELECT name, state, completed_on, output FROM pgboss.archive
        WHERE state IN ('completed', 'failed')
    ),
    waiting AS (
      SELECT name,
             count(*) FILTER (WHERE state IN ('created', 'retry') AND start_after <= now()) AS due,
             extract(epoch FROM now() - min(start_after)
               FILTER (WHERE state IN ('created', 'retry') AND start_after <= now()))::float8
               AS oldest_due_seconds,
             count(*) FILTER (WHERE state = 'active') AS active,
             count(*) FILTER (WHERE state = 'retry') AS retrying
      FROM pgboss.job
      GROUP BY name
    ),
    outcomes AS (
      SELECT name,
             count(*) FILTER (WHERE state = 'completed'
                                AND completed_on > now() - interval '24 hours') AS completed_24h,
             count(*) FILTER (WHERE state = 'failed'
                                AND completed_on > now() - interval '24 hours') AS failed_24h,
             max(completed_on) FILTER (WHERE state = 'completed') AS last_completed,
             max(completed_on) FILTER (WHERE state = 'failed') AS last_failed
      FROM finished
      GROUP BY name
    ),
    last_error AS (
      -- A job waiting to retry carries its error too (and no completed_on), so
      -- a mail relay that is refusing right now shows up before the retries
      -- run out rather than only after.
      SELECT DISTINCT ON (name) name, output
      FROM (
        SELECT name, output, completed_on AS failed_at FROM finished WHERE state = 'failed'
        UNION ALL
        SELECT name, output, started_on AS failed_at FROM pgboss.job
          WHERE state = 'retry' AND output IS NOT NULL
      ) failures
      ORDER BY name, failed_at DESC NULLS LAST
    )
    SELECT q.name, w.due, w.oldest_due_seconds, w.active, w.retrying,
           o.completed_24h, o.failed_24h, o.last_completed, o.last_failed,
           e.output AS last_error_output
    FROM pgboss.queue q
    LEFT JOIN waiting w ON w.name = q.name
    LEFT JOIN outcomes o ON o.name = q.name
    LEFT JOIN last_error e ON e.name = q.name
    WHERE left(q.name, 8) <> '__pgboss'
    ORDER BY q.name
  `);
  return result.rows.map((row) => {
    const oldest = toNumber(row.oldest_due_seconds);
    return {
      name: String(row.name),
      due: toNumber(row.due) ?? 0,
      oldestDueSeconds: oldest === null ? null : Math.max(0, Math.round(oldest)),
      active: toNumber(row.active) ?? 0,
      retrying: toNumber(row.retrying) ?? 0,
      completed24h: toNumber(row.completed_24h) ?? 0,
      failed24h: toNumber(row.failed_24h) ?? 0,
      lastCompletedAt: toIso(row.last_completed),
      lastFailedAt: toIso(row.last_failed),
      lastError: jobErrorMessage(row.last_error_output),
    };
  });
}

export interface ScheduleRow {
  name: string;
  cron: string;
  timezone: string | null;
  /** When a job for this queue was last created — by the schedule or by hand. */
  lastRunAt: string | null;
}

export interface Schedules {
  rows: ScheduleRow[];
  /** When pg-boss's cron monitor last ran; null if it never has. */
  cronCheckedAt: string | null;
}

export async function scheduleHealth(db: SqlRunner): Promise<Schedules> {
  if (!(await pgBossInstalled(db))) return { rows: [], cronCheckedAt: null };
  const result = await db.execute(sql`
    SELECT s.name, s.cron, s.timezone,
           GREATEST(
             (SELECT max(created_on) FROM pgboss.job j WHERE j.name = s.name),
             (SELECT max(created_on) FROM pgboss.archive a WHERE a.name = s.name)
           ) AS last_run
    FROM pgboss.schedule s
    ORDER BY s.name
  `);
  const cron = await db.execute(sql`SELECT max(cron_on) AS cron_on FROM pgboss.version`);
  return {
    rows: result.rows.map((row) => ({
      name: String(row.name),
      cron: String(row.cron),
      timezone: (row.timezone as string | null) ?? null,
      lastRunAt: toIso(row.last_run),
    })),
    cronCheckedAt: toIso(cron.rows[0]?.cron_on),
  };
}

/** The queues that send mail, and the report shape each one returns. */
export const MAIL_QUEUES = ['session.notify', 'session.reminders', 'digest.weekly'] as const;
export type MailQueue = (typeof MAIL_QUEUES)[number];

export interface MailOutcome {
  queue: MailQueue;
  /** Jobs that finished in the window. */
  jobs: number;
  /** Jobs that threw — nothing in them was sent, or it was rolled back. */
  failedJobs: number;
  /** Messages delivered, and recipients the job could not deliver to. */
  sent: number;
  failed: number;
}

function count(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/**
 * Pure: fold the mail jobs' outputs into per-queue totals.
 *
 * `session.notify` and `digest.weekly` return one report ({ sent, failed, … });
 * `session.reminders` returns one report PER REMINDER KIND. A per-recipient
 * failure does not fail the job (the rest of the batch still goes out), which
 * is exactly why this has to read the report rather than the job state.
 */
export function summarizeMailOutputs(
  rows: readonly { name: string; state: string; output: unknown }[],
): MailOutcome[] {
  const totals = new Map<MailQueue, MailOutcome>(
    MAIL_QUEUES.map((queue) => [queue, { queue, jobs: 0, failedJobs: 0, sent: 0, failed: 0 }]),
  );
  for (const row of rows) {
    const total = totals.get(row.name as MailQueue);
    if (!total) continue;
    total.jobs += 1;
    if (row.state === 'failed') {
      total.failedJobs += 1;
      continue;
    }
    if (typeof row.output !== 'object' || row.output === null) continue;
    const reports =
      row.name === 'session.reminders'
        ? Object.values(row.output as Record<string, unknown>)
        : [row.output];
    for (const report of reports) {
      if (typeof report !== 'object' || report === null) continue;
      total.sent += count((report as { sent?: unknown }).sent);
      total.failed += count((report as { failed?: unknown }).failed);
    }
  }
  return [...totals.values()];
}

export const MAIL_WINDOW_DAYS = 7;

export async function mailOutcomes(db: SqlRunner): Promise<MailOutcome[]> {
  if (!(await pgBossInstalled(db))) return summarizeMailOutputs([]);
  const names = sql.param([...MAIL_QUEUES]);
  const result = await db.execute(sql`
    SELECT name, state::text AS state, output FROM pgboss.job
      WHERE name = ANY(${names}::text[]) AND state IN ('completed', 'failed')
        AND completed_on > now() - make_interval(days => ${MAIL_WINDOW_DAYS})
    UNION ALL
    SELECT name, state::text AS state, output FROM pgboss.archive
      WHERE name = ANY(${names}::text[]) AND state IN ('completed', 'failed')
        AND completed_on > now() - make_interval(days => ${MAIL_WINDOW_DAYS})
  `);
  return summarizeMailOutputs(
    result.rows.map((row) => ({
      name: String(row.name),
      state: String(row.state),
      output: row.output,
    })),
  );
}
