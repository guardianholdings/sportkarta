import PgBoss from 'pg-boss';

export const IMPORT_QUEUE = 'import.osm';

// Enqueue-only pg-boss instance (the worker owns job execution). Cached on
// globalThis so Next dev HMR doesn't leak connections.
const globalCache = globalThis as { __skBoss?: Promise<PgBoss> };

export function getBoss(): Promise<PgBoss> {
  globalCache.__skBoss ??= (async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is required (see .env.example)');
    const boss = new PgBoss(url);
    boss.on('error', (error) => {
      console.error('[admin pg-boss]', error);
    });
    await boss.start();
    return boss;
  })();
  return globalCache.__skBoss;
}
