import { describe, expect, it } from 'vitest';

import { checkDbHealth } from './health';

const hasDb = Boolean(process.env.DATABASE_URL);

// Integration test against the real dev/CI database (compose.dev.yml).
// Skips when no DATABASE_URL is configured (e.g. the DB-less CI unit job).
describe.skipIf(!hasDb)('checkDbHealth (requires running database)', () => {
  it('reports PostGIS and passes the ST_DWithin smoke query', async () => {
    const health = await checkDbHealth();
    expect(health.postgisVersion).toMatch(/^\d/);
    expect(health.dwithinOk).toBe(true);
  });
});
