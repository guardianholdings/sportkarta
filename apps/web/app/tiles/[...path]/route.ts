import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

// Local-dev equivalent of Caddy's `handle_path /tiles/*` file_server: serves
// the self-hosted .pmtiles basemap with HTTP range support, which pmtiles.js
// relies on to read the archive header and individual tiles. In production
// Caddy intercepts /tiles/* before Next ever runs, so this route is dev-only.
// The middleware matcher already excludes dotted paths, so no i18n rewrite.

export const dynamic = 'force-dynamic';

// Repo-root deploy/tiles by default (next dev cwd = apps/web); override with
// TILES_DIR. Resolved once so every request compares against the same root.
const TILES_DIR = path.resolve(
  process.env.TILES_DIR ?? path.join(process.cwd(), '../../deploy/tiles'),
);

// Keys are user-influenced: only forward-slash, dot, dash, alnum; must end in
// .pmtiles; the resolved path must stay inside TILES_DIR (no traversal).
function resolveTilePath(segments: string[]): string | null {
  const rel = segments.join('/');
  if (!/^[A-Za-z0-9][A-Za-z0-9/_.-]*\.pmtiles$/.test(rel) || rel.includes('..')) {
    return null;
  }
  const resolved = path.resolve(TILES_DIR, rel);
  if (resolved !== TILES_DIR && !resolved.startsWith(TILES_DIR + path.sep)) {
    return null;
  }
  return resolved;
}

const BASE_HEADERS: Record<string, string> = {
  'Content-Type': 'application/octet-stream',
  'Accept-Ranges': 'bytes',
  // Matches deploy/Caddyfile so dev and prod behave identically.
  'Cache-Control': 'public, max-age=86400',
  'Access-Control-Allow-Origin': '*',
};

// "bytes=START-END" (both optional). Returns an inclusive, clamped range or
// null (whole file); "unsatisfiable" signals a 416.
function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null | 'unsatisfiable' {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  let start: number;
  let end: number;
  if (rawStart === '') {
    // Suffix range: last N bytes.
    const suffix = Number(rawEnd);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (start > end || start >= size) return 'unsatisfiable';
  return { start, end };
}

async function serve(segments: string[], method: 'GET' | 'HEAD', rangeHeader: string | null) {
  const filePath = resolveTilePath(segments);
  if (!filePath) return new Response('Not found', { status: 404 });

  let size: number;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return new Response('Not found', { status: 404 });
    size = info.size;
  } catch {
    // Absent basemap is expected until tiles are built — the map degrades to a
    // plain background rather than erroring.
    return new Response('Not found', { status: 404 });
  }

  const range = parseRange(rangeHeader, size);
  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { ...BASE_HEADERS, 'Content-Range': `bytes */${String(size)}` },
    });
  }

  if (range) {
    const length = range.end - range.start + 1;
    const headers = {
      ...BASE_HEADERS,
      'Content-Length': String(length),
      'Content-Range': `bytes ${String(range.start)}-${String(range.end)}/${String(size)}`,
    };
    if (method === 'HEAD') return new Response(null, { status: 206, headers });
    // Ranged stream (inclusive end) reads exactly the requested bytes — no
    // short-read / zero-padding risk from a manual buffer read.
    const rangeStream = createReadStream(filePath, { start: range.start, end: range.end });
    const body = Readable.toWeb(rangeStream) as ReadableStream<Uint8Array>;
    return new Response(body, { status: 206, headers });
  }

  const headers = { ...BASE_HEADERS, 'Content-Length': String(size) };
  if (method === 'HEAD') return new Response(null, { status: 200, headers });
  const webStream = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>;
  return new Response(webStream, { status: 200, headers });
}

interface Ctx {
  params: Promise<{ path: string[] }>;
}

export async function GET(request: Request, { params }: Ctx) {
  const { path: segments } = await params;
  return serve(segments, 'GET', request.headers.get('range'));
}

export async function HEAD(request: Request, { params }: Ctx) {
  const { path: segments } = await params;
  return serve(segments, 'HEAD', request.headers.get('range'));
}
