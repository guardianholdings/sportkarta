import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every contribution action must establish the caller's identity BEFORE it
 * touches the database.
 *
 * This is asserted statically because the boundary is a Next.js server action:
 * an HTTP request without the framework's action headers is never dispatched at
 * all, so an end-to-end POST proves nothing about `requireUser`. What can be
 * proved cheaply, and is what actually regresses, is that no action grew a
 * database call ahead of its authentication check.
 */

const WEB_ROOT = process.cwd(); // vitest runs with cwd = apps/web

const ACTION_FILES = [
  'app/[locale]/dobavi/actions.ts',
  'app/[locale]/obekt/[slug]/contribution-actions.ts',
  'app/[locale]/profil/actions.ts',
];

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/.*$/gm, '');
}

describe('contribution actions require an account', () => {
  for (const file of ACTION_FILES) {
    it(`${file} authenticates before any database work`, () => {
      const source = stripComments(readFileSync(path.join(WEB_ROOT, file), 'utf8'));

      // Split into exported action bodies, crudely but adequately: each starts
      // at an `export async function` and runs to the next one.
      const bodies = source.split(/export async function /).slice(1);
      expect(bodies.length).toBeGreaterThan(0);

      for (const body of bodies) {
        const name = /^(\w+)/.exec(body)?.[1] ?? '(unknown)';
        const authAt = body.search(/await require(User|Role)\(/);
        expect(authAt, `${name} never calls requireUser/requireRole`).toBeGreaterThanOrEqual(0);

        const dbAt = body.search(/getDb\(\)/);
        if (dbAt >= 0) {
          expect(dbAt, `${name} touches the database before authenticating`).toBeGreaterThan(
            authAt,
          );
        }
      }
    });
  }

  it('the contribution flows never take a user id from the request', () => {
    // The account always comes from the session; a userId read out of form data
    // would let one member act as another.
    for (const file of ACTION_FILES) {
      const source = stripComments(readFileSync(path.join(WEB_ROOT, file), 'utf8'));
      expect(source, file).not.toMatch(/formData\.get\(\s*['"]userId['"]/);
      expect(source, file).toMatch(/user\.id|requireRole/);
    }
  });
});
