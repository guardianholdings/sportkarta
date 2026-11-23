import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { demoEntryQuery } from '@/lib/clubs/demo-entry';

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
    expect(page).toContain('const pathname = `/klub/${DEMO_CLUB_SLUG}/tablo`;');
    expect(page).toContain('const query = demoEntryQuery(await searchParams);');
    expect(page).toContain('return redirect({ href, locale });');
    expect(page.match(/redirect\(/g)).toHaveLength(1);
  });
});

describe('demo club: the campaign tags the entry forwards', () => {
  it('keeps the five utm_* tags, the first value of each, and drops the rest', () => {
    expect(
      demoEntryQuery({
        utm_source: 'email',
        utm_medium: ['email', 'other'],
        utm_campaign: 'clubs-demo',
        utm_content: 'c1',
        utm_term: 't1',
        next: '/admin',
        lat: '42.7',
        fbclid: 'abc',
      }),
    ).toEqual({
      utm_source: 'email',
      utm_medium: 'email',
      utm_campaign: 'clubs-demo',
      utm_content: 'c1',
      utm_term: 't1',
    });
  });

  it('forwards nothing from an address without tags', () => {
    expect(demoEntryQuery({})).toEqual({});
    expect(demoEntryQuery({ utm_source: '', next: '/vhod', ref: 'x' })).toEqual({});
  });
});
