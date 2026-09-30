import { describe, expect, it, vi } from 'vitest';

/**
 * Server-side error capture (pre-launch audit finding 57): what Next hands
 * `onRequestError` includes the request's headers and concrete path. Neither
 * may reach GlitchTip — cookies and forwarded IPs are in the first, account
 * ids and tokens can be in the second.
 */

const captureException = vi.fn<(error: unknown, context?: unknown) => Promise<boolean>>(() =>
  Promise.resolve(true),
);
const createErrorReporter = vi.fn<
  (options: unknown) => { captureException: typeof captureException }
>(() => ({ captureException }));

vi.mock('@sportkarta/lib/error-report', () => ({
  createErrorReporter: (options: unknown) => createErrorReporter(options),
}));

describe('onRequestError', () => {
  it('reports the route template, method and digest — never headers or the path', async () => {
    process.env.GLITCHTIP_DSN = 'https://k@glitchtip.example.org/1';
    const { onRequestError } = await import('@/instrumentation');

    const error = Object.assign(new Error('boom'), { digest: '12345' });
    await onRequestError(
      error,
      {
        path: '/admin/akaunti/user_abc?token=secret',
        method: 'POST',
        headers: { cookie: 'better-auth.session_token=s3cret', 'x-forwarded-for': '203.0.113.9' },
      },
      {
        routerKind: 'App Router',
        routePath: '/[locale]/admin/(protected)/akaunti/[id]',
        routeType: 'action',
        revalidateReason: undefined,
      },
    );

    expect(createErrorReporter).toHaveBeenCalledWith(
      expect.objectContaining({ dsn: 'https://k@glitchtip.example.org/1', component: 'web' }),
    );
    expect(captureException).toHaveBeenCalledTimes(1);
    const [reported, context] = captureException.mock.calls[0] ?? [];
    expect(reported).toBe(error);
    expect(context).toMatchObject({
      transaction: '/[locale]/admin/(protected)/akaunti/[id]',
      tags: { method: 'POST', routeType: 'action', routerKind: 'App Router' },
      extra: { digest: '12345' },
    });
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain('user_abc');
    expect(serialized).not.toContain('s3cret');
    expect(serialized).not.toContain('203.0.113.9');
    expect(serialized).not.toContain('token=');
  });
});
