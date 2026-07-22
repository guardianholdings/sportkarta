import { refreshStats } from '@sportkarta/db';
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

interface ImportOsmJobData {
  dryRun?: boolean;
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
