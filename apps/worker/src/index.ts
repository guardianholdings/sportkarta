import { materializeSessions, refreshStats } from '@sportkarta/db';
import { runImport } from '@sportkarta/import-osm';
import { config } from 'dotenv';
import pg from 'pg';
import PgBoss from 'pg-boss';

// Dev only: repo-root .env (dist/ and src/ are both one level below the
// package root, so ../../../ lands on the repo root either way). Absent in
// production containers — no-op there.
config({ path: new URL('../../../.env', import.meta.url).pathname });

// Queue registry grows in Stage 1+ (imports, reminders, digests). Names are
// dot-namespaced: <domain>.<action>.
const HEALTH_QUEUE = 'health.ping';
const IMPORT_OSM_QUEUE = 'import.osm';
const STATS_REFRESH_QUEUE = 'stats.refresh';
const AUTH_CLEANUP_QUEUE = 'auth.cleanup';
const SESSION_MATERIALIZE_QUEUE = 'session.materialize';
const SESSION_NOTIFY_QUEUE = 'session.notify';

interface ImportOsmJobData {
  dryRun?: boolean;
}

/** Materialize one series (after create/edit), or all of them (the schedule). */
interface SessionMaterializeJobData {
  sessionId?: string;
}

/** See the SESSION_NOTIFY_QUEUE handler — this is Stage 4.2's contract, stubbed. */
interface SessionNotifyJobData {
  reason?: string;
  recipientCount?: number;
}

/**
 * Pinned vocabulary. Job data is arbitrary JSON from whoever enqueued it, and
 * an unbounded string interpolated into a log line is how a log gets forged.
 */
