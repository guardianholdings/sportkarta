import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { otherLocale } from '../lib/locale-switch';
import bg from '../messages/bg.json';
import en from '../messages/en.json';

describe('the bg ⇄ en switch', () => {
  it('leads to the other locale', () => {
    expect(otherLocale('bg')).toBe('en');
    expect(otherLocale('en')).toBe('bg');
  });

  it('treats an unknown locale as the default, which is what the site serves', () => {
    expect(otherLocale('de')).toBe('en');
  });

  it('names the TARGET language in its own words', () => {
    // On the Bulgarian site the link reads „English"; on the English one,
    // „Български" — the label a reader of that language will look for.
    expect(bg.LocaleSwitcher.switchTo).toBe('English');
    expect(en.LocaleSwitcher.switchTo).toBe('Български');
  });

  it.each([
    ['components/shell/site-footer.tsx', '<LocaleSwitcher />'],
    // The rail is the only chrome on the map screen, which has no footer.
    ['components/shell/app-nav.tsx', '<LocaleSwitcher variant="rail" />'],
  ])('is reachable from %s', (file, usage) => {
    expect(readFileSync(path.join(process.cwd(), file), 'utf8')).toContain(usage);
  });
});
