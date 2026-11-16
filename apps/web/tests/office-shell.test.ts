import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The club office's header on a phone (UX audit 2026-10-31, V-30): the club's
 * name was truncated to «Твоя…» on every screen and the trial was announced
 * twice, by the chip and by the banner. Held at the source: the name has its
 * own line under `sm`, the role chip hides there, and the state chip appears
 * only when no banner says the same thing.
 */
const shell = readFileSync(
  path.join(__dirname, '..', 'components', 'clubs', 'club-shell.tsx'),
  'utf8',
);

describe('the office header on a phone', () => {
  it('gives the club name its own, untruncated line', () => {
    expect(shell).toMatch(/basis-full[^"]*sm:hidden|sm:hidden[^"]*basis-full/);
    expect(shell).not.toMatch(/className="truncate text-body font-bold text-ink">\{name\}/);
  });

  it('hides the role chip under 640px', () => {
    expect(shell).toMatch(/<Badge tone="neutral" className="max-sm:hidden">/);
  });

  it('shows exactly one trial indicator: the banner, or else the chip', () => {
    expect(shell).toMatch(/\{!banner && \(?\s*<ClubStateBadge/);
  });
});
