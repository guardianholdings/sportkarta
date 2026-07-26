import { materializeSessions, refreshStats } from '@sportkarta/db';
import { createMailer } from '@sportkarta/lib/email';
import { runImport } from '@sportkarta/import-osm';

import { runWeeklyDigest } from './digest-job.js';
import { runOpenDataDump } from './opendata-dump-job.js';
import {
  runBadgeBackfill,
  runPassportEvaluate,
  runStreakFreezes,
  type PassportEvaluateJobData,
} from './passport-job.js';
import {
  NOTIFY_REASONS,
  runSessionNotify,
  runSessionReminders,
  type SessionNotifyJobData,
} from './session-mail-job.js';
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
const SESSION_REMINDERS_QUEUE = 'session.reminders';
const DIGEST_WEEKLY_QUEUE = 'digest.weekly';
const OPENDATA_DUMP_QUEUE = 'opendata.dump';
/**
 * Badge evaluation (A1). `passport.evaluate` is enqueued by the web app after a
 * contribution or check-in commits; `badges.backfill` is the one-shot that
 * records the retroactive back catalogue for everyone who already has points.
 */
const PASSPORT_EVALUATE_QUEUE = 'passport.evaluate';
const BADGE_BACKFILL_QUEUE = 'badges.backfill';
/** Streak freezes (A4): applied once a week has closed, silently. */
const STREAK_FREEZE_QUEUE = 'streaks.freeze';

interface ImportOsmJobData {
  dryRun?: boolean;
}

