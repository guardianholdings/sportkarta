import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The enqueue hook both erasure paths hand to deleteAccount — the member's own
 * on /profil and an admin's on /admin/akaunti/[id].
 *
 * deleteAccount calls it AFTER the erasure has committed, so it must never be
 * able to throw: a queue that is briefly down would otherwise turn a completed
 * erasure into an error page, and the admin (or member) would try again on an
 * account that no longer exists. What is lost is one cancellation notice; what
 * must not be lost is the erasure.
 */

const send = vi.fn();
const getBoss = vi.fn();

vi.mock('@/lib/admin-boss', () => ({
  getBoss: () => getBoss(),
}));

async function subject() {
  const mod = await import('@/lib/account-erasure-notify');
  return mod.enqueueErasureNotice;
}

const SESSION = '8e4a1b8c-0d7e-4a8e-9c35-2b8f0c9d1e21';

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('enqueueErasureNotice', () => {
  it('hands the job to pg-boss unchanged', async () => {
    getBoss.mockResolvedValue({ send });
    const enqueue = await subject();

    await enqueue('session.notify', { reason: 'series_cancelled', sessionId: SESSION });

    expect(send).toHaveBeenCalledWith('session.notify', {
      reason: 'series_cancelled',
      sessionId: SESSION,
    });
  });

  it('does NOT throw when the queue is unreachable, and logs the message only', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getBoss.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:5433'));
    const enqueue = await subject();

    await expect(
      enqueue('session.notify', { reason: 'series_cancelled', sessionId: SESSION }),
    ).resolves.toBeUndefined();

    expect(spy).toHaveBeenCalledTimes(1);
    const args = spy.mock.calls[0] ?? [];
    // The message, never the error object, and nothing from the payload.
    expect(args.every((arg) => typeof arg === 'string')).toBe(true);
    expect(args.join(' ')).toContain('ECONNREFUSED');
    expect(args.join(' ')).not.toContain(SESSION);
  });

  it('does NOT throw when the send itself fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getBoss.mockResolvedValue({
      send: vi.fn().mockRejectedValue(new Error('queue session.notify does not exist')),
    });
    const enqueue = await subject();

    await expect(
      enqueue('session.notify', { reason: 'series_cancelled', sessionId: SESSION }),
    ).resolves.toBeUndefined();
  });
});
