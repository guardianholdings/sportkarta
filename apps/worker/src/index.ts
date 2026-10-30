import {
  eraseExpiredNotifierContacts,
  getDb,
  getPool,
  materializeClubClasses,
  materializeSessions,
  refreshStats,
} from '@sportkarta/db';
import {
  CLUB_ACTIVITY_QUEUE,
  CLUB_AUTOMATIONS_QUEUE,
  CLUB_BROADCASTS_QUEUE,
  CLUB_DIGEST_QUEUE,
  CLUB_EXPIRY_QUEUE,
  CLUB_HEALTH_QUEUE,
  CLUB_INTEGRATIONS_PRUNE_QUEUE,
  CLUB_LEADS_QUEUE,
  CLUB_MATERIALIZE_QUEUE,
  CLUB_NOTIFY_QUEUE,
  CLUB_PAYMENT_EVENT_QUEUE,
  CLUB_POLICIES_QUEUE,
  CLUB_REMINDERS_QUEUE,
  CLUB_WEBHOOKS_QUEUE,
  CLUB_WEEKLY_QUEUE,
  type ClubMaterializeJob,
  type ClubNotifyJob,
  type ClubPaymentEventJob,
} from '@sportkarta/lib/clubs';
import { assertDelivered, createMailer } from '@sportkarta/lib/email';
import { createPushSender } from '@sportkarta/lib/push';
import { createSmsSender } from '@sportkarta/lib/sms';
import { runImport } from '@sportkarta/import-osm';

import {
  runClubActivity,
  runClubExpiry,
  runClubHealth,
  runClubLeadsDue,
  runClubNotify,
  runClubOwnerWeekly,
  runClubPolicies,
  runClubReceipts,
  runClubReminders,
  runClubRosterDigest,
} from './club-mail-job.js';
import { runClubAutomations, runClubBroadcasts } from './club-messages-job.js';
import { runClubPaymentEvent, sweepClubPaymentEvents } from './club-payments-job.js';
import { runClubIntegrationsPrune, runClubWebhooks } from './club-webhooks-job.js';
import { runDivisions } from './divisions-job.js';
import { runWeeklyDigest } from './digest-job.js';
import { runOpenDataDump } from './opendata-dump-job.js';
import { reporter, reportingWork, reportMailFailures } from './reporting.js';
import { runModerationNotify, type ModerationNotifyJobData } from './moderation-mail-job.js';
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
/**
 * The worker heartbeat. The time pg-boss records the last one as COMPLETED is
 * what /api/health and /admin/zdrave read (apps/web/lib/ops-health.ts): no
 * table of its own, because pgboss.job already is one. Must stay in step with
 * HEALTH_QUEUE in apps/web/lib/admin-boss.ts.
 */
const HEALTH_QUEUE = 'health.ping';
/** Every five minutes; the web side calls a heartbeat stale after twenty. */
const HEALTH_SCHEDULE = '*/5 * * * *';
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
/**
 * Weekly divisions (B2): promote, relegate and re-group once a week has closed.
 * Also the bootstrap — there is no separate seeding job.
 */
const DIVISIONS_ROLLOVER_QUEUE = 'divisions.rollover';
/**
 * Moderation mail (0034): statements of reasons to members whose content was
 * refused, and receipts and outcomes to notifiers. Enqueued by the web app with
 * a decision id or a notice id — never an address.
 */
const MODERATION_NOTIFY_QUEUE = 'moderation.notify';

interface ImportOsmJobData {
  dryRun?: boolean;
}

/**
 * Retry policies, applied per queue (pg-boss's default is 2 retries with no
 * delay — about four seconds of trying, which one DB blip or relay hiccup
 * outlasts).
 *
 * MAIL: session.notify is enqueued exactly ONCE per event — a cancellation, a
 * promotion — so a failed run that is not retried means somebody is never
 * told. Five retries with exponential backoff from a minute cover roughly the
 * next hour; the notification ledger makes every re-run mail only the people
 * the last one missed.
 *
 * WEEKLY: the Monday jobs fire once a week and act on "the week that just
 * closed", so a lost run cannot be made up next time. Ten retries with backoff
 * from a minute keep trying for about a day (pg-boss doubles the delay, with
 * jitter) — still the same week, so the digest's claim key and the freezes'
 * "week that just closed" have not moved.
 */
const MAIL_RETRY = { retryLimit: 5, retryDelay: 60, retryBackoff: true } as const;
const WEEKLY_RETRY = { retryLimit: 10, retryDelay: 60, retryBackoff: true } as const;

/**
 * An address-free category for a job-level failure: a Postgres SQLSTATE or a
 * nodemailer code when there is one, else the error's class name. Never the
 * message — a constraint violation quotes the row, an SMTP error the address.
 */
function jobFailureCategory(error: unknown): string {
  const safe = (value: unknown): value is string =>
    typeof value === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(value);
  if (error && typeof error === 'object') {
    const { code, name } = error as { code?: unknown; name?: unknown };
    if (safe(code)) return code;
    if (safe(name)) return name;
  }
  return 'unknown';
}

/**
 * Wrap a handler so a failure leaves a line in the log before pg-boss records
 * it. pg-boss itself prints nothing when a handler throws — it only marks the
 * job failed — so without this a weekly job could fail every retry and the
 * container log would show no trace of it.
 */
function logged<R>(
  queue: string,
  handler: (jobs: PgBoss.Job<object>[]) => Promise<R>,
): (jobs: PgBoss.Job<object>[]) => Promise<R> {
  return async (jobs) => {
    try {
      return await handler(jobs);
    } catch (error: unknown) {
      console.error(`[worker] ${queue} job failed: ${jobFailureCategory(error)}`);
      throw error;
    }
  };
}

