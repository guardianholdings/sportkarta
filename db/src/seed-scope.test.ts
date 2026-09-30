import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { isProductionSeed, PRODUCTION_FLAG, seedSteps } from '../scripts/seed-plan.js';

/**
 * Production must never receive the dev/CI fixture world, and dev/CI must keep
 * it. Five fixture pins sat on the public map as verified community data
 * because the deploy ran the one full seed on every release (audit finding 82);
 * the fix is a single flag on a single line of deploy.yml, which is exactly the
 * kind of line a later edit drops without anybody noticing. Pure file test: no
 * database, so it runs everywhere the suite does.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOWS = path.join(HERE, '..', '..', '.github', 'workflows');

const FIXTURE_ONLY = ['municipalities', 'facilities', 'assign_municipalities', 'slugs'] as const;

/** Every shell line in a workflow that runs the seed. */
function seedInvocations(workflow: string): string[] {
  return readFileSync(path.join(WORKFLOWS, workflow), 'utf8')
    .split('\n')
    .filter((line) => /\bpnpm\s+db:seed\b/.test(line) && !line.trim().startsWith('#'));
}

describe('seed scope', () => {
  it('production writes no fixtures, but still what a deployment needs', () => {
    const production = seedSteps(true);
    for (const step of FIXTURE_ONLY) expect(production).not.toContain(step);
    // /api/health smoke-queries _health; migrations 0030/0031 leave the stats
    // refresh to this step.
    expect(production).toEqual(['health', 'population', 'stats']);
  });

  it('dev and CI keep the whole fixture world the tests borrow', () => {
    const fixtures = seedSteps(false);
    for (const step of [...FIXTURE_ONLY, 'health', 'population', 'stats'] as const) {
      expect(fixtures).toContain(step);
    }
    // Population and the refresh come last, after the rows they count.
    expect(fixtures.slice(-2)).toEqual(['population', 'stats']);
  });

  it('reads the scope from the command line only', () => {
    expect(isProductionSeed(['--production'])).toBe(true);
    expect(isProductionSeed([])).toBe(false);
    expect(isProductionSeed(['--prod'])).toBe(false);
  });

  it('the deploy runs the production seed — and nothing else', () => {
    const lines = seedInvocations('deploy.yml');
    expect(lines.length, 'deploy.yml no longer seeds — /api/health needs _health').toBeGreaterThan(
      0,
    );
    for (const line of lines) expect(line).toContain(`pnpm db:seed ${PRODUCTION_FLAG}`);
  });

  it('CI and e2e seed the fixtures their suites borrow', () => {
    for (const workflow of ['ci.yml', 'e2e.yml']) {
      const lines = seedInvocations(workflow);
      expect(lines.length, `${workflow} no longer seeds`).toBeGreaterThan(0);
      for (const line of lines) expect(line).not.toContain(PRODUCTION_FLAG);
    }
  });
});
