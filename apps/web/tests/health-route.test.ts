import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

vi.mock('@/lib/ops-health', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ops-health')>()),
  readWorkerHeartbeat: () => readWorkerHeartbeat(),
  workerRequired: () => workerRequired(),
}));

async function get(query = ''): Promise<{ status: number; body: Record<string, unknown> }> {
  const { GET } = await import('@/app/api/health/route');
  const response = await GET(new Request(`http://localhost/api/health${query}`));
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

describe('GET /api/health?workerSince= — the deploy gate (finding 133)', () => {
  // When the running worker container started, on the VPS clock.
  const started = Date.parse('2026-10-02T09:00:00.000Z');
  const query = `?workerSince=${String(started)}`;

  it('answers 503 while the last ping predates the new worker — a crash on boot', async () => {
    checkDbHealth.mockResolvedValue(dbOk);
    // The PREVIOUS worker pinged four minutes earlier: "ok" by the staleness
    // rule, which is exactly how a dead new worker used to deploy green.
    readWorkerHeartbeat.mockResolvedValue({
      status: 'ok',
      lastBeatAt: '2026-10-02T08:56:00.000Z',
      ageSeconds: 240,
    });
    workerRequired.mockReturnValue(true);

    const { status, body } = await get(query);
    expect(status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.reason).toBe('no worker heartbeat since workerSince');
  });

  it('passes once the new worker has finished booting and pinged', async () => {
    checkDbHealth.mockResolvedValue(dbOk);
    readWorkerHeartbeat.mockResolvedValue({
      status: 'ok',
      lastBeatAt: '2026-10-02T09:00:04.250Z',
      ageSeconds: 2,
    });
    workerRequired.mockReturnValue(true);

    expect((await get(query)).status).toBe(200);
  });

  it('does not let the never-beaten grace or an unreadable probe through', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    checkDbHealth.mockResolvedValue(dbOk);
    workerRequired.mockReturnValue(true);

    readWorkerHeartbeat.mockResolvedValue({
      status: 'starting',
      lastBeatAt: null,
      ageSeconds: null,
    });
    expect((await get(query)).status).toBe(503);

    readWorkerHeartbeat.mockRejectedValue(new Error('permission denied for schema pgboss'));
    expect((await get(query)).status).toBe(503);
  });

  it('applies whatever NODE_ENV says, because the caller asked', async () => {
    checkDbHealth.mockResolvedValue(dbOk);
    readWorkerHeartbeat.mockResolvedValue({ status: 'stale', lastBeatAt: null, ageSeconds: null });
    workerRequired.mockReturnValue(false);

    expect((await get(query)).status).toBe(503);
  });

  it('refuses a malformed value instead of quietly dropping the check', async () => {
    for (const bad of ['', 'yesterday', '1.5', '-1', '1'.repeat(17)]) {
      const { status } = await get(`?workerSince=${bad}`);
      expect(status, bad).toBe(400);
    }
    expect(checkDbHealth).not.toHaveBeenCalled();
  });

  it("is what deploy.yml asks, with the worker container's own start time", () => {
    const deploy = readFileSync(
      join(__dirname, '..', '..', '..', '.github', 'workflows', 'deploy.yml'),
      'utf8',
    );
    const gate = deploy.slice(deploy.indexOf('- name: Health check (fail loudly)'));
    expect(gate).toMatch(/ps -a -q worker/);
    expect(gate).toMatch(/\{\{\.State\.StartedAt\}\}/);
    expect(gate).toMatch(/\/api\/health\?workerSince=\$since/);
    // An empty or garbled start time must fail the deploy, not drop the check.
    expect(gate).toMatch(/\^\[0-9\]\{13\}\$/);
  });
});
