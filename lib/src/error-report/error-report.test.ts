import { describe, expect, it, vi } from 'vitest';

import {
  buildExceptionEvent,
  createErrorReporter,
  envelopeUrl,
  parseDsn,
  parseStack,
  reportFailures,
  scrubText,
  serializeEnvelope,
} from './index';

const DSN = 'https://abc123@glitchtip.example.org/7';

function okFetch() {
  return vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(new Response(null, { status: 200 })),
  );
}

describe('parseDsn', () => {
  it('reads key, origin and project', () => {
    const dsn = parseDsn(DSN);
    expect(dsn).toEqual({
      origin: 'https://glitchtip.example.org',
      pathPrefix: '',
      projectId: '7',
      publicKey: 'abc123',
    });
    if (!dsn) throw new Error('expected a DSN');
    expect(envelopeUrl(dsn)).toBe('https://glitchtip.example.org/api/7/envelope/');
  });

  it('keeps a port and a path prefix', () => {
    const dsn = parseDsn('http://k@localhost:3002/sentry/12');
    expect(dsn && envelopeUrl(dsn)).toBe('http://localhost:3002/sentry/api/12/envelope/');
  });

  it('treats empty and malformed values as "reporting off"', () => {
    for (const raw of [undefined, null, '', '   ', 'not a url', 'https://host/1', 'ftp://k@h/1']) {
      expect(parseDsn(raw)).toBeNull();
    }
    expect(parseDsn('https://k@host/not-a-number')).toBeNull();
  });
});

describe('scrubText', () => {
  it('removes credentials from connection strings', () => {
    expect(scrubText('connect failed: postgres://sportkarta:hunter2@db:5432/sportkarta')).toBe(
      'connect failed: postgres://[redacted]@db:5432/sportkarta',
    );
  });

  it('removes e-mail addresses', () => {
    expect(scrubText('duplicate key (email)=(maria.ivanova@example.bg)')).toBe(
      'duplicate key (email)=([email])',
    );
  });

  it('drops query strings, which carry tokens and handles', () => {
    expect(scrubText('GET /api/calendar/feed.ics?token=abc&x=1 failed')).toBe(
      'GET /api/calendar/feed.ics?[query] failed',
    );
  });

  it('removes IP addresses, long hex tokens and phone-like numbers', () => {
    expect(scrubText('from 203.0.113.9')).toBe('from [ip]');
    expect(scrubText(`key ${'a1'.repeat(32)}`)).toBe('key [token]');
    expect(scrubText('call +359 888 123 456')).toBe('call [number]');
  });

  it('leaves UUIDs and ordinary messages readable', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    expect(scrubText(`facility ${id} not found`)).toBe(`facility ${id} not found`);
  });

  it('caps the length', () => {
    expect(scrubText('x'.repeat(10_000)).length).toBe(2000);
  });
});

describe('parseStack', () => {
  it('parses V8 frames outermost first and marks library code', () => {
    const error = new Error('boom');
    error.stack = [
      'Error: boom',
      '    at inner (/app/apps/web/lib/x.ts:10:5)',
      '    at /app/node_modules/next/dist/server.js:1:2',
      '    at node:internal/process/task_queues:95:5',
    ].join('\n');
    const frames = parseStack(error.stack);
    expect(frames.map((f) => f.filename)).toEqual([
      'node:internal/process/task_queues',
      '/app/node_modules/next/dist/server.js',
      '/app/apps/web/lib/x.ts',
    ]);
    expect(frames[2]).toMatchObject({ function: 'inner', lineno: 10, colno: 5, in_app: true });
    expect(frames[1]?.in_app).toBe(false);
  });
});

