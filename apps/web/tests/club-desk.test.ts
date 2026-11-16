import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The front desk ticks people in all day, one after another, often from a USB
 * card reader — which is a keyboard. The 2026-11-14 audit found the page
 * leaving the cursor on nothing after every arrival (the answer is a redirect
 * to the same page, applied in place, so `autoFocus` never fires again): the
 * next card read went nowhere, and the answer could sit above the screen.
 * It also hid the tick for anyone already in today, so a second booked class
 * could not be ticked. There is no DOM in these tests; they pin the structure.
 */

const office = path.join(__dirname, '..', 'app', '[locale]', 'klub', '[slug]', '(office)');
const read = (...parts: string[]) => readFileSync(path.join(...parts), 'utf8');

const page = read(office, 'prisastviya', 'page.tsx');
const actions = read(office, 'prisastviya', 'actions.ts');
const scan = read(office, 'skan', '[token]', 'page.tsx');
const focus = read(__dirname, '..', 'components', 'clubs', 'desk-focus.tsx');

describe('the cursor returns to the field the desk works from', () => {
  it('the page renders the refocus helper against the two fields and the answer', () => {
    expect(page).toMatch(/<DeskFocus fieldId=\{byCard \? 'desk-card' : 'desk-q'\}/);
    expect(page).toMatch(/outcomeId="desk-outcome"/);
    expect(page).toMatch(/id="desk-outcome" role="status" aria-live="polite"/);
    expect(page).toMatch(/id="desk-q"/);
    expect(page).toMatch(/id="desk-card"/);
  });

  it('a card answer says it came from the card reader', () => {
    // Both card outcomes — a bad code and a recorded arrival — carry it.
    expect(actions.match(/locationId, 'card'\)/g)?.length).toBe(2);
    expect(actions).toMatch(/if \(via === 'card'\) query\.kak = 'karta'/);
    expect(page).toMatch(/const byCard = query\.kak === 'karta'/);
  });

  it('without JavaScript the same field takes the cursor on load', () => {
    expect(page).toMatch(/autoFocus=\{!byCard\}/);
    expect(page).toMatch(/autoFocus=\{byCard\}/);
  });

  it('the helper runs after every answer and keeps the answer in view', () => {
    // No dependency list: the same answer twice (one card read again) still
    // puts the cursor back.
    expect(focus).toMatch(/useEffect\(\(\) => \{[\s\S]*\}\);\s*return null;/);
    expect(focus).not.toMatch(/\},\s*\[[^\]]*\]\);/);
    expect(focus).toMatch(/scrollIntoView\(\{ block: 'nearest' \}\)/);
    expect(focus).toMatch(/focus\(\{ preventScroll: true \}\)/);
  });
});

describe('someone already in today can still be ticked', () => {
  it('the desk search keeps its button beside the «отбелязан днес» badge', () => {
    expect(page).not.toMatch(/markedToday\.has\(member\.id\) \? \(\s*<Badge/);
    expect(page).toMatch(/markedToday\.has\(member\.id\) \? t\('markAgain'\) : t\('mark'\)/);
  });

  it('the QR scan page keeps its button too', () => {
    expect(scan).not.toMatch(/\{marked \? \(\s*<Badge/);
    expect(scan).toMatch(/marked \? t\('markAgain'\) : t\('scan\.confirm'\)/);
  });
});

describe('a form answer is brought into view', () => {
  // The feedback sits above the inputs and the button below them: on a long
  // form a refusal landed above the screen, and the press looked ignored.
  const feedback = read(__dirname, '..', 'components', 'clubs', 'form-feedback.tsx');

  it('every new answer scrolls the region into view, and only when it is out of it', () => {
    expect(feedback).toMatch(/region\.current\?\.scrollIntoView\(\{ block: 'nearest' \}\)/);
    // Keyed on the answer object itself, so the same refusal twice moves twice.
    expect(feedback).toMatch(/\}, \[state, answered\]\);/);
    expect(feedback).toMatch(/<div ref=\{region\}/);
  });

  it('still announces through one status region per outcome', () => {
    // The three outcomes — saved, nothing yet, refused — not the docblock.
    const regions = feedback
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && line.includes('role="status"'));
    expect(regions.length).toBe(3);
  });
});
