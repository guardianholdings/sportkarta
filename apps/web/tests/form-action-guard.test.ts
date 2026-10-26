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
      // reset, and one without the other is the bug back. An optional fourth
      // binding takes the failed-call report (B2, lib/form-action-failure.ts).
      const bindings = [
        ...source.matchAll(
          /const \[\s*\w+,\s*(\w+),\s*\w+(?:,\s*\w+)?\s*\]\s*=\s*useFormAction\s*\(/g,
        ),
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

  // A redirect() back to the page the form is on could leave a production
  // client router stuck (lib/scripted-submit.ts). /dobavi's same-page
  // thank-you therefore goes back as a URL to a scripted submit and is loaded
  // as a new page; a native POST, without the marker, keeps the redirect.
  it('loads the /dobavi same-page thank-you as a new page, not through the router', () => {
    const hook = readFileSync(path.join(WEB_ROOT, 'lib/use-form-action.ts'), 'utf8');
    expect(hook).toMatch(/data\.set\(SCRIPTED_SUBMIT_FIELD, '1'\);\s*startTransition/);

    const action = readFileSync(path.join(WEB_ROOT, 'app/[locale]/dobavi/actions.ts'), 'utf8');
    expect(action).toMatch(
      /formData\.get\(SCRIPTED_SUBMIT_FIELD\) === '1' && landing\.split\('\?'\)\[0\] === '\/dobavi'/,
    );
    expect(action).toMatch(/return \{ error: null, landing: getPathname\(target\) \};/);
    expect(action).toMatch(/return redirect\(target\);/);

    const form = readFileSync(
      path.join(WEB_ROOT, 'app/[locale]/dobavi/add-facility-form.tsx'),
      'utf8',
    );
    expect(form).toMatch(/window\.location\.assign\(state\.landing\)/);
    expect(form).toMatch(/disabled=\{pending \|\| leaving\}/);
    // Back from the thank-you must not bring the form back stuck on «Изпращаме…».
    expect(form).toMatch(/addEventListener\('pageshow', fresh\)/);
    expect(form).toMatch(/if \(event\.persisted\) window\.location\.reload\(\);/);
  });
});