/** Materialize one series (after create/edit), or all of them (the schedule). */
interface SessionMaterializeJobData {
  sessionId?: string;
}

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
  await boss.createQueue(SESSION_REMINDERS_QUEUE);
  await boss.createQueue(DIGEST_WEEKLY_QUEUE);
  await boss.createQueue(OPENDATA_DUMP_QUEUE);
  await boss.createQueue(PASSPORT_EVALUATE_QUEUE);
  await boss.createQueue(BADGE_BACKFILL_QUEUE);
  await boss.createQueue(STREAK_FREEZE_QUEUE);

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

  // Session mail (Stage 4.2). The web app enqueues here on RSVP, withdrawal
  // (which promotes somebody) and cancellation; the sending itself lives in
  // session-mail-job.ts. The payload carries occurrence ids and ACCOUNT ids,
  // never an address — addresses are read from the live table at send time, so
  // no mailing list is ever left sitting in an archived queue row.
  //
  // Idempotency is play_session_notifications': the claim goes in before the
  // send, in the same transaction, so a retry cannot mail anyone twice.
  await boss.work(SESSION_NOTIFY_QUEUE, { batchSize: 1 }, async (jobs) => {
    const mailer = createMailer(process.env);
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
    let last: Awaited<ReturnType<typeof runSessionNotify>> | undefined;
    for (const job of jobs) {
      const data = (job.data ?? {}) as SessionNotifyJobData;
      last = await runSessionNotify(data, { mailer, siteUrl });
      // Counts and the pinned reason only. `reason` is validated against the
      // vocabulary before it is logged: an unbounded string from a job payload
      // interpolated into a log line is how a log gets forged.
      const reason = data.reason && data.reason in NOTIFY_REASONS ? data.reason : 'unknown';
      console.log(
        `[worker] ${SESSION_NOTIFY_QUEUE} job ${job.id}: reason=${reason} ` +
          `${String(last.candidates)} candidate(s), ${String(last.sent)} sent, ` +
          `${String(last.skipped)} already told, ${String(last.failed)} failed`,
      );
    }
    return last;
  });

  // T-24h and T-2h reminders (Stage 4.2). Every ten minutes — but the query is
  // "starting within the lead time and NOT YET TOLD", not "starting in 24 h ± 5
  // min", so the schedule is a heartbeat rather than a window that can be
  // missed. A worker that was down all afternoon catches up on its next tick
  // instead of silently skipping everyone whose window it slept through.
  await boss.work(SESSION_REMINDERS_QUEUE, { batchSize: 1 }, async (jobs) => {
    const mailer = createMailer(process.env);
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
    let last: Awaited<ReturnType<typeof runSessionReminders>> | undefined;
    for (const job of jobs) {
      last = await runSessionReminders({ mailer, siteUrl });
      for (const [kind, report] of Object.entries(last)) {
        // Quiet ticks are the common case; only say something when there was
        // something to say, or the log becomes 144 empty lines a day.
        if (report.candidates === 0) continue;
        console.log(
          `[worker] ${SESSION_REMINDERS_QUEUE} job ${job.id} ${kind}: ` +
            `${String(report.sent)} sent, ${String(report.skipped)} already told, ` +
            `${String(report.failed)} failed`,
        );
      }
    }
    return last;
  });
  await boss.schedule(SESSION_REMINDERS_QUEUE, '*/10 * * * *');

  // Weekly city digest (Stage 4.4). Monday 08:00 EUROPE/SOFIA, not UTC: the
  // send time is a wall-clock promise to a reader, so it must not drift by an
  // hour twice a year. pg-boss passes tz to cron-parser, which is why luxon is
  // in the lockfile at all.
  //
  // The job and /sedmitsata/[city] call the SAME query (weeklyDigest), and the
  // send is idempotent per subscriber per week through digest_sends — so a
  // manual re-run, a retry or a second worker cannot mail anyone twice.
  await boss.work(DIGEST_WEEKLY_QUEUE, { batchSize: 1 }, async (jobs) => {
    const mailer = createMailer(process.env);
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
    let last: Awaited<ReturnType<typeof runWeeklyDigest>> | undefined;
    for (const job of jobs) {
      last = await runWeeklyDigest({ mailer, siteUrl });
      // Counts only — never an address (no PII in logs).
      console.log(
        `[worker] ${DIGEST_WEEKLY_QUEUE} job ${job.id}: ${String(last.subscribers)} subscriber(s), ` +
          `${String(last.sent)} sent, ${String(last.skipped)} skipped, ${String(last.failed)} failed`,
      );
    }
    return last;
  });
  await boss.schedule(DIGEST_WEEKLY_QUEUE, '0 8 * * 1', {}, { tz: 'Europe/Sofia' });

  // Nightly open-data bulk dump (Stage 6.1). 03:40 EUROPE/SOFIA — deliberately
  // clear of the backup sidecar's 03:30 pg_dump, so the two are not competing
  // for the same disk, and in civil time so the version in the path is the day
  // a person in Sofia would call it.
  //
  // Idempotent by construction: every dataset's ORDER BY is total, so a re-run
  // on the same day rewrites byte-identical files under the same version. The
  // job is safe to trigger by hand from the admin screen when something looks
  // wrong, which is the point of making it boring.
  await boss.work(OPENDATA_DUMP_QUEUE, { batchSize: 1 }, async (jobs) => {
    let last: Awaited<ReturnType<typeof runOpenDataDump>> | undefined;
    for (const job of jobs) {
      last = await runOpenDataDump();
      // Counts, a version and a byte total — a dump is a public artifact and
      // names nobody, so there is nothing here to withhold.
      console.log(
        `[worker] ${OPENDATA_DUMP_QUEUE} job ${job.id}: version ${last.version}, ` +
          `${String(last.written)} file(s) written, ${String(last.failed)} failed, ` +
          `${String(last.bytes)} bytes, ${String(last.prunedVersions)} old version(s) pruned`,
      );
    }
    return last;
  });
  await boss.schedule(OPENDATA_DUMP_QUEUE, '40 3 * * *', {}, { tz: 'Europe/Sofia' });

  // Badge evaluation (A1). Until now `recordEarnedBadges` ran from exactly one
  // place — a /pasport render — so a badge did not exist until the member
  // personally looked. The web app enqueues here after a contribution or a
  // check-in COMMITS; see apps/worker/src/passport-job.ts for why this must not
  // be inlined into those transactions.
  await boss.work(PASSPORT_EVALUATE_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const report = await runPassportEvaluate((job.data ?? {}) as PassportEvaluateJobData);
      if (report.recorded > 0) {
        // Counts only — an account id identifies a person even with no name.
        console.log(
          `[worker] ${PASSPORT_EVALUATE_QUEUE} job ${job.id}: ${String(report.recorded)} badge(s) recorded`,
        );
      }
    }
  });

  // The retroactive back catalogue, once. Every badge it writes is historical
  // and therefore recorded already-seen, so nobody wakes up to eight
  // simultaneous "new" badges. Sent on every boot rather than scheduled: it is
  // idempotent (ON CONFLICT DO NOTHING), it is the only thing that catches a
  // member whose badges were earned while this feature did not exist, and one
  // pass over the ledger's distinct users is cheap next to getting it wrong.
  await boss.work(BADGE_BACKFILL_QUEUE, async () => {
    const report = await runBadgeBackfill();
    console.log(
      `[worker] ${BADGE_BACKFILL_QUEUE} evaluated ${String(report.evaluated)} member(s), ` +
        `${String(report.recorded)} badge(s) recorded, ${String(report.failed)} failed`,
    );
  });
  await boss.send(BADGE_BACKFILL_QUEUE, {});

  // Streak freezes (A4). Monday 04:20 EUROPE/SOFIA — after the civil week has
  // closed and well clear of the 03:30 backup and the 03:40 open-data dump. The
  // timezone is the point: a week boundary is a wall-clock promise, so a UTC
  // cron would apply freezes an hour early or late for half the year and
  // occasionally decide the wrong week had just closed.
  await boss.work(STREAK_FREEZE_QUEUE, async () => {
    const report = await runStreakFreezes();
    console.log(
      `[worker] ${STREAK_FREEZE_QUEUE} considered ${String(report.evaluated)} member(s), ` +
        `${String(report.recorded)} week(s) forgiven, ${String(report.failed)} failed`,
    );
  });
  await boss.schedule(STREAK_FREEZE_QUEUE, '20 4 * * 1', {}, { tz: 'Europe/Sofia' });

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
