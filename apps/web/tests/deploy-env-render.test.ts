import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Deploy-config gate: every variable deploy/compose.prod.yml hands to the web
 * or worker service with an empty default (`NAME: ${NAME:-}`) must have a
 * `NAME=` line in the server .env that .github/workflows/deploy.yml renders.
 *
 * WHY THIS EXISTS. Compose fills those references from /opt/sportkarta/.env,
 * and deploy.yml writes that file anew on every Deploy: "Render server .env
 * from secrets" replaces it (`cat >`), then "Render derived settings" appends
 * to it (`cat >>`). A variable with no line there is empty in production
 * whatever the repository variable or secret holds, so a switch that ships off
 * can never be switched on, and nothing fails: local runs and CI never read the
 * server .env. CLUBS_DEMO_ENABLED was handed to both services without a render
 * line until this test was added.
 *
 * Scope: the empty default only. A `${NAME:?...}` reference stops compose when
 * its line is missing, and a non-empty default (`${SMTP_PORT:-587}`) still
 * gives the service that default; the empty default is the one form whose
 * missing line fails silently.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');
const compose = readFileSync(join(REPO_ROOT, 'deploy', 'compose.prod.yml'), 'utf8');
const deploy = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8');

/**
 * Variables compose hands over with an empty default that deploy.yml does not
 * render, each with its reason. An entry here is a decision that the variable
 * stays empty in production, so the service runs on the code's own default.
 */
const NOT_RENDERED = new Map<string, string>([
  [
    'OPENDATA_RATE_LIMIT_ANON',
    'Unrendered since the open-data API shipped (cf971c66, Jul 2026). Empty keeps ' +
      "the code's limit of 30 a minute (apps/web/lib/opendata/limits.ts, positiveOr), " +
      'and no repository variable sets it. Rendering it is a change of its own.',
  ],
  ['OPENDATA_RATE_LIMIT_KEYED', 'As OPENDATA_RATE_LIMIT_ANON; empty keeps 300 a minute.'],
]);

/**
 * The empty-default references in one service's `environment:` block.
 *
 * Hand-parsed, as in deploy-worker-env.test.ts, and as strict about
 * indentation: services at two spaces, their keys at four, environment entries
 * at six. The first case asserts known names are found, so a mis-parse fails
 * instead of passing vacuously.
 */
function emptyDefaultRefs(service: string): string[] {
  const names: string[] = [];
  let inService = false;
  let inEnv = false;
  for (const line of compose.split('\n')) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    if (/^\S/.test(line)) {
      // A top-level key ends the services block.
      inService = false;
      inEnv = false;
      continue;
    }
    if (/^ {2}\S/.test(line)) {
      inService = line.trimEnd() === `  ${service}:`;
      inEnv = false;
      continue;
    }
    if (!inService) continue;
    if (/^ {4}\S/.test(line)) {
      inEnv = line.trimEnd() === '    environment:';
      continue;
    }
    if (!inEnv) continue;
    for (const m of line.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*):-\}/g)) names.push(m[1] as string);
  }
  return names;
}

/** One workflow step's text, from its `- name:` line to the next line at its indent or less. */
function stepText(name: string): string {
  const lines = deploy.split('\n');
  const start = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  if (start < 0) return '';
  const indent = (lines[start] as string).search(/\S/);
  let end = start + 1;
  while (end < lines.length) {
    const l = lines[end] as string;
    if (l.trim() !== '' && l.search(/\S/) <= indent) break;
    end += 1;
  }
  return lines.slice(start, end).join('\n');
}

/** The NAME= lines between a step's `<<'EOF'` and its closing `EOF`. */
function heredocNames(step: string): string[] {
  const lines = step.split('\n');
  const open = lines.findIndex((l) => l.includes("<<'EOF'"));
  const close = lines.findIndex((l, i) => i > open && l.trim() === 'EOF');
  if (open < 0 || close < 0) return [];
  return lines
    .slice(open + 1, close)
    .map((l) => /^\s*([A-Z_][A-Z0-9_]*)=/.exec(l)?.[1])
    .filter((n): n is string => n !== undefined);
}

/** The NAME='...' lines a step prints with printf. */
function printfNames(step: string): string[] {
  return [...step.matchAll(/printf "([A-Z_][A-Z0-9_]*)='%s/g)].map((m) => m[1] as string);
}

const rendering = stepText('Render server .env from secrets');
const derived = stepText('Render derived settings');
const rendered = new Set([...heredocNames(rendering), ...printfNames(derived)]);
const handed = { web: emptyDefaultRefs('web'), worker: emptyDefaultRefs('worker') };

describe('deploy.yml renders every empty-default variable compose hands to web and worker', () => {
  it('the scans found both services and both render steps (guards a vacuous pass)', () => {
    expect(handed.web).toContain('CLUBS_ENABLED');
    expect(handed.worker).toContain('SMTP_HOST');
    // The first step replaces the server .env and the second appends to it; a
    // step that wrote elsewhere would make the names below the wrong evidence.
    expect(rendering).toContain("cat > /opt/sportkarta/.env' <<'EOF'");
    expect(derived).toContain("cat >> /opt/sportkarta/.env'");
    expect([...rendered]).toEqual(
      expect.arrayContaining([
        'AUTH_SECRET',
        'CLUBS_ENABLED',
        'CHECKIN_TOKEN_SECRET',
        'APPLE_PRIVATE_KEY',
      ]),
    );
  });

  it.each(['web', 'worker'] as const)(
    'every empty-default variable handed to %s has a NAME= line in the rendered .env',
    (service) => {
      const missing = [...new Set(handed[service])].filter(
        (n) => !rendered.has(n) && !NOT_RENDERED.has(n),
      );
      expect(
        missing,
        `deploy/compose.prod.yml hands these to ${service} with an empty default, but ` +
          '.github/workflows/deploy.yml renders no line for them into the server .env, ' +
          'so in production they are always empty:\n' +
          missing.map((n) => `  ${n}`).join('\n') +
          '\nAdd a NAME= line to the "Render server .env from secrets" step, or an entry ' +
          'with its reason to NOT_RENDERED above.',
      ).toEqual([]);
    },
  );

  it('the allow-list names only variables that are handed over and still not rendered', () => {
    const all = new Set([...handed.web, ...handed.worker]);
    const stale = [...NOT_RENDERED.keys()].filter((n) => !all.has(n) || rendered.has(n));
    expect(stale).toEqual([]);
  });
});
