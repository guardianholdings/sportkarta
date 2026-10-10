import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * React 19 resets every `<form action={fn}>` after the action settles, whatever
 * the action returned — so a server-side validation error came back above an
 * EMPTY form: the photo on /dobavi, an explanation of up to 2,000 characters on
 * /signal, a new campaign's titles and prize text in the admin (UX audit
 * 2026-10-10). Forms whose action can answer with an error go through
 * `useFormAction` (lib/use-form-action.ts), which dispatches the same action
 * without the reset.
 *
 * `useActionState` directly is allowed only where the form rebuilds its own
 * fields from the returned state, and each such file is named here with why.
 */
const ALLOWED: Record<string, string> = {
  // Restores the address from state, and wiping a wrong six-digit code is right.
  'app/[locale]/vhod/sign-in-form.tsx': 'restores its field from state',
};

const WEB_ROOT = path.join(__dirname, '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx$/.test(name) ? [full] : [];
  });
}

const files = ['app', 'components'].flatMap((dir) => walk(path.join(WEB_ROOT, dir)));
const rel = (file: string) => path.relative(WEB_ROOT, file).split(path.sep).join('/');

describe('forms keep what the member typed when the server says no', () => {
  it('calls useActionState directly only where the form restores its own fields', () => {
    const direct = files
      .filter((file) => /\buseActionState\s*[(<]/.test(readFileSync(file, 'utf8')))
      .map(rel);
    expect(direct.filter((file) => !(file in ALLOWED))).toEqual([]);
  });

  it('wires every useFormAction form through the props it returns', () => {
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      if (!/\buseFormAction\s*\(/.test(source)) continue;
      // Whatever the second binding is called (`formProps`, or `parseForm` on a
      // multi-step form), it must be spread onto a <form>: the spread carries
      // the `action` (pre-hydration submits) AND the `onSubmit` that skips the
      // reset, and one without the other is the bug back.
      const bindings = [
        ...source.matchAll(/const \[\s*\w+,\s*(\w+),\s*\w+\s*\]\s*=\s*useFormAction\s*\(/g),
      ].map((match) => match[1]);
      expect(bindings.length, rel(file)).toBeGreaterThan(0);
      for (const name of bindings) {
        // `{...formProps}`, or one side of a chosen spread:
        // `{...(attending ? leaveForm : joinForm)}` on the RSVP button.
        const spread = new RegExp(`\\{\\.\\.\\.(?:${name}\\}|\\([^)]*\\b${name}\\b[^)]*\\)\\})`);
        expect(source, `${rel(file)}: ${name}`).toMatch(spread);
      }
    }
  });

  it('keeps the action prop and dispatches without React’s reset', () => {
    const hook = readFileSync(path.join(WEB_ROOT, 'lib/use-form-action.ts'), 'utf8');
    expect(hook).toMatch(/event\.preventDefault\(\);/);
    expect(hook).toMatch(/startTransition\(\(\) => dispatch\(data\)\)/);
    expect(hook).toMatch(/\{ ref, action: dispatch, onSubmit \}/);
  });
});
