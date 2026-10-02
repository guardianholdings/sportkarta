import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Signed-in writes that used to have no throttle (pre-launch audit finding 7).
 *
 *  - markPresentAction queued a badge-evaluation job in `finally` — after a
 *    refusal too, and for whatever member id the caller posted — so any account
 *    could fill the worker's queue by posting random ids to a roster it does
 *    not organise, ahead of session reminders and notification mail.
 *  - logTrainingAction had no limit at all.
 */

const checkIn = vi.fn();
const enqueuePassportEvaluate = vi.fn<(userId: string) => Promise<void>>(() => Promise.resolve());
const recordTraining = vi.fn<(...args: unknown[]) => Promise<string>>(() => Promise.resolve('t1'));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({
  requireUser: () => Promise.resolve({ id: 'organiser_1', role: 'user' }),
}));
vi.mock('@/lib/sessions/checkin', () => ({
  checkIn: (...args: unknown[]) => checkIn(...args),
}));
vi.mock('@/lib/passport-evaluate', () => ({
  enqueuePassportEvaluate: (userId: string) => enqueuePassportEvaluate(userId),
}));
vi.mock('@sportkarta/db', () => ({
  getDb: () => ({}),
  recordTraining: (...args: unknown[]) => recordTraining(...args),
  deleteTraining: vi.fn(),
  setTrainingConsent: vi.fn(),
}));

const OCCURRENCE = '22222222-2222-4222-8222-222222222222';
const limiterCache = globalThis as {
  __rosterRateLimiter?: unknown;
  __trainingRateLimiter?: unknown;
};

beforeEach(() => {
  // Fresh limiters per test: they live on globalThis, like in the app.
  delete limiterCache.__rosterRateLimiter;
  delete limiterCache.__trainingRateLimiter;
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllMocks();
});

async function markPresent() {
  const mod = await import('@/app/[locale]/sesiya/[occurrenceId]/roster/actions');
  return mod.markPresentAction;
}

/** From the SAME module graph as the action (modules are reset per test). */
async function sessionError(code: string): Promise<Error> {
  const { SessionError } = await import('@/lib/sessions/errors');
  return new SessionError(code as ConstructorParameters<typeof SessionError>[0]);
}

describe('markPresentAction', () => {
  it('queues badge evaluation only for a check-in it actually recorded', async () => {
    checkIn.mockResolvedValue({ created: true });
    await (
      await markPresent()
    )(OCCURRENCE, 'member_1');
    expect(enqueuePassportEvaluate).toHaveBeenCalledWith('member_1');
  });

  it('queues nothing when the member was already checked in', async () => {
    checkIn.mockResolvedValue({ created: false });
    await (
      await markPresent()
    )(OCCURRENCE, 'member_1');
    expect(enqueuePassportEvaluate).not.toHaveBeenCalled();
  });

  it('queues nothing when the check-in was refused (not the organiser, forged id)', async () => {
    checkIn.mockRejectedValue(await sessionError('not_organizer'));
    await (
      await markPresent()
    )(OCCURRENCE, 'random-id');
    expect(enqueuePassportEvaluate).not.toHaveBeenCalled();
  });

  it('stops touching the database past the per-account budget', async () => {
    checkIn.mockRejectedValue(await sessionError('not_attending'));
    const action = await markPresent();
    for (let i = 0; i < 200; i++) await action(OCCURRENCE, `m${String(i)}`);
    expect(checkIn).toHaveBeenCalledTimes(200);

    await action(OCCURRENCE, 'one-more');
    expect(checkIn).toHaveBeenCalledTimes(200);
  });
});

describe('logTrainingAction', () => {
  function form(): FormData {
    const data = new FormData();
    data.set('sport', 'running');
    data.set('startedAt', '2026-09-01T07:30');
    data.set('duration', '40');
    return data;
  }

  it('refuses past the per-account budget without writing', async () => {
    const { logTrainingAction } = await import('@/app/[locale]/trenirovki/actions');
    for (let i = 0; i < 30; i++) {
      const state = await logTrainingAction({ problems: [] }, form());
      expect(state.problems).toEqual([]);
    }
    expect(recordTraining).toHaveBeenCalledTimes(30);

    const refused = await logTrainingAction({ problems: [] }, form());
    expect(refused.problems).toEqual(['rate_limited']);
    expect(recordTraining).toHaveBeenCalledTimes(30);
  });
});
