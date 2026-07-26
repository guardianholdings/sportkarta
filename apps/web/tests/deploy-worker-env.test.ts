import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Deploy-config gate: the worker container must be given every environment
 * variable the worker code actually reads.
 *
 * WHY THIS EXISTS. Until 2026-07-26 the worker service in
 * deploy/compose.prod.yml declared exactly three variables — DATABASE_URL,
 * STORAGE_DIR and OPENDATA_DUMP_RETENTION — while apps/worker/src/index.ts
 * called `createMailer(process.env)` and read NEXT_PUBLIC_SITE_URL. The SMTP
 * relay is configured on the `web` service only. The consequence was that ALL
 * outbound mail failed in production and nowhere else:
 *
 *   Dockerfile sets NODE_ENV=production on the worker stage
 *     → resolveMailTransport() refuses every non-SMTP transport in production
 *       (a one-time code must never fall back to a log or a file)
 *     → DisabledMailer.send() rejects
 *
 * Locally NODE_ENV is unset, so the same code selects the file outbox and mail
 * lands in apps/web/var/mail exactly as a developer expects. Every unit test
 * passed. Session RSVP mail (Stage 4.2), the T-24h/T-2h reminders and the
 * Monday weekly digest (Stage 4.4) were all silently dead in production.
 *
 * A unit test could not have caught it, because nothing was wrong with the
 * code. The defect lived in the gap between what the code reads and what the
 * deploy manifest supplies — so that gap is what this test measures.
 *
 * THE INDIRECT READ IS THE POINT. Scanning for `process.env.X` alone would
 * still miss it: `createMailer(process.env)` hands the WHOLE environment to a
 * consumer in another package, so the SMTP family never appears literally in
 * apps/worker/src. That whole-env handoff is checked separately below.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');
const COMPOSE = join(REPO_ROOT, 'deploy', 'compose.prod.yml');
const WORKER_SRC = join(REPO_ROOT, 'apps', 'worker', 'src');

/**
 * Variables the worker may read without the manifest declaring them, each with
 * a reason. Keep this list short and justified — an entry here is a decision
 * that the runtime default is correct in production.
 */
const DECLARED_ELSEWHERE = new Map<string, string>([
  // Set by the image itself (Dockerfile `ENV NODE_ENV=production`), not by the
  // manifest. Declaring it in compose would let an .env override flip the
  // worker out of production mode and re-enable the refused mail transports.
  ['NODE_ENV', 'set by the Dockerfile; must not be overridable from .env'],
  // Dev-only escape hatches. In production resolveMailTransport refuses every
  // transport these could select, so leaving them unset is the safe state.
  ['MAIL_TRANSPORT', 'dev-only; refused in production by resolveMailTransport'],
  ['MAIL_OUTBOX_DIR', 'dev-only; only read by the file transport'],
]);

/**
 * Keys read by `createMailer(env)` in lib/src/email/mailer.ts. Any worker file
 * that passes the whole `process.env` to it is asking for all of these, so the
 * manifest has to supply them even though they never appear literally in
 * apps/worker/src.
 */
const SMTP_FAMILY = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];

function walk(dir: string): string[] {
  let out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out = out.concat(walk(full));
    else if (/\.ts$/.test(name)) out.push(full);
  }
  return out;
}

/** Blank comment contents while preserving newlines (keeps line numbers). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/.*$/gm, '');
}

/**
 * The environment keys declared for one compose service.
 *
 * Hand-parsed rather than via a YAML library: the only parser in the workspace
 * is a transitive js-yaml that does not resolve from apps/web, and adding a
 * dependency to read one well-known block is a poor trade. The scanner is
 * deliberately strict about indentation and the caller asserts the result is
 * non-empty, so a mis-parse fails loudly instead of vacuously passing.
 */
function serviceEnvKeys(compose: string, service: string): string[] {
  const lines = compose.split('\n');
  const keys: string[] = [];
  let inService = false;
  let inEnv = false;
  for (const line of lines) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    if (/^ {2}\S.*:\s*$/.test(line)) {
      // A service header at two-space indent ends the previous service.
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

const compose = readFileSync(COMPOSE, 'utf8');
const workerEnv = serviceEnvKeys(compose, 'worker');
const workerFiles = walk(WORKER_SRC);
const workerSource = workerFiles.map((f) => stripComments(readFileSync(f, 'utf8'))).join('\n');

describe('deploy/compose.prod.yml — worker environment', () => {
  it('the parser actually found the worker service (guards a vacuous pass)', () => {
    expect(workerFiles.length).toBeGreaterThan(0);
    expect(workerEnv.length).toBeGreaterThan(0);
    // If the service is ever renamed, the scan above silently returns nothing
    // and every assertion below passes for the wrong reason.
    expect(workerEnv).toContain('DATABASE_URL');
  });

  it('declares every variable apps/worker/src reads directly', () => {
    const read = new Set(
      [...workerSource.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1] as string),
    );
    const missing = [...read].filter((k) => !workerEnv.includes(k) && !DECLARED_ELSEWHERE.has(k));
    expect(
      missing,
      `apps/worker/src reads these but deploy/compose.prod.yml does not give them to the worker:\n` +
        missing.map((k) => `  ${k}`).join('\n'),
    ).toEqual([]);
  });

  it('declares the SMTP family, because the worker hands the whole env to createMailer', () => {
    // The regression that motivated this file. `createMailer(process.env)` is a
    // whole-environment handoff, so the direct scan above cannot see the keys
    // it consumes — they have to be asserted from the call site instead.
    const handsOffWholeEnv = /createMailer\(\s*process\.env\s*\)/.test(workerSource);
    if (!handsOffWholeEnv) return; // worker no longer sends mail; nothing to require
    const missing = SMTP_FAMILY.filter((k) => !workerEnv.includes(k));
    expect(
      missing,
      'apps/worker/src calls createMailer(process.env), so the worker sends mail in ' +
        'production — but compose.prod.yml withholds:\n' +
        missing.map((k) => `  ${k}`).join('\n') +
        '\nWithout them resolveMailTransport returns "disabled" under NODE_ENV=production ' +
        'and every send REJECTS. This fails in production only; local dev uses the file outbox.',
    ).toEqual([]);
  });

  it('gives the worker a real site URL, so mail links are not localhost', () => {
    // apps/worker/src/index.ts falls back to http://localhost:3000. That is the
    // right default for a developer and a broken link in a member's inbox.
    if (!/NEXT_PUBLIC_SITE_URL/.test(workerSource)) return;
    expect(workerEnv).toContain('NEXT_PUBLIC_SITE_URL');
  });
});
