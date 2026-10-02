import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchWithRetry, RETRY_DELAYS_MS } from './download.js';

/**
 * The Geofabrik fetch retries a mirror's bad minute and nothing else. The
 * weekly import canary (.github/workflows/audit.yml) went red on 2026-09-07
 * for a single transient 502; a moved file must still fail at once.
 */

const MD5_URL = 'https://download.example/bulgaria-latest.osm.pbf.md5';

function answering(...outcomes: (number | Error)[]) {
  const fetchMock = vi.fn(() => {
    const next = outcomes.shift();
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(new Response('body', { status: next ?? 200 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const noSleep = () => Promise.resolve();

describe('fetchWithRetry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a success at once', async () => {
    const fetchMock = answering(200);
    const response = await fetchWithRetry(MD5_URL, RETRY_DELAYS_MS, noSleep);
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a 502 and a dropped connection, then succeeds', async () => {
    const fetchMock = answering(502, new TypeError('fetch failed'), 200);
    const sleep = vi.fn<(ms: number) => Promise<void>>(noSleep);
    const response = await fetchWithRetry(MD5_URL, RETRY_DELAYS_MS, sleep);
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([...RETRY_DELAYS_MS]);
  });

  it('retries a 429 too', async () => {
    const fetchMock = answering(429, 200);
    expect((await fetchWithRetry(MD5_URL, RETRY_DELAYS_MS, noSleep)).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 404 — a moved file will not come back', async () => {
    const fetchMock = answering(404, 200);
    expect((await fetchWithRetry(MD5_URL, RETRY_DELAYS_MS, noSleep)).status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('hands back the last answer once the attempts run out', async () => {
    const fetchMock = answering(503, 502, 502);
    expect((await fetchWithRetry(MD5_URL, RETRY_DELAYS_MS, noSleep)).status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(RETRY_DELAYS_MS.length + 1);
  });

  it('rethrows the last network error once the attempts run out', async () => {
    answering(new TypeError('a'), new TypeError('b'), new TypeError('c'));
    await expect(fetchWithRetry(MD5_URL, RETRY_DELAYS_MS, noSleep)).rejects.toThrow('c');
  });
});
