import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Client components must not import the `@sportkarta/lib` barrel.
 *
 * The barrel re-exports the mail module, so a single barrel import in a
 * `'use client'` file drags nodemailer — and with it `node:fs` — into the
 * browser bundle, and the page fails to compile with "Can't resolve 'fs'".
 * That is exactly what the narrow subpath exports (`@sportkarta/lib/sports`,
 * `/condition`, `/slug`) are for.
 *
 * Server components are unaffected and may use the barrel freely.
 */

const WEB_ROOT = process.cwd(); // vitest runs with cwd = apps/web
const SCAN_DIRS = ['app', 'components'];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe('client bundle hygiene', () => {
  const files = SCAN_DIRS.flatMap((dir) => walk(path.join(WEB_ROOT, dir)));

  it('scans a meaningful number of files', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('never imports the lib barrel from a client component', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const isClient = /^\s*['"]use client['"]/m.test(source);
      if (!isClient) continue;
      if (/from\s+['"]@sportkarta\/lib['"]/.test(source)) {
        offenders.push(path.relative(WEB_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the mail module out of the barrel-free subpaths', () => {
    // The subpaths a client may use must not themselves reach the mailer.
    const libRoot = path.resolve(WEB_ROOT, '../../lib/src');
    // cities.ts and csv.ts joined the list in Stage 4: both are advertised
    // subpath exports, and lib/city-names.ts (reachable from client code)
    // re-exports from cities.
    for (const entry of [
      'sports.ts',
      'condition.ts',
      'slug.ts',
      'points.ts',
      'cities.ts',
      'csv.ts',
    ]) {
      const source = readFileSync(path.join(libRoot, entry), 'utf8');
      expect(source, entry).not.toMatch(/from\s+['"]\.\/email/);
      expect(source, entry).not.toMatch(/nodemailer/);
    }
  });
});
