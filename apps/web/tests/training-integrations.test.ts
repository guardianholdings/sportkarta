import { describe, expect, it } from 'vitest';

import { trainingIntegrationsEnabled } from '@/lib/training-integrations';

/**
 * The training-log consents for connected apps are not asked for until an
 * integration exists to use them (pre-launch audit). The flag is the switch,
 * and it must fail closed: only an explicit "true" turns it on.
 */
describe('trainingIntegrationsEnabled', () => {
  it('ships off', () => {
    expect(trainingIntegrationsEnabled({})).toBe(false);
  });

  it('turns on only for an explicit true', () => {
    expect(trainingIntegrationsEnabled({ TRAINING_INTEGRATIONS_ENABLED: 'true' })).toBe(true);
    expect(trainingIntegrationsEnabled({ TRAINING_INTEGRATIONS_ENABLED: ' TRUE ' })).toBe(true);
    for (const value of ['', '1', 'yes', 'on', 'false']) {
      expect(trainingIntegrationsEnabled({ TRAINING_INTEGRATIONS_ENABLED: value }), value).toBe(
        false,
      );
    }
  });
});
