import PgBoss from 'pg-boss';

export const IMPORT_QUEUE = 'import.osm';
/**
 * Session mail (Stage 4.2). The web app only ever ENQUEUES here — resolving
 * account ids to addresses and claiming the notification ledger both happen in
 * the worker, at send time, so no mailing list is ever left in a queue row.
 */
export const SESSION_NOTIFY_QUEUE = 'session.notify';

/**
 * Badge evaluation (A1). Enqueued after a contribution or check-in COMMITS.
 *
 * The payload is an ACCOUNT ID and nothing else — never an address, never a
 * facility, never what was earned. The worker folds the member's history at run
 * time, so a job row that outlives the account it names resolves to nothing
 * rather than to stale personal data.
 */
export const PASSPORT_EVALUATE_QUEUE = 'passport.evaluate';

// Enqueue-only pg-boss instance (the worker owns job execution). Cached on
// globalThis so Next dev HMR doesn't leak connections.
const globalCache = globalThis as { __skBoss?: Promise<PgBoss> };

export function getBoss(): Promise<PgBoss> {
  globalCache.__skBoss ??= (async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is required (see .env.example)');
    const boss = new PgBoss(url);
    boss.on('error', (error) => {
      // Message only: connection errors can embed the connection string.
      console.error('[admin pg-boss]', error instanceof Error ? error.message : String(error));
    });
    await boss.start();
    return boss;
  })();
  return globalCache.__skBoss;
}
