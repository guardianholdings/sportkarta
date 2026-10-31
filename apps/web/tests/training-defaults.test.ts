import { describe, expect, it } from 'vitest';

import { DEFAULT_TRAINING_MINUTES, defaultTrainingStart } from '@/lib/training-defaults';

/**
 * The training form proposes a training that ends now: it starts
 * DEFAULT_TRAINING_MINUTES ago, rounded down to five minutes, on the Sofia wall
 * clock — the clock the action reads the field as, whatever the server's zone.
 */
describe('defaultTrainingStart', () => {
  it('is 45 minutes ago, rounded down to five, in Sofia winter time (+02:00)', () => {
    expect(DEFAULT_TRAINING_MINUTES).toBe(45);
    // 18:07 UTC is 20:07 in Sofia; minus 45 is 19:22; rounded down 19:20.
    expect(defaultTrainingStart(new Date('2026-01-15T18:07:30Z'))).toBe('2026-01-15T19:20');
  });

  it('follows summer time (+03:00)', () => {
    // 06:00 UTC is 09:00 in Sofia; minus 45 is 08:15.
    expect(defaultTrainingStart(new Date('2026-07-01T06:00:00Z'))).toBe('2026-07-01T08:15');
  });

  it('crosses midnight into the day the training started', () => {
    // 22:20 UTC on 1 Jan is 00:20 on 2 Jan in Sofia; minus 45 is 23:35 on 1 Jan.
    expect(defaultTrainingStart(new Date('2026-01-01T22:20:00Z'))).toBe('2026-01-01T23:35');
  });
});
