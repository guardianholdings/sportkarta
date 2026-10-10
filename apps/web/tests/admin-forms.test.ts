import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Admin forms keep what the operator typed when the server says no (UX audit
 * 2026-10-10, A-2).
 *
 * React 19 resets a `<form action={fn}>` once the action settles, whatever it
 * returned, so every admin form built on a bare useActionState came back from
 * a validation error EMPTY: a campaign's weights, a partner's texts, a pasted
 * CSV, a scoresheet. lib/use-form-action.ts dispatches from onSubmit instead,
 * which React does not reset. This keeps the next admin form from regressing.
 */

const ADMIN = path.join(process.cwd(), 'app', '[locale]', 'admin');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

describe('admin forms', () => {
  const files = walk(ADMIN);

  it('finds the admin client forms (guards a vacuous pass)', () => {
    expect(files.filter((file) => /useFormAction\(/.test(code(file))).length).toBeGreaterThan(8);
  });

  it('never hold a bare useActionState, whose form React empties on any error', () => {
    const offenders = files
      .filter((file) => /useActionState\s*[(<]/.test(code(file)))
      .map((file) => path.relative(ADMIN, file));
    expect(offenders).toEqual([]);
  });
});
