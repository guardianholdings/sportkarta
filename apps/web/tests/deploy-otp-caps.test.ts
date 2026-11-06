import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Deploy-config gate for two launch conditions found by the 2026-10-31 audit.
 *
 * 1. SIGN-IN CODE CAPS REACH PRODUCTION. apps/web/lib/auth-rate-limit.ts reads
 *    five OTP_* caps, but compose.prod.yml passed none of them through, so
 *    production ran the code's defaults — 200 codes an hour against a relay
 *    (Migadu Mini) that allows 100 sends a DAY, shared with reminders, digests
 *    and club mail. One address flood could burn the quota in minutes, after
 *    which nobody could sign in. deploy.yml now renders the caps from
 *    repository variables with a production default for the hourly one, and
 *    compose hands them to the web service.
 *
 * 2. A DUMP BEFORE EVERY MIGRATION. The deploy ran `migrate` straight after
 *    pulling images, so a bad migration could only be undone from the 03:30
 *    nightly — up to a day of members' data. It now writes a checked
 *    custom-format dump through the backup image first.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');
const read = (...parts: string[]) => readFileSync(join(REPO_ROOT, ...parts), 'utf8');

const OTP_CAPS = [
  'OTP_SEND_LIMIT_PER_HOUR',
  'OTP_RATE_LIMIT_IP',
  'OTP_RATE_LIMIT_EMAIL',
  'OTP_VERIFY_LIMIT_EMAIL',
  'OTP_VERIFY_LIMIT_IP',
] as const;

/** The relay's daily quota the hourly cap is sized against (Migadu Mini). */
const RELAY_SENDS_PER_DAY = 100;

describe('sign-in code caps reach the production web service', () => {
  const compose = read('deploy', 'compose.prod.yml');
  const deploy = read('.github', 'workflows', 'deploy.yml');

  it('compose passes every cap the rate limiter reads to the web service', () => {
    const web = /^ {2}web:\n([\s\S]*?)^ {2}worker:/m.exec(compose);
    if (!web) throw new Error('compose.prod.yml must declare a web service before the worker');
    for (const cap of OTP_CAPS) {
      expect(web[1], cap).toMatch(new RegExp(`^\\s+${cap}: \\$\\{${cap}:-\\}$`, 'm'));
    }
  });

  it('deploy.yml renders the hourly cap with a default far below the relay quota', () => {
    const line =
      /OTP_SEND_LIMIT_PER_HOUR=\$\{\{ vars\.OTP_SEND_LIMIT_PER_HOUR \|\| '(\d+)' \}\}/.exec(deploy);
    if (!line)
      throw new Error(
        'deploy.yml must render OTP_SEND_LIMIT_PER_HOUR from a repository variable with a default',
      );
    const perHour = Number(line[1]);
    // A whole day of codes at this rate must leave room for every other mail
    // the relay carries: well under half of its daily allowance.
    expect(perHour * 24).toBeLessThan(RELAY_SENDS_PER_DAY * 12);
    expect(perHour).toBeGreaterThanOrEqual(6);
  });

  it('deploy.yml renders the other four caps from repository variables', () => {
    for (const cap of OTP_CAPS.slice(1)) {
      expect(deploy, cap).toMatch(new RegExp(`^\\s+${cap}=\\$\\{\\{ vars\\.${cap} \\}\\}$`, 'm'));
    }
  });

  it('the rate limiter treats an empty passthrough as "use the default"', () => {
    // compose renders `${X:-}` as an empty string when unset; the parser must
    // not read that as a cap of zero, which would switch sign-in off.
    const limiter = read('apps', 'web', 'lib', 'auth-rate-limit.ts');
    expect(limiter).toMatch(/Number\.isInteger\(parsed\) && parsed > 0 \? parsed : fallback/);
  });
});

describe('every deploy dumps the app database before it migrates', () => {
  const deploy = read('.github', 'workflows', 'deploy.yml');

  it('runs a checked pg_dump through the backup image before `migrate`', () => {
    const dump = deploy.indexOf('premigrate-sportkarta-');
    const migrate = deploy.indexOf('--profile ops run --rm migrate');
    expect(dump, 'a pre-migration dump step').toBeGreaterThan(-1);
    expect(migrate, 'the migrate step').toBeGreaterThan(-1);
    expect(dump).toBeLessThan(migrate);
    // Through the backup service (pg_dump + the backups volume + db credentials),
    // custom format, and verified readable before the deploy goes on.
    expect(deploy).toMatch(
      /run --rm --no-deps --entrypoint sh backup -c "set -eu; f=\/backups\/pg\/premigrate-sportkarta-/,
    );
    expect(deploy).toMatch(
      /pg_dump --format=custom --dbname=sportkarta --file=\\\$f && pg_restore --list \\\$f >\/dev\/null/,
    );
  });

  it('the restore rehearsal still picks a nightly, not the pre-migration dump', () => {
    // restore-test.yml restores the newest `sportkarta-*.dump`; the prefix
    // keeps a deploy's dump out of that pick.
    expect('premigrate-sportkarta-20261031T000000Z.dump').not.toMatch(/^sportkarta-/);
  });

  it('the operator runbook names the dump', () => {
    expect(read('deploy', 'RESTORE.md')).toMatch(/premigrate-sportkarta-/);
  });
});

describe('deploy jobs cannot hang for hours', () => {
  it('every job carries timeout-minutes', () => {
    const deploy = read('.github', 'workflows', 'deploy.yml');
    const jobs = [
      ...deploy.matchAll(/^ {2}([a-z-]+):\n([\s\S]*?)(?=^ {2}[a-z-]+:\n|$(?![\s\S]))/gm),
    ];
    const named = jobs.filter(([, name]) => ['gate', 'build-push', 'deploy'].includes(name ?? ''));
    expect(named.map(([, name]) => name).sort()).toEqual(['build-push', 'deploy', 'gate']);
    for (const [, name, body] of named) {
      expect(body ?? '', `${name} needs timeout-minutes`).toMatch(/^\s+timeout-minutes: \d+$/m);
    }
  });
});
