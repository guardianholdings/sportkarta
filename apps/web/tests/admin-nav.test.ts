import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The admin nav on a phone (UX audit 2026-10-10, A-17): sixteen links wrapped
 * into five rows above every screen. Below `sm` they are one row that scrolls
 * sideways, each link a 44px target.
 */
describe('the admin nav', () => {
  const layout = readFileSync(
    path.join(process.cwd(), 'app/[locale]/admin/(protected)/layout.tsx'),
    'utf8',
  );
  const wrapper = layout.slice(0, layout.indexOf('<AdminNav'));
  const classes = wrapper.slice(wrapper.lastIndexOf('className="'));

  it('is one sideways-scrolling row on a phone', () => {
    expect(classes).toMatch(/\boverflow-x-auto\b/);
    expect(classes).toMatch(/max-sm:\[&>nav\]:flex-nowrap/);
    expect(classes).toMatch(/max-sm:\[&_a\]:whitespace-nowrap/);
    expect(classes).toMatch(/max-sm:\[&_a\]:shrink-0/);
  });

  it('gives every link a 44px target there', () => {
    expect(classes).toMatch(/max-sm:\[&_a\]:min-h-11/);
  });
});
