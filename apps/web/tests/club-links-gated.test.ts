import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every club route 404s while CLUBS_ENABLED is off (lib/clubs/club-session.ts
 * requireClubsEnabled), so the chrome must only LINK to one while it is on.
 * The rule is enforced by convention in three files; this pins the convention
 * at the source, so a later edit cannot make /klubove or /za-klubove
 * reachable on a deploy where they answer 404.
 */
const WEB = process.cwd();
const read = (relative: string) => readFileSync(path.join(WEB, relative), 'utf8');

describe('club links render only while the add-on is on', () => {
  it('the footer adds its «Клубове» column from the clubs prop', () => {
    const source = read('components/shell/site-footer.tsx');
    expect(source).toMatch(/clubs \? \[PLATFORM, CLUBS, DATA, ORG\] : \[PLATFORM, DATA, ORG\]/);
    expect(source).not.toMatch(/\[PLATFORM, CLUBS, DATA, ORG\][^\n]*\n[^?]*$/);
  });

  it('the layout passes the live flag to the footer', () => {
    expect(read('app/[locale]/layout.tsx')).toMatch(/<SiteFooter clubs=\{clubsEnabled\(\)\} \/>/);
  });

  it('the marketing header links the clubs page only with the clubs prop', () => {
    const source = read('components/marketing/marketing-header.tsx');
    expect(source).toMatch(/if \(clubs\) links\.push\(\{ href: '\/za-klubove'/);
    expect(source.match(/'\/za-klubove'/g)?.length).toBe(2);
  });

  it('the front page renders its clubs band only while the add-on is on', () => {
    const source = read('app/[locale]/(home)/page.tsx');
    expect(source).toMatch(/const clubs = clubsEnabled\(\);/);
    expect(source).toMatch(/\{clubs && <ClubsSection \/>\}/);
  });
});
