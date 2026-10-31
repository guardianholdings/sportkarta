import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The club module's PROJECTION RULES, pinned at the query (plan §5.2): who
 * sees what is decided by which columns a statement selects, not by what a
 * page chooses to render.
 *
 *   * a TRAINER's roster: a display name and the minor flag — never contact
 *     details, the staff note, money or a card;
 *   * the PORTAL's class list and the KIOSK's counter: counts, never a name;
 *   * the portal's own records: the member's records, never contact columns;
 *   * the STAFF DIGESTS in mail: counts, never a member.
 */

const REPO = join(__dirname, '..', '..', '..');
const read = (...path: string[]) => readFileSync(join(REPO, ...path), 'utf8');

/** The body of one function in a source file, up to the next top-level declaration. */
function body(source: string, name: string): string {
  const start = source.search(new RegExp(`(?:export )?(?:async )?function ${name}\\b`));
  if (start < 0) throw new Error(`${name} not found`);
  const rest = source.slice(start + 1);
  const end = rest.search(/\n(?:export |async function |function |const \w+ = )/);
  return end < 0 ? source.slice(start) : source.slice(start, start + 1 + end);
}

const CONTACT_AND_MONEY =
  /\b(?:email|phone|staff_note|card_token|amount_cents|due_cents|charge|payment)/i;
const ANY_PERSON = /club_members|display_name/;

describe('a trainer’s roster is a name and a minor flag', () => {
  const schedule = read('apps', 'web', 'lib', 'clubs', 'schedule.ts');
  it('selects no contact, note, money or card column', () => {
    expect(body(schedule, 'rosterForTrainer')).not.toMatch(CONTACT_AND_MONEY);
  });
});

describe('a trainer’s view of the belts is a name, the ranks and the counts', () => {
  const ranks = read('apps', 'web', 'lib', 'clubs', 'ranks.ts');
  it.each(['progressRows', 'ladderCandidates', 'awardRows'])(
    '%s selects no contact, note, money or card column',
    (name) => {
      expect(body(ranks, name)).not.toMatch(CONTACT_AND_MONEY);
      expect(body(ranks, name)).not.toMatch(/\bm\.(?:email|phone|staff_note|card_token_hash)\b/);
    },
  );
});

describe('the member portal names nobody else', () => {
  const portal = read('apps', 'web', 'lib', 'clubs', 'portal.ts');
  it('lists classes with counts only', () => {
    expect(body(portal, 'portalClasses')).not.toMatch(/club_members|m\.display_name/);
  });
  it('reads the member’s own records without their contact columns', () => {
    const view = body(portal, 'portalView');
    expect(view).toMatch(/memberSelfScope\(/);
    expect(view).not.toMatch(/\bm\.(?:email|phone|staff_note|card_token_hash)\b/);
  });
});

describe('the kiosk shows a count, never a person', () => {
  const kiosk = read('apps', 'web', 'lib', 'clubs', 'kiosk.ts');
  it('counts today’s arrivals without touching a member row', () => {
    expect(body(kiosk, 'kioskTodayCount')).not.toMatch(ANY_PERSON);
  });
});

describe('staff digest mail carries counts, never a member', () => {
  const mail = read('db', 'src', 'clubs', 'mail.ts');
  it.each(['trainerClassesOn', 'clubWeekFigures'])('%s names no club member', (name) => {
    const fn = body(mail, name);
    expect(fn).not.toMatch(/\bm\.display_name\b/);
    expect(fn).not.toMatch(/\bm\.(?:email|phone)\b/);
  });
});
