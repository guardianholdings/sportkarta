import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * /api/health is the deploy gate and the web container's healthcheck. It must
 * see the worker (pre-launch audit finding 133) without failing a fresh deploy.
 */

const checkDbHealth = vi.fn();
const readWorkerHeartbeat = vi.fn();
const workerRequired = vi.fn();

vi.mock('@sportkarta/db', () => ({
  checkDbHealth: () => checkDbHealth(),
  getDb: () => ({}),
}));

vi.mock('@/lib/ops-health', () => ({
  readWorkerHeartbeat: () => readWorkerHeartbeat(),
  workerRequired: () => workerRequired(),
}));

async function get(): Promise<{ status: number; body: Record<string, unknown> }> {
  const { GET } = await import('@/app/api/health/route');
  const response = await GET();
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const dbOk = { postgisVersion: '3.4 USE_GEOS=1', dwithinOk: true };

describe('GET /api/health', () => {
  it('is ok when the database answers and the worker beat recently', async () => {
    checkDbHealth.mockResolvedValue(dbOk);
    readWorkerHeartbeat.mockResolvedValue({ status: 'ok', lastBeatAt: 'x', ageSeconds: 30 });
    workerRequired.mockReturnValue(true);

    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.worker).toMatchObject({ status: 'ok' });
  });

  it('answers 503 degraded in production when the worker has gone quiet', async () => {
    checkDbHealth.mockResolvedValue(dbOk);
    readWorkerHeartbeat.mockResolvedValue({ status: 'stale', lastBeatAt: 'x', ageSeconds: 3600 });
    workerRequired.mockReturnValue(true);

    const { status, body } = await get();
    // curl -f in the deploy gate fails on this, and so does the compose healthcheck.
    expect(status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.reason).toBe('worker heartbeat stale');
  });

  it('stays ok for a worker that is still booting on a fresh deploy', async () => {
    checkDbHealth.mockResolvedValue(dbOk);
    readWorkerHeartbeat.mockResolvedValue({
      status: 'starting',
      lastBeatAt: null,
      ageSeconds: null,
    });
    workerRequired.mockReturnValue(true);

    expect((await get()).status).toBe(200);
  });

  it('does not require a worker outside production', async () => {
    checkDbHealth.mockResolvedValue(dbOk);
    readWorkerHeartbeat.mockResolvedValue({ status: 'stale', lastBeatAt: null, ageSeconds: null });
    workerRequired.mockReturnValue(false);

    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.worker).toMatchObject({ status: 'stale' });
  });

  it('does not fail a healthy site when the heartbeat probe itself breaks', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    checkDbHealth.mockResolvedValue(dbOk);
    readWorkerHeartbeat.mockRejectedValue(new Error('permission denied for schema pgboss'));
    workerRequired.mockReturnValue(true);

    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.worker).toMatchObject({ status: 'unknown' });
  });

  it('still reports the database first', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    checkDbHealth.mockRejectedValue(new Error('ECONNREFUSED'));

    const { status, body } = await get();
    expect(status).toBe(500);
    expect(body.reason).toBe('database unreachable');
    expect(readWorkerHeartbeat).not.toHaveBeenCalled();
  });
});
