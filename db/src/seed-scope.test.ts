import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  EXPORT_DIR_ENV,
  FIXTURES_FORBIDDEN_ENV,
  fixtureScopeRefusal,
  isProductionSeed,
  PRODUCTION_FLAG,
  seedSteps,
} from '../scripts/seed-plan.js';

/**
 * Production must never receive the dev/CI fixture world, and dev/CI must keep
 * it. Five fixture pins sat on the public map as verified community data
 * because the deploy ran the one full seed on every release (audit finding 82);
 * the fix is a single flag on a single line of deploy.yml, which is exactly the
 * kind of line a later edit drops without anybody noticing. The fixtures first
 * arrived through a full seed run BY HAND on the new server, so the fixture
 * seed also refuses wherever compose.prod.yml marks the deployment. Pure file
 * test: no database, so it runs everywhere the suite does.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');
const COMPOSE = path.join(ROOT, 'deploy', 'compose.prod.yml');

const FIXTURE_ONLY = ['municipalities', 'facilities', 'assign_municipalities', 'slugs'] as const;

/** Every shell line in a workflow that runs the seed. */
function seedInvocations(workflow: string): string[] {
  return readFileSync(path.join(WORKFLOWS, workflow), 'utf8')
    .split('\n')
    .filter((line) => /\bpnpm\s+db:seed\b/.test(line) && !line.trim().startsWith('#'));
}

interface ComposeService {
  env: Map<string, string>;
  volumes: string[];
}

/**
 * One service's `environment` map and `volumes` list in compose.prod.yml.
 * Hand-parsed and strict about indentation, like
 * apps/web/tests/deploy-worker-env.test.ts: the callers assert on what they
 * find, so a mis-parse fails loudly instead of passing vacuously.
 */
function composeService(compose: string, service: string): ComposeService {
  const env = new Map<string, string>();
  const volumes: string[] = [];
  let inService = false;
  let block = '';
  for (const line of compose.split('\n')) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    if (/^\S/.test(line)) {
      inService = false;
      continue;
    }
    if (/^ {2}\S.*:\s*$/.test(line)) {
      inService = line.trimEnd() === `  ${service}:`;
      block = '';
      continue;
    }
    if (!inService) continue;
    const key = /^ {4}([a-z_]+):\s*$/.exec(line);
    if (key?.[1]) {
      block = key[1];
      continue;
    }
    if (/^ {4}\S/.test(line)) {
      block = '';
      continue;
    }
    const pair = /^ {6}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (block === 'environment' && pair?.[1]) {
      env.set(pair[1], (pair[2] ?? '').replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1'));
    }
    const item = /^ {6}- (\S+)$/.exec(line);
    if (block === 'volumes' && item?.[1]) volumes.push(item[1]);
  }
  return { env, volumes };
}

/** The named volumes declared at the top level of compose.prod.yml. */
function topLevelVolumes(compose: string): string[] {
  const names: string[] = [];
  let inVolumes = false;
  for (const line of compose.split('\n')) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    if (/^\S/.test(line)) {
      inVolumes = line.trimEnd() === 'volumes:';
      continue;
    }
    const name = /^ {2}([a-z0-9-]+):\s*$/.exec(line);
    if (inVolumes && name?.[1]) names.push(name[1]);
  }
  return names;
}

describe('seed scope', () => {
  it('production writes no fixtures, but still what a deployment needs', () => {
    const production = seedSteps(true);
    for (const step of FIXTURE_ONLY) expect(production).not.toContain(step);
    // /api/health smoke-queries _health; migrations 0030/0031 leave the stats
    // refresh to this step; the fixtures' retirement (Boss decision #18) runs
    // before it, so the refreshed figures already leave them out.
    expect(production).toEqual(['health', 'retire_fixtures', 'population', 'stats']);
  });

  it('dev and CI keep the whole fixture world the tests borrow', () => {
    const fixtures = seedSteps(false);
    for (const step of [...FIXTURE_ONLY, 'health', 'population', 'stats'] as const) {
      expect(fixtures).toContain(step);
    }
    // The retirement is production's alone: dev and CI never lose a fixture.
    expect(fixtures).not.toContain('retire_fixtures');
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
      // …and never under the production mark, which would refuse them.
      expect(readFileSync(path.join(WORKFLOWS, workflow), 'utf8')).not.toContain(
        FIXTURES_FORBIDDEN_ENV,
      );
    }
  });
});

describe('the fixture seed refuses production', () => {
  it('refuses where the deployment is marked, or the database has retired them', () => {
    expect(fixtureScopeRefusal({ env: {}, retirementsRecorded: 0 })).toBeNull();
    expect(
      fixtureScopeRefusal({ env: { [FIXTURES_FORBIDDEN_ENV]: 'false' }, retirementsRecorded: 0 }),
    ).toBeNull();
    for (const value of ['true', 'TRUE', '1', 'yes']) {
      expect(
        fixtureScopeRefusal({ env: { [FIXTURES_FORBIDDEN_ENV]: value }, retirementsRecorded: 0 }),
      ).toContain(PRODUCTION_FLAG);
    }
    expect(fixtureScopeRefusal({ env: {}, retirementsRecorded: 7 })).toContain('Boss decision #18');
  });

  it('compose.prod.yml marks the seed container and gives the export a server volume', () => {
    const compose = readFileSync(COMPOSE, 'utf8');
    const migrate = composeService(compose, 'migrate');
    expect(migrate.env.has('DATABASE_URL'), 'compose.prod.yml: migrate service not found').toBe(
      true,
    );
    expect(migrate.env.get(FIXTURES_FORBIDDEN_ENV)).toBe('true');

    const dir = migrate.env.get(EXPORT_DIR_ENV) ?? '';
    expect(dir, `migrate sets no ${EXPORT_DIR_ENV}`).toMatch(/^\/\S+$/);
    // The export lands on a NAMED volume (it outlives `run --rm`, and is not a
    // bind mount into the checkout that a later deploy could overwrite).
    const mounts = migrate.volumes.map((v) => v.split(':'));
    const holding = mounts.find(([, target]) => target && dir.startsWith(`${target}/`));
    expect(holding, `${dir} is not on a volume mounted into migrate`).toBeDefined();
    const volume = holding?.[0] ?? '';
    expect(volume).toMatch(/^[a-z0-9-]+$/);
    expect(topLevelVolumes(compose)).toContain(volume);

    // Only migrate runs the seed, so only migrate mounts the export volume.
    for (const service of ['web', 'worker', 'backup']) {
      const other = composeService(compose, service);
      expect(other.env.size, `compose.prod.yml: ${service} service not found`).toBeGreaterThan(0);
      expect(other.volumes.some((v) => v.startsWith(`${volume}:`))).toBe(false);
    }
  });
});
