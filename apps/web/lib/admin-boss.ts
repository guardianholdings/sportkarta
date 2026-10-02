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

/**
 * The worker's liveness probe (apps/worker/src/index.ts). Scheduled every five
 * minutes and sent once at every worker boot; the time the last one COMPLETED
 * is the worker heartbeat that /api/health and /admin/zdrave read.
 */
export const HEALTH_QUEUE = 'health.ping';

// Enqueue-only pg-boss instance (the worker owns job execution). Cached on
// globalThis so Next dev HMR doesn't leak connections.
const globalCache = globalThis as {
  __skBoss?: Promise<PgBoss> | undefined;
  __skEnqueueFailures?: EnqueueFailures;
};

/**
 * Enqueue failures seen by THIS web process since it started. In memory on
 * purpose: it answers "can the site reach the queue right now?" on the health
 * page, and a restart that clears it is also a restart that retried the
 * connection. Counts and a time only — never a payload or an account id.
 */
export interface EnqueueFailures {
  count: number;
  lastAt: string | null;
  lastStage: 'start' | 'send' | null;
}

export function enqueueFailures(): EnqueueFailures {
  return globalCache.__skEnqueueFailures ?? { count: 0, lastAt: null, lastStage: null };
}

export function recordEnqueueFailure(stage: 'start' | 'send'): void {
  const previous = enqueueFailures();
  globalCache.__skEnqueueFailures = {
    count: previous.count + 1,
    lastAt: new Date().toISOString(),
    lastStage: stage,
  };
}

async function startBoss(): Promise<PgBoss> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required (see .env.example)');
  const boss = new PgBoss(url);
  boss.on('error', (error) => {
    // Message only: connection errors can embed the connection string.
    console.error('[admin pg-boss]', error instanceof Error ? error.message : String(error));
  });
  try {
    await boss.start();
  } catch (error: unknown) {
    // start() may already have opened a pool; close it rather than leak one
    // per failed attempt. Best effort — the original error is what matters.
    void boss.stop({ graceful: false }).catch(() => undefined);
    throw error;
  }
  return boss;
}

/**
 * The shared instance, started once.
 *
 * A FAILED START IS NOT CACHED. The promise used to be stored with `??=`, and a
 * rejected promise is not nullish — so one transient failure (the database
 * restarting, a connection-limit blip) was remembered for the life of the
 * container, and every later RSVP confirmation, waitlist promotion and badge
 * evaluation was silently dropped by callers that log and carry on. Now the
 * cache is cleared the moment a start fails, and the next call tries again.
 */
export function getBoss(): Promise<PgBoss> {
  const cached = globalCache.__skBoss;
  if (cached) return cached;
  const starting = startBoss().catch((error: unknown) => {
    // Only clear OUR attempt: a concurrent caller may already have replaced it.
    if (globalCache.__skBoss === starting) globalCache.__skBoss = undefined;
    recordEnqueueFailure('start');
    throw error;
  });
  globalCache.__skBoss = starting;
  return starting;
}
