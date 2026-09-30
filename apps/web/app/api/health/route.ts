import { NextResponse } from 'next/server';

import { checkDbHealth, getDb } from '@sportkarta/db';

import { readWorkerHeartbeat, workerRequired, type WorkerHeartbeat } from '@/lib/ops-health';

export const dynamic = 'force-dynamic';

/**
 * The deploy gate (deploy.yml curls this) and the web container's healthcheck.
 *
 * It used to check the database alone, so a worker that crashed on boot — the
 * only sender of session mail, and the runner of every schedule — deployed as
 * healthy (pre-launch audit finding 133). It now also reads the worker
 * heartbeat (lib/ops-health.ts) and, in production, answers 503 `degraded`
 * once the last completed ping is older than twenty minutes.
 *
 * A fresh deploy still passes: the worker pings as the last step of its boot,
 * the gate retries for five minutes, and a database where no worker has ever
 * pinged gets a ten-minute grace from this process's start. The response names
 * no person and carries nothing but times, so it stays unauthenticated.
 */
async function worker(): Promise<WorkerHeartbeat> {
  try {
    return await readWorkerHeartbeat(getDb(), process.uptime());
  } catch (error) {
    // A broken probe must not fail a healthy site: the database answered the
    // check above, so this is the heartbeat query itself. Message only.
    console.error(
      '[health] worker heartbeat unreadable',
      error instanceof Error ? error.message : '',
    );
    return { status: 'unknown', lastBeatAt: null, ageSeconds: null };
  }
}

export async function GET() {
  let postgis: string;
  try {
    const db = await checkDbHealth();
    if (!db.dwithinOk) {
      return NextResponse.json(
        { status: 'error', reason: 'st_dwithin smoke query found no rows' },
        { status: 500 },
      );
    }
    postgis = db.postgisVersion;
  } catch (error) {
    // Log the error only — no request/user data (CLAUDE.md: no PII in logs).
    console.error('[health] database check failed', error);
    return NextResponse.json({ status: 'error', reason: 'database unreachable' }, { status: 500 });
  }

  const heartbeat = await worker();
  if (heartbeat.status === 'stale' && workerRequired()) {
    return NextResponse.json(
      { status: 'degraded', reason: 'worker heartbeat stale', postgis, worker: heartbeat },
      { status: 503 },
    );
  }
  return NextResponse.json({ status: 'ok', postgis, worker: heartbeat });
}
