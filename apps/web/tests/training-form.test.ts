import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * The manual training form (UX audit 2026-10-10, S-3 and S-4), asserted at the
 * source level — the parsing itself is unit-tested beside it in
 * lib/src/training/training.test.ts (parseDistanceKm).
 */
const form = readFileSync(
  new URL('../components/training/training-form.tsx', import.meta.url),
  'utf8',
);
const action = readFileSync(
  new URL('../app/[locale]/trenirovki/actions.ts', import.meta.url),
  'utf8',
);

describe('the training form keeps what was typed', () => {
  it('uses useFormAction, so a problem no longer comes back above an empty form', () => {
    // React 19 resets a <form action> once it settles, whatever it returned.
    expect(form).toMatch(/useFormAction\(logTrainingAction/);
    expect(form).not.toMatch(/import \{[^}]*useActionState/);
    expect(form).toMatch(/<form\s+\{\.\.\.formProps\}/);
  });

  it('clears only after a SAVE, for the next training', () => {
    expect(form).toMatch(/resetWhen: \(result\) => result\.saved === true/);
  });

  it('is built from the shared controls (16px text, 44px targets)', () => {
    for (const control of ['<Select', '<Input', '<Button']) expect(form).toContain(control);
    // The hand-rolled 14px field class is gone.
    expect(form).not.toContain('px-3 py-1.5 text-body-sm');
  });
});

describe('distance (S-3)', () => {
  it('is a decimal text field, not a number input that refuses 5,5', () => {
    const field = /<Input\s+id="distanceKm"[\s\S]*?\/>/.exec(form)?.[0] ?? '';
    expect(field).toContain('inputMode="decimal"');
    expect(field).not.toContain('type="number"');
  });

  it('is parsed as kilometres into metres, never truncated to a whole kilometre', () => {
    expect(action).toMatch(/distanceM: parseDistanceKm\(/);
    expect(action).not.toMatch(/distanceKm \* 1000/);
  });
});
