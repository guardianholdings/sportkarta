import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// TILES_DIR is read once at module load, so it must be set before the dynamic
// import below. The route serves the self-hosted .pmtiles with range support
// (the dev-only equivalent of Caddy's file_server); pmtiles.js needs it.
let route: typeof import('../app/tiles/[...path]/route');
let dir: string;
const BODY = Buffer.from('PMTILES-FIXTURE-0123456789-abcdefghij'); // 37 bytes

function req(range?: string): Request {
  return new Request('http://localhost/tiles/test.pmtiles', {
    headers: range ? { range } : {},
  });
}

const ctx = { params: Promise.resolve({ path: ['test.pmtiles'] }) };

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sportkarta-tiles-'));
  await writeFile(path.join(dir, 'test.pmtiles'), BODY);
  process.env.TILES_DIR = dir;
  route = await import('../app/tiles/[...path]/route');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('tiles range route', () => {
  it('serves the whole file with 200 + Accept-Ranges', async () => {
    const res = await route.GET(req(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-length')).toBe(String(BODY.length));
    expect(Buffer.from(await res.arrayBuffer())).toEqual(BODY);
  });

  it('serves a byte range with 206 + Content-Range', async () => {
    const res = await route.GET(req('bytes=5-14'), ctx);
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 5-14/${String(BODY.length)}`);
    expect(res.headers.get('content-length')).toBe('10');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(BODY.subarray(5, 15));
  });

  it('clamps an open-ended range to the file size', async () => {
    const res = await route.GET(req('bytes=30-'), ctx);
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 30-36/${String(BODY.length)}`);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(BODY.subarray(30));
  });

  it('serves a suffix range (last N bytes)', async () => {
    const res = await route.GET(req('bytes=-7'), ctx);
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 30-36/${String(BODY.length)}`);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(BODY.subarray(30));
  });

  it('returns 416 for an unsatisfiable range', async () => {
    const res = await route.GET(req('bytes=999-1000'), ctx);
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe(`bytes */${String(BODY.length)}`);
  });

  it('HEAD reports size without a body', async () => {
    const res = await route.HEAD(req(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(BODY.length));
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it('404s a missing file (basemap absent → map degrades)', async () => {
    const res = await route.GET(new Request('http://localhost/tiles/missing.pmtiles'), {
      params: Promise.resolve({ path: ['missing.pmtiles'] }),
    });
    expect(res.status).toBe(404);
  });

  it('rejects path traversal and non-pmtiles keys', async () => {
    const traversal = await route.GET(new Request('http://localhost/tiles/x'), {
      params: Promise.resolve({ path: ['..', '..', 'etc', 'passwd'] }),
    });
    expect(traversal.status).toBe(404);

    const wrongExt = await route.GET(new Request('http://localhost/tiles/x'), {
      params: Promise.resolve({ path: ['test.txt'] }),
    });
    expect(wrongExt.status).toBe(404);
  });
});