/** Materialize one series (after create/edit), or all of them (the schedule). */
interface SessionMaterializeJobData {
  sessionId?: string;
}

/**
 * Jobs fetched per poll for the two queues the web app feeds one job per member
 * action. pg-boss polls every 2 s and fetches ONE job by default — the web
 * process sends, so the worker is never notified — which caps a queue at ~1,800
 * jobs an hour. A 200-person QR check-in burst then queued badge evaluation past
 * the one-hour "new badge" window, recording fresh badges as already seen, and
 * RSVP mail waited behind the same limit. Both handlers already loop over the
 * batch, and both are idempotent per job (ON CONFLICT on user_badges; the
 * play_session_notifications claim), so a retried job cannot award or mail twice.
 * Each job also fails on its own (`eachJobIsolated`), so a batch is never worse
 * than the one-job fetches it replaced.
 */
const FEED_BATCH_SIZE = 20;

/**
 * Run a fetched batch one job at a time, so a job that throws fails ONLY ITSELF.
 *
 * pg-boss settles a batch as a unit: when the handler throws, every job in it is
 * failed and retried — including the ones after the throw that never ran. With
 * one job per fetch that was the same thing as failing the job. With a batch it
 * is not: retries keep their creation time, so the same batch comes back in the
 * same order, and one poisoned payload would take the RSVP mails queued behind it
 * down retry after retry until the retry limit failed them for good, unattempted.
 *
 * So a job's error fails that job alone — pg-boss retries it on its own schedule,
 * with the error stored exactly as a throwing handler's would be — and the batch
 * carries on. The completion pg-boss writes afterwards only touches jobs still
 * `active`, so it completes the rest and leaves the failed one where it is.
 */