const NOTIFY_REASONS = new Set(['series_cancelled', 'occurrence_cancelled']);

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required (see .env.example)');
  }

  const boss = new PgBoss(databaseUrl);
  boss.on('error', (error) => {
    console.error('[pg-boss]', error);
  });

  // Separate pool for REFRESH MATERIALIZED VIEW CONCURRENTLY (pg-boss owns its
  // own connections). CONCURRENTLY runs in autocommit, so a pool is fine. An
  // idle-client error (DB restart/failover) must be handled or it crashes the
  // whole worker as an uncaught exception.
  const statsPool = new pg.Pool({ connectionString: databaseUrl });
  statsPool.on('error', (error) => {
    console.error('[stats-pool]', error);
  });

  await boss.start();
  await boss.createQueue(HEALTH_QUEUE);
  await boss.createQueue(IMPORT_OSM_QUEUE);
  await boss.createQueue(STATS_REFRESH_QUEUE);
  await boss.createQueue(AUTH_CLEANUP_QUEUE);
  await boss.createQueue(SESSION_MATERIALIZE_QUEUE);
  await boss.createQueue(SESSION_NOTIFY_QUEUE);

  await boss.work(HEALTH_QUEUE, async (jobs) => {
    for (const job of jobs) {
      console.log(`[worker] ${HEALTH_QUEUE} handled job ${job.id}`);
    }
  });

  // Triggered from the admin UI (Stage 1+) via boss.send('import.osm', {dryRun}).
  // dryRun defaults TRUE — a live import must be requested explicitly, matching
  // the operator gates in docs/ROADMAP.md §3. The report goes to stdout (docker
  // logs); the reviewable artifact for gates is the CLI run's committed report.
  await boss.work(IMPORT_OSM_QUEUE, { batchSize: 1 }, async (jobs) => {
    let lastReport = '';
    for (const job of jobs) {
      const data = (job.data ?? {}) as ImportOsmJobData;
      const dryRun = data.dryRun ?? true;
      console.log(`[worker] ${IMPORT_OSM_QUEUE} job ${job.id} starting (dryRun=${String(dryRun)})`);
      const { report } = await runImport({ dryRun });
      console.log(report);
      console.log(`[worker] ${IMPORT_OSM_QUEUE} job ${job.id} done`);
      lastReport = report;
    }
    // Returned value lands in pgboss.job.output — the admin report view reads it.
    return { report: lastReport };
  });

  // Refresh the /statistika + /api/stats materialized views. Scheduled every 15
  // minutes; also kicked once at startup so views are fresh right after deploy.
  await boss.work(STATS_REFRESH_QUEUE, async () => {
    console.log(`[worker] ${STATS_REFRESH_QUEUE} refreshing statistics views`);
    await refreshStats(statsPool);
    console.log(`[worker] ${STATS_REFRESH_QUEUE} done`);
  });
  await boss.schedule(STATS_REFRESH_QUEUE, '*/15 * * * *');
  await boss.send(STATS_REFRESH_QUEUE, {});

  // Data minimisation (Stage 3): `verifications.identifier` holds the email
  // address of anyone who asked for a sign-in code, including people who never
  // completed sign-up. Expired rows are personal data with no purpose left, so
  // they go nightly rather than accumulating into a list of addresses. Expired
  // sessions go the same way.
  await boss.work(AUTH_CLEANUP_QUEUE, async () => {
    const verifications = await statsPool.query(
      `DELETE FROM verifications WHERE expires_at < now()`,
    );
    const sessions = await statsPool.query(`DELETE FROM sessions WHERE expires_at < now()`);
    // Counts only — never the addresses themselves (no PII in logs).
    console.log(
      `[worker] ${AUTH_CLEANUP_QUEUE} removed ${verifications.rowCount ?? 0} expired code(s), ${sessions.rowCount ?? 0} expired session(s)`,
    );
  });
  await boss.schedule(AUTH_CLEANUP_QUEUE, '17 3 * * *');

  // Rolling 8-week occurrence window (Stage 4.1). Hourly, so the horizon moves
  // on its own; the job is idempotent (INSERT ... ON CONFLICT DO NOTHING against
  // a UNIQUE index), so an extra run costs a scan and creates nothing. Also sent
  // with a sessionId right after a series is created or edited, so a member does
  // not wait up to an hour to see their own session.
  await boss.work(SESSION_MATERIALIZE_QUEUE, { batchSize: 1 }, async (jobs) => {
    let last: Awaited<ReturnType<typeof materializeSessions>> | undefined;
    for (const job of jobs) {
      const data = (job.data ?? {}) as SessionMaterializeJobData;
      last = await materializeSessions(statsPool, { sessionId: data.sessionId });
      // Counts and slugs only — a title is user text and a session id is not
      // needed to act on this (no PII in logs).
      console.log(
        `[worker] ${SESSION_MATERIALIZE_QUEUE} job ${job.id}: ${String(last.seriesProcessed)} series, ` +
          `+${String(last.occurrencesCreated)} created, ${String(last.occurrencesCancelled)} cancelled, ` +
          `${String(last.occurrencesRemoved)} removed, ${String(last.failures.length)} failed`,
      );
      for (const failure of last.failures) {
        // The session id is included deliberately: a session is a public object,
        // not personal data, and without it an operator cannot find the broken
        // series. The code is a slug; the underlying message never appears.
        console.error(
          `[worker] ${SESSION_MATERIALIZE_QUEUE} series ${failure.sessionId} failed: ${failure.code}`,
        );
      }
    }
    return last;
  });
  await boss.schedule(SESSION_MATERIALIZE_QUEUE, '7 * * * *');
  await boss.send(SESSION_MATERIALIZE_QUEUE, {});

  // STUB — Stage 4.2 replaces this handler body with the real mail.
  //
  // Cancelling an occurrence or a series enqueues here with the number of people
  // who had RSVP'd (apps/web/lib/sessions/cancel.ts). Enqueuing now rather than
  // later means the call sites are already correct and 4.2 changes one function,
  // not five. The payload deliberately carries a COUNT and not a recipient list:
  // addresses belong in the query 4.2 will run against the live table at send
  // time, not in a job row that outlives the account it names.
  await boss.work(SESSION_NOTIFY_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const data = (job.data ?? {}) as SessionNotifyJobData;
      const reason = NOTIFY_REASONS.has(data.reason ?? '') ? data.reason : 'unknown';
      const recipients = Number.isFinite(data.recipientCount) ? Number(data.recipientCount) : 0;
      console.log(
        `[worker] ${SESSION_NOTIFY_QUEUE} job ${job.id}: would notify ` +
          `${String(recipients)} member(s) — reason=${String(reason)} ` +
          `(delivery lands in Stage 4.2)`,
      );
    }
  });

  console.log('[worker] started, listening for jobs');

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log(`[worker] ${signal} received, shutting down`);
      void boss
        .stop({ graceful: true })
        .then(() => statsPool.end())
        .then(() => {
          process.exit(0);
        });
    });
  }
}

main().catch((error: unknown) => {
  console.error('[worker] fatal', error);
  process.exit(1);
});
