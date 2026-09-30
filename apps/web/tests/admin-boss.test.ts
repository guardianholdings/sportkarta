import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * getBoss() must not remember a failed start (pre-launch audit finding 58).
 *
 * It used to cache the start promise with `??=`. A rejected promise is not
 * nullish, so ONE transient failure — the database restarting under the web
 * container, a connection-limit blip — was cached for the life of the process,
 * and every later RSVP confirmation, waitlist promotion, cancellation notice and
 * badge evaluation was dropped by callers that log and carry on. Nothing
 * recovered it but a container restart.
 */

const behaviour = { failuresLeft: 0, starts: 0, stops: 0 };

vi.mock('pg-boss', () => ({
  default: class FakeBoss {
    on(): this {
      return this;
    }
    start(): Promise<void> {
      behaviour.starts += 1;
      if (behaviour.failuresLeft > 0) {
        behaviour.failuresLeft -= 1;
        return Promise.reject(new Error('the database system is starting up'));
      }
      return Promise.resolve();
    }
    stop(): Promise<void> {
      behaviour.stops += 1;
      return Promise.resolve();
    }
  },
}));

const cache = globalThis as { __skBoss?: unknown; __skEnqueueFailures?: unknown };

beforeEach(() => {
  process.env.DATABASE_URL = 'postgres://localhost:5433/sportkarta';
  behaviour.failuresLeft = 0;
  behaviour.starts = 0;
  behaviour.stops = 0;
  delete cache.__skBoss;
  delete cache.__skEnqueueFailures;
});

afterEach(() => {
  delete cache.__skBoss;
  delete cache.__skEnqueueFailures;
});

describe('getBoss', () => {
  it('retries after a failed start instead of caching the rejection', async () => {
    const { getBoss } = await import('@/lib/admin-boss');
    behaviour.failuresLeft = 1;

    await expect(getBoss()).rejects.toThrow('starting up');
    // The next caller gets a fresh attempt, and it succeeds.
    await expect(getBoss()).resolves.toBeDefined();
    expect(behaviour.starts).toBe(2);
  });

  it('closes the half-started instance rather than leaking its pool', async () => {
    const { getBoss } = await import('@/lib/admin-boss');
    behaviour.failuresLeft = 1;

    await expect(getBoss()).rejects.toThrow();
    expect(behaviour.stops).toBe(1);
  });

  it('shares one successful start between callers', async () => {
    const { getBoss } = await import('@/lib/admin-boss');
    const [a, b] = await Promise.all([getBoss(), getBoss()]);
    expect(a).toBe(b);
    await getBoss();
    expect(behaviour.starts).toBe(1);
  });

  it('counts failed starts for the health page', async () => {
    const { enqueueFailures, getBoss } = await import('@/lib/admin-boss');
    expect(enqueueFailures().count).toBe(0);
    behaviour.failuresLeft = 2;

    await expect(getBoss()).rejects.toThrow();
    await expect(getBoss()).rejects.toThrow();

    const failures = enqueueFailures();
    expect(failures.count).toBe(2);
    expect(failures.lastStage).toBe('start');
    expect(failures.lastAt).not.toBeNull();
  });
});
