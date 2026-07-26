import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The enqueue must never be able to break a contribution or a check-in.
 *
 * This is the load-bearing property of moving badge evaluation into a job
 * (docs/ENGAGEMENT-IMPLEMENTATION.md phase 3 / A1). The five call sites run
 * AFTER their transaction commits, but they still `await` this function, so if
 * it could throw it would surface as a failed server action on a write that
 * already succeeded — and in the check-in path it would contradict the rule the
 * whole anti-abuse layer is built on, stated in apps/web/lib/sessions/checkin.ts:
 *
 *     "Nothing on that list REFUSES a check-in. Attendance is a fact and is
 *      always recorded; only the payment stops."
 *
 * An engagement feature that can make an attendance look like it failed is
 * strictly worse than one that silently records a badge late — which costs
 * nothing, because `ownPassport()` still evaluates on the member's next visit
 * and the insert is ON CONFLICT DO NOTHING.
 *
 * The plan listed this as a risk bullet. It is a deliverable.
 */

const send = vi.fn();
const getBoss = vi.fn();

vi.mock('@/lib/admin-boss', () => ({
  PASSPORT_EVALUATE_QUEUE: 'passport.evaluate',
  getBoss: () => getBoss(),
}));

async function subject() {
  const mod = await import('@/lib/passport-evaluate');
  return mod.enqueuePassportEvaluate;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('enqueuePassportEvaluate', () => {
  it('enqueues the ACCOUNT ID and nothing else', async () => {
    getBoss.mockResolvedValue({ send });
    const enqueue = await subject();

    await enqueue('user_123');

    expect(send).toHaveBeenCalledTimes(1);
    const [queue, payload] = send.mock.calls[0] as [string, Record<string, unknown>];
    expect(queue).toBe('passport.evaluate');
    // A job row outlives the account it names, so the payload must resolve at
    // run time rather than carry anything about the person.
    expect(Object.keys(payload)).toEqual(['userId']);
    expect(payload.userId).toBe('user_123');
  });

  it('does NOT throw when the queue is unreachable', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getBoss.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:5433'));
    const enqueue = await subject();

    // The whole point: a caller that awaits this cannot be made to fail.
    await expect(enqueue('user_123')).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
  });

  it('does NOT throw when the send itself fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getBoss.mockResolvedValue({
      send: vi.fn().mockRejectedValue(new Error('queue passport.evaluate does not exist')),
    });
    const enqueue = await subject();

    await expect(enqueue('user_123')).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
  });

  it('logs the MESSAGE, never the error object', async () => {
    // A pg-boss connection error can embed the connection string, which carries
    // the database password. The existing session-notify helper takes the same
    // care and this must not diverge from it.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getBoss.mockRejectedValue(new Error('postgres://user:hunter2@db:5432/sportkarta unreachable'));
    const enqueue = await subject();

    await enqueue('user_123');

    for (const call of spy.mock.calls) {
      for (const arg of call) {
        expect(arg instanceof Error, 'the Error object itself must not be logged').toBe(false);
      }
    }
  });

  it('never logs the account id', async () => {
    // Counts and categories only — an account id identifies a person even with
    // no name attached (CLAUDE.md: no PII in logs).
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getBoss.mockRejectedValue(new Error('boom'));
    const enqueue = await subject();

    await enqueue('user_secret_id');

    const logged = spy.mock.calls.flat().map(String).join(' ');
    expect(logged).not.toContain('user_secret_id');
  });
});
