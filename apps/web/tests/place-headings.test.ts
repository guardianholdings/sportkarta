import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';

import { listingCopy, type ListingStrings } from '../lib/place-headings';
import type { City } from '../lib/places';
import bg from '../messages/bg.json';
import en from '../messages/en.json';

/**
 * The /igrishta listings' headings and titles. Every page 2+ of every listing
 * went live as «Places.cityH1 — страница 2 от 27»: the paginated routes called
 * `cityH1` without the `cityVav` its ICU `select` needs, and next-intl renders
 * the KEY when a message cannot be formatted — no exception, nothing in a test
 * that only exercised page 1 (UX audit 2026-10-10, M-1).
 */

const MESSAGES = { bg, en } as const;
type Locale = keyof typeof MESSAGES;

/** The real catalogues, with every formatting error collected rather than swallowed. */
function strings(locale: Locale, errors: string[] = []): ListingStrings {
  const onError = (error: Error) => {
    errors.push(error.message);
  };
  const messages = MESSAGES[locale];
  const tPlaces = createTranslator({ locale, messages, namespace: 'Places', onError });
  const tSport = createTranslator({ locale, messages, namespace: 'Sport', onError });
  return {
    locale,
    t: (key, values) => tPlaces(key as 'cityH1', values),
    tSport: (sport) => tSport(sport as 'football'),
  };
}

const VARNA: City = { id: 1, slug: 'varna', nameBg: 'Варна', nameEn: 'Varna' };
const SOFIA: City = { id: 2, slug: 'sofia', nameBg: 'София', nameEn: 'Sofia' };
const BREZNIK: City = { id: 3, slug: 'breznik', nameBg: 'Брезник', nameEn: 'Breznik' };

describe('listingCopy — one builder for page 1 and pages 2..n', () => {
  it('a city: «във Варна» on page 1 and on page 2 alike', () => {
    const errors: string[] = [];
    const s = strings('bg', errors);
    const first = listingCopy(s, { city: VARNA, scope: null, count: 412 });
    const second = listingCopy(s, { city: VARNA, scope: null, count: 412 }, { page: 2, pages: 9 });
    expect(first.heading).toBe('Спортни съоръжения във Варна');
    expect(first.metaTitle).toBe('Спортни съоръжения във Варна');
    expect(first.metaDescription).toContain('във Варна');
    // Page n names the same listing; only its title says which page it is.
    expect(second.heading).toBe(first.heading);
    expect(second.metaTitle).toBe('Спортни съоръжения във Варна — страница 2 от 9');
    expect(second.metaDescription).toBe(first.metaDescription);
    expect(errors).toEqual([]);
  });

  it('a sport: capitalised where it opens the heading, lower-case mid-sentence', () => {
    const errors: string[] = [];
    const s = strings('bg', errors);
    const scope = { kind: 'sport', sport: 'football' } as const;
    const copy = listingCopy(s, { city: BREZNIK, scope, count: 5 }, { page: 2, pages: 2 });
    expect(copy.heading).toBe('Футбол в Брезник');
    expect(copy.metaTitle).toBe('Футбол в Брезник — страница 2 от 2');
    expect(copy.metaDescription).toMatch(/^5 места за футбол в Брезник/);
    expect(errors).toEqual([]);
  });

  it('a quarter: «във» follows the quarter, not the city', () => {
    const errors: string[] = [];
    const s = strings('bg', errors);
    const scope = { kind: 'quarter', quarter: 'Витоша' } as const;
    const copy = listingCopy(s, { city: SOFIA, scope, count: 64 }, { page: 2, pages: 2 });
    expect(copy.heading).toBe('Спортни съоръжения във Витоша, София');
    expect(copy.metaTitle).toBe('Спортни съоръжения във Витоша, София — страница 2 от 2');
    expect(errors).toEqual([]);
  });

  it('English reads the same listings without the Bulgarian-only feature', () => {
    const errors: string[] = [];
    const s = strings('en', errors);
    expect(
      listingCopy(s, { city: VARNA, scope: null, count: 412 }, { page: 2, pages: 9 }).metaTitle,
    ).toBe('Sports facilities in Varna — page 2 of 9');
    expect(
      listingCopy(s, { city: BREZNIK, scope: { kind: 'sport', sport: 'football' }, count: 5 })
        .heading,
    ).toBe('Football in Breznik');
    expect(errors).toEqual([]);
  });
});

// ── Every Places call, with exactly the arguments its route passes ─────────

