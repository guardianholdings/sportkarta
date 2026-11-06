import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveMailBudget } from '@sportkarta/lib/email';
import { describe, expect, it } from 'vitest';

/**
 * The mail budget's settings (0063) must reach BOTH services and be rendered
 * by the deploy. The web app spends the code share and the worker the notice
 * and bulk shares, out of ONE table — a service reading other numbers than
 * the other (the defaults, say, while the other read the operator's) would
 * not be sharing a quota at all, and nothing would fail loudly.
 * deploy-worker-env.test.ts covers the worker's side of the manifest; this
 * pins the web service, the deploy's rendering and the documentation.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');
const compose = readFileSync(join(REPO_ROOT, 'deploy', 'compose.prod.yml'), 'utf8');
const deploy = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8');
const envExample = readFileSync(join(REPO_ROOT, '.env.example'), 'utf8');
const webAdapter = readFileSync(join(REPO_ROOT, 'apps', 'web', 'lib', 'mail-budget.ts'), 'utf8');

const SETTINGS = ['MAIL_DAILY_QUOTA', 'MAIL_OTP_SHARE', 'MAIL_NOTICE_SHARE'] as const;
/**
 * Folded into the bulk share by resolveMailBudget, so the web must read it too
 * or /admin/zdrave would show a bulk share the worker does not have.
 */
const BULK_CAP = 'CLUB_BULK_MAIL_DAILY_LIMIT';
/** What deploy.yml renders when the repository variable is unset. */
const RENDERED_DEFAULTS = {
  MAIL_DAILY_QUOTA: '100',
  MAIL_OTP_SHARE: '40',
  MAIL_NOTICE_SHARE: '40',
};

/** The same strict scanner as deploy-worker-env.test.ts; a mis-parse yields nothing and fails. */
function serviceEnvKeys(service: string): string[] {
  const keys: string[] = [];
  let inService = false;
  let inEnv = false;
  for (const line of compose.split('\n')) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    if (/^ {2}\S.*:\s*$/.test(line)) {
      inService = line.trimEnd() === `  ${service}:`;
      inEnv = false;
      continue;
    }
    if (!inService) continue;
    if (/^ {4}\S.*:\s*$/.test(line)) {
      inEnv = line.trimEnd() === '    environment:';
      continue;
    }
    if (inEnv) {
      const m = /^ {6}([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
      if (m?.[1]) keys.push(m[1]);
    }
  }
  return keys;
}

describe('the mail budget settings reach every reader', () => {
  it('the web app resolves the budget from the whole environment', () => {
    expect(webAdapter).toMatch(/resolveMailBudget\(\s*process\.env\s*\)/);
  });

  it('compose.prod.yml gives them to web and to worker alike', () => {
    for (const service of ['web', 'worker']) {
      const keys = serviceEnvKeys(service);
      expect(keys, `${service}: the scanner found the service`).toContain('DATABASE_URL');
      expect(
        [...SETTINGS, BULK_CAP].filter((key) => !keys.includes(key)),
        `${service} is missing mail budget settings`,
      ).toEqual([]);
    }
  });

  it('deploy.yml renders each into the server .env, from a repository variable with a default', () => {
    const start = deploy.indexOf("cat > /opt/sportkarta/.env' <<'EOF'");
    const end = deploy.indexOf('\n          EOF', start);
    expect(start).toBeGreaterThan(-1);
    const rendered = deploy.slice(start, end);
    for (const key of SETTINGS) {
      const line = new RegExp(`^\\s*${key}=\\$\\{\\{ vars\\.${key} \\|\\| '(\\d+)' \\}\\}$`, 'm');
      const match = line.exec(rendered);
      expect(match, `${key} is rendered with a default`).not.toBeNull();
      expect(match?.[1], key).toBe(RENDERED_DEFAULTS[key]);
    }
  });

  it('renders defaults that are the code’s own, so an unset variable changes nothing', () => {
    expect(resolveMailBudget(RENDERED_DEFAULTS)).toEqual(resolveMailBudget({}));
    expect(resolveMailBudget({})).toEqual({ quota: 100, otp: 40, notice: 40, bulk: 20 });
  });

  it('.env.example documents each with the same default', () => {
    for (const key of SETTINGS) {
      expect(envExample).toMatch(new RegExp(`^# ${key}=${RENDERED_DEFAULTS[key]}$`, 'm'));
    }
  });
});