async function eachJobIsolated<T>(
  boss: PgBoss,
  queue: string,
  jobs: PgBoss.Job<T>[],
  handle: (job: PgBoss.Job<T>) => Promise<void>,
): Promise<void> {
  for (const job of jobs) {
    try {
      await handle(job);
    } catch (error: unknown) {
      // A category only: the message can embed a query or a connection string.
      console.error(
        `[worker] ${queue} job ${job.id} failed:`,
        error instanceof Error ? error.name : 'unknown',
      );
      await boss.fail(queue, job.id, error instanceof Error ? error : { value: String(error) });
    }
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required (see .env.example)');
  }

  const boss = new PgBoss(databaseUrl);
  boss.on('error', (error) => {
    console.error('[pg-boss]', error);
    void reporter.captureException(error, { tags: { source: 'pg-boss' } });
  });
  // Every handler below is registered through this, so a job that throws is
  // reported (when GLITCHTIP_DSN is set) before pg-boss marks it failed.
  const work = reportingWork(boss);

  // The shared @sportkarta/db pool behind getDb(), which every mail, passport
  // and dump job queries through. Same reasoning as statsPool below: an idle
  // client's error (DB restart, failover) is emitted on the pool, and with no
  // listener it is an uncaught exception that takes the whole worker down.
  // The code only — a connection error can carry the connection string.
  getPool().on('error', (error: unknown) => {
    console.error(`[db-pool] idle client error: ${jobFailureCategory(error)}`);
  });

  // ONE mailer for the life of the process, so the SMTP transport's pool is
  // reused across jobs instead of re-logging in to the relay per message.
  const mailer = createMailer(process.env);
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';

  // SMS and push for club messages (0051). A channel is attempted only when
  // the operator switched the service on (the same env master switches the
  // web app reads) AND its transport resolved — and both transports fail
  // closed in production exactly like the mailer, so a missing gateway or
  // VAPID secret sends nothing rather than something unsafe.
  const sms = createSmsSender(process.env);
  const push = createPushSender(process.env);
  const clubMail = {
    mailer,
    siteUrl,
    channels: {
      sms: {
        sender: sms.sender,
        on: process.env.CLUB_SMS_ENABLED === 'true' && sms.kind !== 'disabled',
      },
      push: {
        sender: push.sender,
        on: process.env.CLUB_PUSH_ENABLED === 'true' && push.kind !== 'disabled',
      },
    },
  };
  // Bulk club e-mail (broadcasts + automations) per Sofia day across every
  // club — below the relay's own daily quota, which sign-in codes share.
  const bulkLimitRaw = (process.env.CLUB_BULK_MAIL_DAILY_LIMIT ?? '').trim();
  const clubMessages = {
    ...clubMail,
    bulkMailDailyLimit: /^\d{1,6}$/.test(bulkLimitRaw) ? Number(bulkLimitRaw) : 200,
  };

  // Separate pool for REFRESH MATERIALIZED VIEW CONCURRENTLY (pg-boss owns its
  // own connections). CONCURRENTLY runs in autocommit, so a pool is fine. An
  // idle-client error (DB restart/failover) must be handled or it crashes the
  // whole worker as an uncaught exception.
  const statsPool = new pg.Pool({ connectionString: databaseUrl });
  statsPool.on('error', (error) => {
    console.error('[stats-pool]', error);
  });

  await boss.start();

  /**
   * Create a queue, and bring an EXISTING one up to the given retry policy.
   * pg-boss's createQueue is INSERT ... ON CONFLICT DO NOTHING, so options
   * passed to it never reach a queue production already has — updateQueue is
   * what actually changes them. A fresh options object per call: pg-boss
   * annotates the one it is handed.
   */
  async function ensureQueue(
    name: string,
    options?: {
      policy?: 'short' | 'stately';
      retryLimit?: number;
      retryDelay?: number;
      retryBackoff?: boolean;
    },
  ): Promise<void> {
    await boss.createQueue(name, { name, ...options });
    if (options) await boss.updateQueue(name, { name, ...options });
  }

  await ensureQueue(HEALTH_QUEUE);
  // STATELY: at most one import waiting and one running, per singletonKey — a
  // double-click, or a live run queued behind a dry run, is refused (send()
  // returns null and the admin screen says so) instead of stacking national
  // imports back to back. apps/web/.../import/actions.ts declares the same.
  // createQueue never changes an existing queue, so production's import.osm
  // stayed 'standard' — where a singletonKey is enforced by nothing — until
  // updateQueue converges it here.
  await ensureQueue(IMPORT_OSM_QUEUE, { policy: 'stately' });
  await ensureQueue(STATS_REFRESH_QUEUE);
  await ensureQueue(AUTH_CLEANUP_QUEUE);
  await ensureQueue(SESSION_MATERIALIZE_QUEUE);
  await ensureQueue(SESSION_NOTIFY_QUEUE, MAIL_RETRY);
  await ensureQueue(SESSION_REMINDERS_QUEUE);
  await ensureQueue(DIGEST_WEEKLY_QUEUE, WEEKLY_RETRY);
  await ensureQueue(OPENDATA_DUMP_QUEUE);
  // SHORT: at most one WAITING evaluation per member (the web app sends with
  // singletonKey = account id). A job that has not started yet will fold the
  // latest history anyway, so a burst of one member's check-ins collapses into
  // one job; one already running does not block the next, so nothing is missed.
  await ensureQueue(PASSPORT_EVALUATE_QUEUE, { policy: 'short' });
  await ensureQueue(BADGE_BACKFILL_QUEUE);
  await ensureQueue(STREAK_FREEZE_QUEUE, WEEKLY_RETRY);
  await ensureQueue(DIVISIONS_ROLLOVER_QUEUE, WEEKLY_RETRY);
  // Enqueued once per decision or notice, like session.notify: the retry is
  // the only second chance a statement of reasons gets.
  await ensureQueue(MODERATION_NOTIFY_QUEUE, MAIL_RETRY);
  // «Клубове» (Stage 9). club.notify is enqueued once per event like
  // session.notify, so MAIL_RETRY is its only second chance; the sweeps are
  // their own retry; the daily and weekly jobs act on "today" / "the week that
  // closed" and retry within it.
  await ensureQueue(CLUB_MATERIALIZE_QUEUE);
  await ensureQueue(CLUB_NOTIFY_QUEUE, MAIL_RETRY);
  await ensureQueue(CLUB_REMINDERS_QUEUE);
  await ensureQueue(CLUB_EXPIRY_QUEUE, WEEKLY_RETRY);
  await ensureQueue(CLUB_DIGEST_QUEUE, WEEKLY_RETRY);
  await ensureQueue(CLUB_WEEKLY_QUEUE, WEEKLY_RETRY);
  await ensureQueue(CLUB_ACTIVITY_QUEUE, WEEKLY_RETRY);
  await ensureQueue(CLUB_POLICIES_QUEUE, WEEKLY_RETRY);
  await ensureQueue(CLUB_HEALTH_QUEUE, WEEKLY_RETRY);
  // A Stripe event: retried with backoff by pg-boss, and swept every 10 minutes.
  await ensureQueue(CLUB_PAYMENT_EVENT_QUEUE, MAIL_RETRY);
  // Broadcasts are a sweep (their own retry); automations act on "today" and
  // catch up within their window, so a failed day is retried within it.
  // SHORT: «Изпрати сега» sends with a singletonKey, so a burst of presses
  // leaves one waiting run (it reads the whole table anyway).
  await ensureQueue(CLUB_BROADCASTS_QUEUE, { policy: 'short' });
  await ensureQueue(CLUB_AUTOMATIONS_QUEUE, WEEKLY_RETRY);
  await ensureQueue(CLUB_LEADS_QUEUE, WEEKLY_RETRY);
  // Webhooks (0057) are a sweep — their own retry, with backoff kept on each
  // delivery row. SHORT: a run that overlaps the next minute leaves one waiting.
  await ensureQueue(CLUB_WEBHOOKS_QUEUE, { policy: 'short' });
  await ensureQueue(CLUB_INTEGRATIONS_PRUNE_QUEUE, WEEKLY_RETRY);

  // Triggered from the admin UI (Stage 1+) via boss.send('import.osm', {dryRun}).
  // dryRun defaults TRUE — a live import must be requested explicitly, matching
  // the operator gates in docs/ROADMAP.md §3. The report goes to stdout (docker
  // logs); the reviewable artifact for gates is the CLI run's committed report.
  await work(IMPORT_OSM_QUEUE, { batchSize: 1 }, async (jobs) => {
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
  await work(STATS_REFRESH_QUEUE, async () => {
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
  await work(AUTH_CLEANUP_QUEUE, async () => {
    const verifications = await statsPool.query(
      `DELETE FROM verifications WHERE expires_at < now()`,
    );
    const sessions = await statsPool.query(`DELETE FROM sessions WHERE expires_at < now()`);
    // A notifier's name and address are kept to answer them about their notice
    // (0034), and erased once the retention printed on /privacy has run out.
    const notifierContacts = await eraseExpiredNotifierContacts(getDb());
    // Counts only — never the addresses themselves (no PII in logs).
    console.log(
      `[worker] ${AUTH_CLEANUP_QUEUE} removed ${verifications.rowCount ?? 0} expired code(s), ${sessions.rowCount ?? 0} expired session(s), ${String(notifierContacts)} notifier contact(s)`,
    );
  });
  await boss.schedule(AUTH_CLEANUP_QUEUE, '17 3 * * *');

  // Rolling 8-week occurrence window (Stage 4.1). Hourly, so the horizon moves
  // on its own; the job is idempotent (INSERT ... ON CONFLICT DO NOTHING against
  // a UNIQUE index), so an extra run costs a scan and creates nothing. Also sent
  // with a sessionId right after a series is created or edited, so a member does
  // not wait up to an hour to see their own session.
  await work(SESSION_MATERIALIZE_QUEUE, { batchSize: 1 }, async (jobs) => {
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
  // send, in the same transaction, so a retry cannot mail anyone twice. Which
  // is what makes it safe to THROW when anybody was not reached: this job is
  // enqueued once per event, so the queue's retry (MAIL_RETRY) is the only
  // second chance a cancellation notice gets. Fetched in batches (FEED_BATCH_SIZE)
  // with each job isolated, so one undeliverable notice fails and retries alone
  // instead of taking the batch behind it down with it.
  await work(
    SESSION_NOTIFY_QUEUE,
    { batchSize: FEED_BATCH_SIZE },
    logged(SESSION_NOTIFY_QUEUE, async (jobs) => {
      let last: Awaited<ReturnType<typeof runSessionNotify>> | undefined;
      await eachJobIsolated(boss, SESSION_NOTIFY_QUEUE, jobs, async (job) => {
        const data = (job.data ?? {}) as SessionNotifyJobData;
        const report = await runSessionNotify(data, { mailer, siteUrl });
        last = report;
        // Counts and the pinned reason only. `reason` is validated against the
        // vocabulary before it is logged: an unbounded string from a job payload
        // interpolated into a log line is how a log gets forged.
        const reason = data.reason && data.reason in NOTIFY_REASONS ? data.reason : 'unknown';
        console.log(
          `[worker] ${SESSION_NOTIFY_QUEUE} job ${job.id}: reason=${reason} ` +
            `${String(report.candidates)} candidate(s), ${String(report.sent)} sent, ` +
            `${String(report.skipped)} skipped, ${String(report.failed)} failed, ` +
            `${String(report.unattempted)} unattempted`,
        );
        await reportMailFailures(SESSION_NOTIFY_QUEUE, report);
        assertDelivered(SESSION_NOTIFY_QUEUE, report);
      });
      return last;
    }),
  );

  // T-24h and T-2h reminders (Stage 4.2). Every ten minutes — but the query is
  // "starting within the lead time and NOT YET TOLD", not "starting in 24 h ± 5
  // min", so the schedule is a heartbeat rather than a window that can be
  // missed. A worker that was down all afternoon catches up on its next tick
  // instead of silently skipping everyone whose window it slept through.
  //
  // It does NOT throw on a failed send, unlike session.notify: this sweep is its
  // own retry. A failed send rolls its claim back, the recipient stays "not yet
  // told", and the next tick picks them up — while deliverEach stops the tick at
  // the first sign the relay is down, so a quota outage costs one login attempt
  // every ten minutes instead of one per due reminder.
  await work(
    SESSION_REMINDERS_QUEUE,
    { batchSize: 1 },
    logged(SESSION_REMINDERS_QUEUE, async (jobs) => {
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
              `${String(report.failed)} failed, ${String(report.unattempted)} unattempted`,
          );
          await reportMailFailures(`${SESSION_REMINDERS_QUEUE}/${kind}`, report);
        }
      }
      return last;
    }),
  );
  await boss.schedule(SESSION_REMINDERS_QUEUE, '*/10 * * * *');

  // Moderation mail (0034). The outcome is a closed vocabulary, so it can be
  // logged; the payload is re-validated by the job before it touches anything.
  // One message per job, claimed and sent in one transaction: a relay failure
  // rolls the claim back and THROWS, so MAIL_RETRY re-runs it.
  await work(
    MODERATION_NOTIFY_QUEUE,
    { batchSize: 1 },
    logged(MODERATION_NOTIFY_QUEUE, async (jobs) => {
      const contactEmail = process.env.CONTACT_EMAIL;
      for (const job of jobs) {
        const data = (job.data ?? {}) as ModerationNotifyJobData;
        const outcome = await runModerationNotify(data, { mailer, siteUrl, contactEmail });
        console.log(`[worker] ${MODERATION_NOTIFY_QUEUE} job ${job.id}: ${outcome}`);
      }
    }),
  );

  // Weekly city digest (Stage 4.4). Monday 08:00 EUROPE/SOFIA, not UTC: the
  // send time is a wall-clock promise to a reader, so it must not drift by an
  // hour twice a year. pg-boss passes tz to cron-parser, which is why luxon is
  // in the lockfile at all.
  //
  // The job and /sedmitsata/[city] call the SAME query (weeklyDigest), and the
  // send is idempotent per subscriber per week through digest_sends — so a
  // manual re-run, a retry or a second worker cannot mail anyone twice. Which
  // is what makes it safe to throw when anybody was missed: WEEKLY_RETRY re-runs
  // the job within the same week, and the claims skip everyone already mailed.
  await work(
    DIGEST_WEEKLY_QUEUE,
    { batchSize: 1 },
    logged(DIGEST_WEEKLY_QUEUE, async (jobs) => {
      let last: Awaited<ReturnType<typeof runWeeklyDigest>> | undefined;
      for (const job of jobs) {
        last = await runWeeklyDigest({ mailer, siteUrl });
        // Counts only — never an address (no PII in logs).
        console.log(
          `[worker] ${DIGEST_WEEKLY_QUEUE} job ${job.id}: ${String(last.subscribers)} subscriber(s), ` +
            `${String(last.sent)} sent, ${String(last.skipped)} skipped, ` +
            `${String(last.failed)} failed, ${String(last.unattempted)} unattempted`,
        );
        await reportMailFailures(DIGEST_WEEKLY_QUEUE, last);
        assertDelivered(DIGEST_WEEKLY_QUEUE, last);
      }
      return last;
    }),
  );
  await boss.schedule(DIGEST_WEEKLY_QUEUE, '0 8 * * 1', {}, { tz: 'Europe/Sofia' });

  // Nightly open-data bulk dump (Stage 6.1). 05:10 EUROPE/SOFIA — clear of the
  // backup sidecar's 03:30 pg_dump, so the two are not competing for the same
  // disk, and in civil time so the version in the path is the day a person in
  // Sofia would call it.
  //
  // NEVER BETWEEN 03:00 AND 04:00 SOFIA. That is the hour the EU clock change
  // happens in: it does not exist on the last Sunday of March and happens TWICE
  // on the last Sunday of October. At the old 03:40 the dump was skipped every
  // March and ran twice every October — and the second run rewrote a version
  // already served `immutable`, the one thing this job promises never to do.
  // apps/web/tests/worker-schedules.test.ts derives that hour from the tz
  // database and refuses any Sofia schedule inside it.
  //
  // Idempotent by construction: every dataset's ORDER BY is total, so a re-run
  // on the same day rewrites byte-identical files under the same version. The
  // job is safe to trigger by hand from the admin screen when something looks
  // wrong, which is the point of making it boring.
  await work(OPENDATA_DUMP_QUEUE, { batchSize: 1 }, async (jobs) => {
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
  await boss.schedule(OPENDATA_DUMP_QUEUE, '10 5 * * *', {}, { tz: 'Europe/Sofia' });

  // Badge evaluation (A1). Until now `recordEarnedBadges` ran from exactly one
  // place — a /pasport render — so a badge did not exist until the member
  // personally looked. The web app enqueues here after a contribution or a
  // check-in COMMITS; see apps/worker/src/passport-job.ts for why this must not
  // be inlined into those transactions.
  await work(PASSPORT_EVALUATE_QUEUE, { batchSize: FEED_BATCH_SIZE }, async (jobs) => {
    await eachJobIsolated(boss, PASSPORT_EVALUATE_QUEUE, jobs, async (job) => {
      const report = await runPassportEvaluate((job.data ?? {}) as PassportEvaluateJobData);
      if (report.recorded > 0) {
        // Counts only — an account id identifies a person even with no name.
        console.log(
          `[worker] ${PASSPORT_EVALUATE_QUEUE} job ${job.id}: ${String(report.recorded)} badge(s) recorded`,
        );
      }
    });
  });

  // The retroactive back catalogue, once. Every badge it writes is historical
  // and therefore recorded already-seen, so nobody wakes up to eight
  // simultaneous "new" badges. Sent on every boot rather than scheduled: it is
  // idempotent (ON CONFLICT DO NOTHING), it is the only thing that catches a
  // member whose badges were earned while this feature did not exist, and one
  // pass over the ledger's distinct users is cheap next to getting it wrong.
  await work(BADGE_BACKFILL_QUEUE, async () => {
    const report = await runBadgeBackfill();
    console.log(
      `[worker] ${BADGE_BACKFILL_QUEUE} evaluated ${String(report.evaluated)} member(s), ` +
        `${String(report.recorded)} badge(s) recorded, ${String(report.failed)} failed`,
    );
  });
  await boss.send(BADGE_BACKFILL_QUEUE, {});

  // Streak freezes (A4). Monday 04:20 EUROPE/SOFIA — after the civil week has
  // closed, outside the 03:00 DST hour, and clear of the 03:30 backup. The
  // timezone is the point: a week boundary is a wall-clock promise, so a UTC
  // cron would apply freezes an hour early or late for half the year and
  // occasionally decide the wrong week had just closed.
  //
  // A member whose evaluation failed is retried with the whole job (WEEKLY_RETRY):
  // freezeCandidate() only ever looks at the week that just closed, so a freeze
  // not applied this week can never be applied later. applyStreakFreeze is
  // ON CONFLICT DO NOTHING, so the re-run cannot forgive a week twice.
  await work(
    STREAK_FREEZE_QUEUE,
    logged(STREAK_FREEZE_QUEUE, async () => {
      const report = await runStreakFreezes();
      console.log(
        `[worker] ${STREAK_FREEZE_QUEUE} considered ${String(report.evaluated)} member(s), ` +
          `${String(report.recorded)} week(s) forgiven, ${String(report.failed)} failed`,
      );
      if (report.failed > 0) {
        throw new Error(`${STREAK_FREEZE_QUEUE}: ${String(report.failed)} member(s) failed`);
      }
    }),
  );
  await boss.schedule(STREAK_FREEZE_QUEUE, '20 4 * * 1', {}, { tz: 'Europe/Sofia' });

  // Weekly divisions (B2). Monday 04:40 EUROPE/SOFIA — twenty minutes after the
  // freezes, so a week that was forgiven is already forgiven before anything
  // reads it, and well before the 08:00 digest. Same timezone reasoning as
  // above: a week boundary is a wall-clock promise, and a UTC cron would
  // occasionally roll the wrong week over.
  //
  // Also the bootstrap. There is no separate seeding job — see
  // divisions-job.ts: week one is the general case with no history, and a
  // missed week resumes rather than resets.
  await work(
    DIVISIONS_ROLLOVER_QUEUE,
    logged(DIVISIONS_ROLLOVER_QUEUE, async () => {
      const report = await runDivisions();
      console.log(
        `[worker] ${DIVISIONS_ROLLOVER_QUEUE} ${report.week}: ` +
          (report.belowFloor
            ? 'below floor, nothing written'
            : `${String(report.groups)} group(s), ${String(report.members)} member(s)`),
      );
    }),
  );
  await boss.schedule(DIVISIONS_ROLLOVER_QUEUE, '40 4 * * 1', {}, { tz: 'Europe/Sofia' });

  // ─── «Клубове» (Stage 9) ──────────────────────────────────────────────────
  // Every club job is a no-op while no club exists, so nothing here is gated on
  // CLUBS_ENABLED: the web app enqueues nothing with the flag off, and the
  // sweeps find nothing to do.

  // A club's rolling occurrence window — the session materializer's twin, at
  // :11 so the two hourly scans do not start together. Also sent with a
  // classId right after a class is saved.
  await work(CLUB_MATERIALIZE_QUEUE, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const data = (job.data ?? {}) as ClubMaterializeJob;
      const report = await materializeClubClasses(statsPool, { classId: data.classId });
      if (report.classesProcessed > 0 || report.failures.length > 0) {
        // Counts only; a class id is a club's object, logged only on failure.
        console.log(
          `[worker] ${CLUB_MATERIALIZE_QUEUE} job ${job.id}: ${String(report.classesProcessed)} class(es), ` +
            `+${String(report.occurrencesCreated)} created, ${String(report.failures.length)} failed, ` +
            `${String(report.conflicts.length)} skipped (room taken)`,
        );
      }
      for (const failure of report.failures) {
        console.error(
          `[worker] ${CLUB_MATERIALIZE_QUEUE} class ${failure.classId}: ${failure.code}`,
        );
      }
    }
  });
  await boss.schedule(CLUB_MATERIALIZE_QUEUE, '11 * * * *');
  await boss.send(CLUB_MATERIALIZE_QUEUE, {});

  // Club mail, enqueued by the web app with ids only (apps/worker/src/club-mail-job.ts).
  await work(
    CLUB_NOTIFY_QUEUE,
    { batchSize: FEED_BATCH_SIZE },
    logged(CLUB_NOTIFY_QUEUE, async (jobs) => {
      await eachJobIsolated(boss, CLUB_NOTIFY_QUEUE, jobs, async (job) => {
        const { kind, report } = await runClubNotify(job.data, clubMail);
        // `kind` is from the validated vocabulary (parseClubNotifyJob).
        console.log(
          `[worker] ${CLUB_NOTIFY_QUEUE} job ${job.id}: ${kind} ` +
            `${String(report.sent)} sent, ${String(report.skipped)} skipped, ` +
            `${String(report.failed)} failed, ${String(report.unattempted)} unattempted`,
        );
        await reportMailFailures(CLUB_NOTIFY_QUEUE, report);
        assertDelivered(CLUB_NOTIFY_QUEUE, report);
      });
    }),
  );

  // 24-hour class reminders: a heartbeat over "due and not yet told", like
  // session.reminders, and its own retry.
  await work(
    CLUB_REMINDERS_QUEUE,
    { batchSize: 1 },
    logged(CLUB_REMINDERS_QUEUE, async (jobs) => {
      for (const job of jobs) {
        const report = await runClubReminders(clubMail);
        if (report.candidates === 0) continue;
        console.log(
          `[worker] ${CLUB_REMINDERS_QUEUE} job ${job.id}: ${String(report.sent)} sent, ` +
            `${String(report.skipped)} skipped, ${String(report.failed)} failed`,
        );
        await reportMailFailures(CLUB_REMINDERS_QUEUE, report);
      }
    }),
  );
  await boss.schedule(CLUB_REMINDERS_QUEUE, '*/10 * * * *');

  // Abonnements ending within a week, and those that just ended. 09:20 Sofia:
  // a reasonable hour to read about money.
  await work(
    CLUB_EXPIRY_QUEUE,
    logged(CLUB_EXPIRY_QUEUE, async () => {
      const out = await runClubExpiry(clubMail);
      for (const [kind, report] of Object.entries(out)) {
        console.log(
          `[worker] ${CLUB_EXPIRY_QUEUE} ${kind}: ${String(report.sent)} sent, ` +
            `${String(report.skipped)} skipped, ${String(report.failed)} failed`,
        );
        await reportMailFailures(`${CLUB_EXPIRY_QUEUE}/${kind}`, report);
        assertDelivered(CLUB_EXPIRY_QUEUE, report);
      }
    }),
  );
  await boss.schedule(CLUB_EXPIRY_QUEUE, '20 9 * * *', {}, { tz: 'Europe/Sofia' });

  // Each trainer's classes today (counts only), before the day starts.
  await work(
    CLUB_DIGEST_QUEUE,
    logged(CLUB_DIGEST_QUEUE, async () => {
      const report = await runClubRosterDigest(clubMail);
      console.log(
        `[worker] ${CLUB_DIGEST_QUEUE}: ${String(report.sent)} sent, ` +
          `${String(report.skipped)} skipped, ${String(report.failed)} failed`,
      );
      await reportMailFailures(CLUB_DIGEST_QUEUE, report);
      assertDelivered(CLUB_DIGEST_QUEUE, report);
    }),
  );
  await boss.schedule(CLUB_DIGEST_QUEUE, '30 6 * * *', {}, { tz: 'Europe/Sofia' });

  // Each member of staff's prospects to call today (0052), counts only.
  await work(
    CLUB_LEADS_QUEUE,
    logged(CLUB_LEADS_QUEUE, async () => {
      const report = await runClubLeadsDue(clubMail);
      console.log(
        `[worker] ${CLUB_LEADS_QUEUE}: ${String(report.sent)} sent, ` +
          `${String(report.skipped)} skipped, ${String(report.failed)} failed`,
      );
      await reportMailFailures(CLUB_LEADS_QUEUE, report);
      assertDelivered(CLUB_LEADS_QUEUE, report);
    }),
  );
  await boss.schedule(CLUB_LEADS_QUEUE, '5 9 * * *', {}, { tz: 'Europe/Sofia' });

  // The owner's Monday numbers for the week that just closed.
  await work(
    CLUB_WEEKLY_QUEUE,
    logged(CLUB_WEEKLY_QUEUE, async () => {
      const report = await runClubOwnerWeekly(clubMail);
      console.log(
        `[worker] ${CLUB_WEEKLY_QUEUE}: ${String(report.sent)} sent, ` +
          `${String(report.skipped)} skipped, ${String(report.failed)} failed`,
      );
      await reportMailFailures(CLUB_WEEKLY_QUEUE, report);
      assertDelivered(CLUB_WEEKLY_QUEUE, report);
    }),
  );
  await boss.schedule(CLUB_WEEKLY_QUEUE, '30 8 * * 1', {}, { tz: 'Europe/Sofia' });

  // The invoicing basis: freeze last month's per-club counts on the 1st.
  await work(
    CLUB_ACTIVITY_QUEUE,
    logged(CLUB_ACTIVITY_QUEUE, async () => {
      const { month, recorded } = await runClubActivity();
      console.log(`[worker] ${CLUB_ACTIVITY_QUEUE} ${month}: ${String(recorded)} club(s) recorded`);
    }),
  );
  await boss.schedule(CLUB_ACTIVITY_QUEUE, '15 6 1 * *', {}, { tz: 'Europe/Sofia' });

  // Renewals and no-show / late-cancel fees (0045), then the members' mail.
  // 05:40 Sofia: after the night's classes have ended and before the desk
  // opens, so the renewed abonnement is in place for the first visit.
  await work(
    CLUB_POLICIES_QUEUE,
    logged(CLUB_POLICIES_QUEUE, async () => {
      const out = await runClubPolicies(clubMail);
      console.log(
        `[worker] ${CLUB_POLICIES_QUEUE}: ${String(out.renewed)} renewed, ` +
          `${String(out.ended)} ended, ${String(out.failed)} failed, ${String(out.fees)} fee(s); mail ` +
          `${String(out.renewalMail.sent + out.feeMail.sent)} sent`,
      );
      await reportMailFailures(`${CLUB_POLICIES_QUEUE}/renewal`, out.renewalMail);
      await reportMailFailures(`${CLUB_POLICIES_QUEUE}/fee`, out.feeMail);
      assertDelivered(CLUB_POLICIES_QUEUE, out.renewalMail);
      assertDelivered(CLUB_POLICIES_QUEUE, out.feeMail);
    }),
  );
  await boss.schedule(CLUB_POLICIES_QUEUE, '40 5 * * *', {}, { tz: 'Europe/Sofia' });

  // The owner's business-health mail for the month that closed — after
  // club.activity (06:15) has frozen the month, before the working day.
  await work(
    CLUB_HEALTH_QUEUE,
    logged(CLUB_HEALTH_QUEUE, async () => {
      const report = await runClubHealth(clubMail);
      console.log(
        `[worker] ${CLUB_HEALTH_QUEUE}: ${String(report.sent)} sent, ` +
          `${String(report.skipped)} skipped, ${String(report.failed)} failed`,
      );
      await reportMailFailures(CLUB_HEALTH_QUEUE, report);
      assertDelivered(CLUB_HEALTH_QUEUE, report);
    }),
  );
  await boss.schedule(CLUB_HEALTH_QUEUE, '10 7 1 * *', {}, { tz: 'Europe/Sofia' });

  // Online payments (0046): apply a verified Stripe event by re-fetching its
  // object, then send any receipts now owed. A job without an event id is the
  // sweep (lost enqueues, and receipts whose send failed).
  await work(
    CLUB_PAYMENT_EVENT_QUEUE,
    { batchSize: 1 },
    logged(CLUB_PAYMENT_EVENT_QUEUE, async (jobs) => {
      for (const job of jobs) {
        const data = (job.data ?? {}) as ClubPaymentEventJob;
        if (typeof data.eventId === 'number') {
          const result = await runClubPaymentEvent(data.eventId);
          if (result) {
            // The event type and outcome only — never an account or an amount.
            console.log(`[worker] ${CLUB_PAYMENT_EVENT_QUEUE} ${result.type}: ${result.outcome}`);
          }
        } else {
          const swept = await sweepClubPaymentEvents();
          if (swept.done > 0)
            console.log(`[worker] ${CLUB_PAYMENT_EVENT_QUEUE} sweep: ${String(swept.done)}`);
          // Places that moved up into a seat a lapsed hold freed (0053): told
          // through club.notify like every other notice, ids only.
          if (swept.promoted.length > 0) {
            const job: ClubNotifyJob = { kind: 'event_promoted', registrationIds: swept.promoted };
            await boss.send(CLUB_NOTIFY_QUEUE, job);
          }
        }
        const receipts = await runClubReceipts(clubMail);
        await reportMailFailures(`${CLUB_PAYMENT_EVENT_QUEUE}/receipt`, receipts);
      }
    }),
  );
  await boss.schedule(CLUB_PAYMENT_EVENT_QUEUE, '*/10 * * * *');

  // A club's messages to a group (0051): every five minutes, and on demand
  // when the office presses «Изпрати сега». One run at a time is enough —
  // the ledger makes an overlapping run harmless, never a double send.
  let broadcastsHeld = false;
  await work(
    CLUB_BROADCASTS_QUEUE,
    { batchSize: 1 },
    logged(CLUB_BROADCASTS_QUEUE, async () => {
      const out = await runClubBroadcasts(clubMessages);
      // «Held» is logged when it begins or ends, not every five minutes.
      const changed = out.held !== broadcastsHeld;
      broadcastsHeld = out.held;
      if (out.report.sent > 0 || out.finished > 0 || out.stale > 0 || changed) {
        console.log(
          `[worker] ${CLUB_BROADCASTS_QUEUE}: ${String(out.broadcasts)} message(s), ` +
            `${String(out.finished)} finished, ${String(out.report.sent)} sent, ` +
            `${String(out.report.failed)} failed, ${String(out.stale)} stale cancelled` +
            `${out.held ? ', held by the daily limit' : ''}`,
        );
      }
      await reportMailFailures(CLUB_BROADCASTS_QUEUE, out.report);
    }),
  );
  await boss.schedule(CLUB_BROADCASTS_QUEUE, '*/5 * * * *');

  // Automations (0051): welcome, follow-ups, win-back — 10:15 Sofia, a
  // decent hour to receive a club's message.
  await work(
    CLUB_AUTOMATIONS_QUEUE,
    logged(CLUB_AUTOMATIONS_QUEUE, async () => {
      const out = await runClubAutomations(clubMessages);
      console.log(
        `[worker] ${CLUB_AUTOMATIONS_QUEUE}: ${String(out.automations)} automation(s), ` +
          `${String(out.report.sent)} sent, ${String(out.report.skipped)} skipped, ` +
          `${String(out.report.failed)} failed${out.held ? ', held by the daily limit' : ''}`,
      );
      await reportMailFailures(CLUB_AUTOMATIONS_QUEUE, out.report);
      assertDelivered(CLUB_AUTOMATIONS_QUEUE, out.report);
    }),
  );
  await boss.schedule(CLUB_AUTOMATIONS_QUEUE, '15 10 * * *', {}, { tz: 'Europe/Sofia' });

  // Club webhooks (0057): every minute, post what the database queued. Counts
  // only in the log — never an endpoint's URL, which may carry a token.
  await work(
    CLUB_WEBHOOKS_QUEUE,
    { batchSize: 1 },
    logged(CLUB_WEBHOOKS_QUEUE, async () => {
      const out = await runClubWebhooks();
      if (out.sent + out.failed + out.gaveUp + out.disabled > 0) {
        console.log(
          `[worker] ${CLUB_WEBHOOKS_QUEUE}: ${String(out.sent)} delivered, ` +
            `${String(out.failed)} to retry, ${String(out.gaveUp)} given up, ` +
            `${String(out.disabled)} endpoint(s) disabled`,
        );
      }
    }),
  );
  await boss.schedule(CLUB_WEBHOOKS_QUEUE, '* * * * *');

  // The webhook log keeps 30 days, an idempotency record one — 04:50 Sofia,
  // after the DST hour.
  await work(
    CLUB_INTEGRATIONS_PRUNE_QUEUE,
    logged(CLUB_INTEGRATIONS_PRUNE_QUEUE, async () => {
      const out = await runClubIntegrationsPrune();
      if (out.deliveries + out.idempotency > 0) {
        console.log(
          `[worker] ${CLUB_INTEGRATIONS_PRUNE_QUEUE}: ${String(out.deliveries)} deliveries, ` +
            `${String(out.idempotency)} idempotency records`,
        );
      }
    }),
  );
  await boss.schedule(CLUB_INTEGRATIONS_PRUNE_QUEUE, '50 4 * * *', {}, { tz: 'Europe/Sofia' });

  // The heartbeat goes LAST, after every other queue is registered. A worker
  // that throws halfway through booting — a bad image, a missing env var — and
  // is restarted by Docker in a loop must never complete a ping on its way
  // down, or a crash loop would look alive. So a completed ping means "a worker
  // got all the way here", and the ping sent now is this boot's first beat.
  await work(HEALTH_QUEUE, async () => {
    // Quiet on purpose: 288 a day. pg-boss's completed_on IS the output.
  });
  await boss.schedule(HEALTH_QUEUE, HEALTH_SCHEDULE);
  await boss.send(HEALTH_QUEUE, {});

  console.log('[worker] started, listening for jobs');

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log(`[worker] ${signal} received, shutting down`);
      void boss
        .stop({ graceful: true })
        .then(() => statsPool.end())
        .then(() => mailer.close?.())
        .then(() => {
          process.exit(0);
        });
    });
  }
}

main().catch(async (error: unknown) => {
  console.error('[worker] fatal', error);
  // Bounded by the reporter's own timeout; a GlitchTip that is down cannot
  // keep a dead worker from exiting (and Docker from restarting it).
  await reporter.captureException(error, { tags: { stage: 'boot' } });
  process.exit(1);
});
