import PgBoss from 'pg-boss';

// Queue registry grows in Stage 1+ (imports, reminders, digests). Names are
// dot-namespaced: <domain>.<action>.
const HEALTH_QUEUE = 'health.ping';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required (see .env.example)');
  }

  const boss = new PgBoss(databaseUrl);
  boss.on('error', (error) => {
    console.error('[pg-boss]', error);
  });

  await boss.start();
  await boss.createQueue(HEALTH_QUEUE);

  await boss.work(HEALTH_QUEUE, async (jobs) => {
    for (const job of jobs) {
      console.log(`[worker] ${HEALTH_QUEUE} handled job ${job.id}`);
    }
  });

  console.log('[worker] started, listening for jobs');

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log(`[worker] ${signal} received, shutting down`);
      void boss.stop({ graceful: true }).then(() => {
        process.exit(0);
      });
    });
  }
}

main().catch((error: unknown) => {
  console.error('[worker] fatal', error);
  process.exit(1);
});