describe('buildExceptionEvent', () => {
  it('carries the scrubbed message and only primitive, scrubbed context', () => {
    const event = buildExceptionEvent(new Error('bad row for someone@example.org'), {
      component: 'web',
      transaction: '/[locale]/obekt/[slug]',
      tags: { routeType: 'render', skipped: undefined },
      extra: { note: 'see https://x.test/a?token=s3cret' },
      now: 1_700_000_000_000,
    });
    expect(event.exception?.values[0]?.value).toBe('bad row for [email]');
    expect(event.tags).toEqual({ component: 'web', routeType: 'render' });
    expect(event.extra).toEqual({ note: 'see https://x.test/a?[query]' });
    expect(event.transaction).toBe('/[locale]/obekt/[slug]');
    // Never a user, never a request block: there is nowhere for either to go.
    expect(event).not.toHaveProperty('user');
    expect(event).not.toHaveProperty('request');
    expect(event.event_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('reports a thrown non-Error readably', () => {
    const event = buildExceptionEvent('plain string', { component: 'worker', now: 0 });
    expect(event.exception?.values[0]).toEqual({ type: 'NonError', value: 'plain string' });
  });
});

describe('createErrorReporter', () => {
  it('is a no-op without a DSN and never calls fetch', async () => {
    const fetchImpl = okFetch();
    const reporter = createErrorReporter({ dsn: '', component: 'web', fetchImpl });
    expect(reporter.enabled).toBe(false);
    expect(await reporter.captureException(new Error('x'))).toBe(false);
    expect(await reporter.captureMessage('y')).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts an envelope to the project with the public key', async () => {
    const fetchImpl = okFetch();
    const reporter = createErrorReporter({ dsn: DSN, component: 'worker', fetchImpl });
    expect(await reporter.captureException(new Error('job failed'))).toBe(true);

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('https://glitchtip.example.org/api/7/envelope/');
    const headers = init?.headers as Record<string, string>;
    expect(headers['X-Sentry-Auth']).toContain('sentry_key=abc123');
    const lines = String(init?.body).trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[1] ?? '{}')).toEqual({ type: 'event' });
    expect(JSON.parse(lines[2] ?? '{}').tags.component).toBe('worker');
  });

  it('swallows a failing transport', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    const reporter = createErrorReporter({ dsn: DSN, component: 'web', fetchImpl });
    await expect(reporter.captureException(new Error('x'))).resolves.toBe(false);
  });

  it('goes quiet past its per-minute budget, then recovers', async () => {
    const fetchImpl = okFetch();
    let t = 0;
    const reporter = createErrorReporter({
      dsn: DSN,
      component: 'worker',
      fetchImpl,
      maxPerMinute: 2,
      now: () => t,
    });
    expect(await reporter.captureMessage('a')).toBe(true);
    expect(await reporter.captureMessage('b')).toBe(true);
    expect(await reporter.captureMessage('c')).toBe(false);
    t = 61_000;
    expect(await reporter.captureMessage('d')).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('serializes a well-formed envelope', () => {
    const event = buildExceptionEvent(new Error('x'), { component: 'web', now: 0 });
    const text = serializeEnvelope(event, new Date(0));
    expect(JSON.parse(text.split('\n')[0] ?? '{}')).toEqual({
      event_id: event.event_id,
      sent_at: '1970-01-01T00:00:00.000Z',
    });
    expect(text.endsWith('\n')).toBe(true);
  });
});

describe('reportFailures', () => {
  it('reports a rejection and re-throws the SAME error', async () => {
    const fetchImpl = okFetch();
    const reporter = createErrorReporter({ dsn: DSN, component: 'worker', fetchImpl });
    const original = new Error('SMTP relay refused');
    const wrapped = reportFailures(reporter, { tags: { queue: 'digest.weekly' } }, () =>
      Promise.reject(original),
    );

    await expect(wrapped()).rejects.toBe(original);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = String(fetchImpl.mock.calls[0]?.[1]?.body);
    expect(JSON.parse(body.trim().split('\n')[2] ?? '{}').tags.queue).toBe('digest.weekly');
  });

  it('passes results and arguments straight through', async () => {
    const fetchImpl = okFetch();
    const reporter = createErrorReporter({ dsn: DSN, component: 'worker', fetchImpl });
    const wrapped = reportFailures(reporter, {}, (a: number, b: number) => Promise.resolve(a + b));
    await expect(wrapped(2, 3)).resolves.toBe(5);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
