import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';

import bg from '../messages/bg.json';
import en from '../messages/en.json';

/**
 * The map list is the non-map way in — keyboard, screen reader — and the UX
 * audit (2026-10-10, M-8/M-9) found it fighting its own users: every state
 * change remounted all ~60 cards, so Enter on a card dropped focus to <body>;
 * the filter sheet was a div nobody was told had opened; the result count
 * changed silently; and on a phone, closing a preview rebuilt the list from the
 * top. There is no DOM in these tests, so they pin the structure that fixes it.
 */

const explorer = readFileSync(
  path.join(__dirname, '..', 'components', 'map', 'map-explorer.tsx'),
  'utf8',
);

describe('the result cards survive a re-render', () => {
  it('ResultCard is a module-level component, not one re-declared per render', () => {
    expect(explorer).toMatch(/^function ResultCard\(/m);
    expect(explorer).not.toMatch(/^\s+function ResultCard\(/m);
  });
});

describe('focus follows the preview', () => {
  it('moves into the preview when the member opens one', () => {
    expect(explorer).toMatch(/data-preview-heading/);
    expect(explorer).toMatch(/querySelector<HTMLElement>\('\[data-preview-heading\]'\)/);
  });

  it('returns to the card it came from when the preview closes', () => {
    expect(explorer).toMatch(/returnFocusRef\.current = from;/);
    expect(explorer).toMatch(/querySelector<HTMLElement>\(`\[data-slug="\$\{previous\}"\]`\)/);
  });

  it('closes on Escape', () => {
    expect(explorer).toMatch(/if \(event\.key === 'Escape'\) select\(null\);/);
  });
});

describe('the filter sheet is a modal dialog', () => {
  it('says so, and is named by its heading', () => {
    expect(explorer).toMatch(/role="dialog"\s+aria-modal="true"\s+aria-labelledby=\{titleId\}/);
    expect(explorer).toMatch(/<h2 id=\{titleId\}/);
  });

  it('takes focus in, keeps it, lets Escape out, and gives it back', () => {
    expect(explorer).toMatch(/focusables\(panelRef\.current\)\[0\]\?\.focus\(\);/);
    expect(explorer).toMatch(/if \(opener\?\.isConnected\) opener\.focus\(\);/);
    expect(explorer).toMatch(/event\.key === 'Escape'/);
    expect(explorer).toMatch(/event\.key !== 'Tab'/);
  });
});

describe('the list announces what it found', () => {
  it('the count line is a polite live region', () => {
    expect(explorer).toMatch(/const countLine = \(\s*<span role="status"/);
  });

  it('the desktop Filters button is never named just «2»', () => {
    expect(explorer).not.toMatch(/String\(activeCount\)/);
    expect(explorer).toMatch(/t\('filtersActive', \{ count: activeCount \}\)/);
    const tBg = createTranslator({ locale: 'bg', messages: bg, namespace: 'Map' });
    const tEn = createTranslator({ locale: 'en', messages: en, namespace: 'Map' });
    expect(tBg('filtersActive', { count: 1 })).toBe('Филтри: 1 активен');
    expect(tBg('filtersActive', { count: 2 })).toBe('Филтри: 2 активни');
    expect(tEn('filtersActive', { count: 2 })).toBe('Filters: 2 active');
  });
});

describe('the phone list keeps its place (M-9)', () => {
  it('stays mounted, hidden and inert, under the preview', () => {
    expect(explorer).not.toMatch(/\{selected \? \(/);
    expect(explorer).toMatch(/inert=\{selected !== null\}/);
    expect(explorer).toMatch(/\$\{selected \? 'invisible' : ''\}/);
  });

  it('gives each breakpoint its own list ref, and syncs the one on screen', () => {
    expect(explorer).toMatch(/resultsBody\(desktopListRef\)/);
    expect(explorer).toMatch(/resultsBody\(mobileListRef\)/);
    expect(explorer).not.toMatch(/\blistRef = useRef/);
    expect(explorer).toMatch(
      /const box = viewport\.desktop \? desktopListRef\.current : mobileListRef\.current;/,
    );
  });
});

/**
 * After a refused location request the red notice covered the phone's sheet for
 * the rest of the visit — no close, no end, no next step — and «Около мен»
 * stayed switched on around a location that did not exist (M-10).
 */
describe('a failed location request', () => {
  it('switches «Около мен» back off', () => {
    expect(explorer).toMatch(
      /\(error\) => \{\s*setLocateError\([^)]*\);\s*setLocating\(false\);\s*setNearMeOn\(false\);/,
    );
    // Switched on BEFORE locating, so even a synchronous failure wins.
    expect(explorer).toMatch(/setNearMeOn\(true\);\s*if \(!userLocation\) locate\(\);/);
  });

  it('can be closed, and closes itself', () => {
    expect(explorer).toMatch(/onClick=\{\(\) => setLocateError\(null\)\}/);
    expect(explorer).toMatch(/window\.setTimeout\(\(\) => setLocateError\(null\), 10_000\)/);
  });

  it('says what to do next', () => {
    expect(explorer).toMatch(
      /locateError === 'denied' \? t\('locateDeniedHelp'\) : t\('locateRetryHelp'\)/,
    );
    expect(bg.Map.locateError).toBe('Местоположението ви не е достъпно.');
    expect(bg.Map.locateDeniedHelp).toMatch(/^Разрешете достъпа до местоположението/);
  });
});