const WEB_ROOT = path.join(__dirname, '..');
const LISTING_SOURCES = [
  ...walk(path.join(WEB_ROOT, 'app', '[locale]', 'igrishta')),
  path.join(WEB_ROOT, 'lib', 'place-headings.ts'),
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

interface PlacesCall {
  where: string;
  key: string;
  /** The argument NAMES the call passes. */
  args: string[];
}

/** Where the string literal opened at `at` closes. */
function closingQuote(src: string, at: number): number {
  const close = src.indexOf(src.charAt(at), at + 1);
  if (close === -1) throw new Error(`unterminated string at ${String(at)}`);
  return close;
}

/** The text between the brace at `open` and its partner, strings skipped. */
function braced(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src.charAt(i);
    if (ch === "'" || ch === '"' || ch === '`') {
      i = closingQuote(src, i);
      continue;
    }
    if ('({['.includes(ch)) depth++;
    if (')}]'.includes(ch) && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error('unbalanced braces');
}

/** `{ city: name, cityVav, count }` → ['city', 'cityVav', 'count']. */
function propertyNames(body: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let start = 0;
  const flush = (end: number) => {
    const prop = body.slice(start, end).trim();
    if (!prop) return;
    if (prop.startsWith('...')) throw new Error(`spread argument «${prop}» — list them`);
    names.push((prop.split(':')[0] ?? '').trim());
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body.charAt(i);
    if (ch === "'" || ch === '"' || ch === '`') {
      i = closingQuote(body, i);
      continue;
    }
    if ('({['.includes(ch)) depth++;
    else if (')}]'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) {
      flush(i);
      start = i + 1;
    }
  }
  flush(body.length);
  return names;
}

/** Every `t('<key>'…)` in a file whose `t` is the Places translator. */
function placesCalls(file: string): PlacesCall[] {
  const src = readFileSync(file, 'utf8');
  const rel = path.relative(WEB_ROOT, file);
  const calls: PlacesCall[] = [];
  for (const m of src.matchAll(/(?<![\w.$])t\(\s*'(\w+)'\s*([,)])/g)) {
    const at = (m.index ?? 0) + m[0].length;
    const where = `${rel}:${String(src.slice(0, at).split('\n').length)}`;
    if (m[2] === ')') {
      calls.push({ where, key: m[1] ?? '', args: [] });
      continue;
    }
    const open = src.slice(at).search(/\S/) + at;
    if (src.charAt(open) !== '{') throw new Error(`${where}: pass t() an object literal`);
    calls.push({ where, key: m[1] ?? '', args: propertyNames(braced(src, open)) });
  }
  return calls;
}

describe('every Places string the listings render, with the arguments they pass', () => {
  const calls = LISTING_SOURCES.flatMap(placesCalls);

  it('finds the calls (the scan is not silently empty)', () => {
    expect(calls.length).toBeGreaterThan(20);
    expect(calls.map((c) => c.key)).toEqual(
      expect.arrayContaining(['cityH1', 'sportMetaTitle', 'quarterH1', 'pagedHeading']),
    );
  });

  it('the scanned files translate with the Places namespace', () => {
    for (const file of LISTING_SOURCES) {
      if (placesCalls(file).length === 0 || file.endsWith('place-headings.ts')) continue;
      expect(readFileSync(file, 'utf8'), path.relative(WEB_ROOT, file)).toMatch(/'Places'/);
    }
  });

  it.each(['bg', 'en'] as const)('formats every one of them in %s', (locale) => {
    const failures: string[] = [];
    for (const call of calls) {
      const errors: string[] = [];
      const { t } = strings(locale, errors);
      // Any value will do: a `select` falls through to `other`, a plural reads
      // a number. What must not happen is an argument the message needs and
      // the route does not pass.
      const out = t(call.key, Object.fromEntries(call.args.map((name) => [name, 2])));
      if (errors.length > 0 || out.includes('Places.')) {
        failures.push(`${call.where} t('${call.key}'): ${errors.join('; ') || out}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('the listing headings and titles are built only in lib/place-headings.ts', () => {
    const builtElsewhere = calls.filter(
      (c) =>
        /^(city|sport|quarter)(H1|MetaTitle|MetaDescription)$/.test(c.key) &&
        !c.where.startsWith(path.join('lib', 'place-headings.ts')),
    );
    expect(builtElsewhere.map((c) => `${c.where} ${c.key}`)).toEqual([]);
  });
});
