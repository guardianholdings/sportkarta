import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const web = path.resolve(__dirname, '..');
const page = readFileSync(path.join(web, 'app/[locale]/klubove/demo/page.tsx'), 'utf8');

describe('demo club: the /klubove/demo entry', () => {
  it('is dynamic, so the flags are read per request', () => {
    expect(page).toContain("export const dynamic = 'force-dynamic';");
  });

  it('answers 404 unless both flags are on, before it forwards', () => {
    const forward = page.indexOf('return redirect(');
    expect(forward).toBeGreaterThan(-1);
    expect(page.indexOf('requireClubsEnabled();')).toBeGreaterThan(-1);
    expect(page.indexOf('requireClubsEnabled();')).toBeLessThan(forward);
    expect(page.indexOf('if (!clubsDemoEnabled()) notFound();')).toBeGreaterThan(-1);
    expect(page.indexOf('if (!clubsDemoEnabled()) notFound();')).toBeLessThan(forward);
  });

  it("forwards to the demo club's dashboard and nowhere else", () => {
    expect(page).toContain('redirect({ href: `/klub/${DEMO_CLUB_SLUG}/tablo`, locale })');
    expect(page.match(/redirect\(/g)).toHaveLength(1);
  });
});
