import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * «Добави община» grants authority, so it must never grant a default
 * (UX audit 2026-10-10, A-6): the first municipality used to be pre-selected.
 */
describe('the add-municipality picker', () => {
  const page = readFileSync(
    path.join(process.cwd(), 'app/[locale]/admin/(protected)/ambasadori/page.tsx'),
    'utf8',
  );
  const picker = page.slice(page.indexOf('name="municipalityId"') - 200);

  it('starts on a disabled placeholder and is required', () => {
    expect(picker).toMatch(/<Select\s+name="municipalityId"\s+required\s+defaultValue=""/);
    expect(picker).toMatch(/<option value="" disabled>\s*\{t\('chooseMunicipality'\)\}/);
  });

  it('does not offer a municipality already in scope', () => {
    expect(picker).toMatch(/!ambassador\.municipalities\.some\(/);
  });
});
