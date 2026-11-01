import { readFileSync } from 'node:fs';

import type { SessionPlace } from '@sportkarta/db';
import { createTranslator } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LabelStrings } from '../components/map/facility-label';
import bg from '../messages/bg.json';
import en from '../messages/en.json';
import { sessionPlaceName, sessionPlaceNamer, sessionPlaceWhere } from '../lib/sessions/place-name';

/**
 * Where a game is played, as the game lists print it. 91% of facilities have no
 * name, and the lists fell back to the GAME's sport: a card titled «Баскетбол
 * 3×3» said «баскетбол» on its pin line, while the map calls the same place
 * «Баскетбол — Лозенец, София». These pin the list label to the map's, against
 * the REAL catalogues. Only the database half of lib/places.ts and next-intl's
 * request-scoped lookup are replaced.
 */

const { loadCityCatalog } = vi.hoisted(() => ({ loadCityCatalog: vi.fn() }));

vi.mock('@/lib/places', async () => {
  const { cityDisplayName } = await import('@sportkarta/lib/cities');
  return { cityDisplayName, loadCityCatalog: () => loadCityCatalog() as unknown };
});

vi.mock('next-intl/server', async () => {
  const { createTranslator: translator } = await import('next-intl');
  const catalogues = {
    bg: (await import('../messages/bg.json')).default,
    en: (await import('../messages/en.json')).default,
  };
  return {
    getTranslations: async ({ locale, namespace }: { locale: 'bg' | 'en'; namespace: never }) =>
      translator({ locale, messages: catalogues[locale], namespace }),
  };
});

beforeEach(() => {
  loadCityCatalog.mockReset();
  loadCityCatalog.mockResolvedValue({
    all: [{ id: 1, slug: 'haskovo', nameBg: 'Хасково', nameEn: 'Haskovo' }],
  });
});

function strings(locale: 'bg' | 'en'): LabelStrings {
  const messages = locale === 'bg' ? bg : en;
  const tFacility = createTranslator({ locale, messages, namespace: 'Facility' });
  const tSport = createTranslator({ locale, messages, namespace: 'Sport' });
  return {
    locale,
    unnamed: tFacility('unnamed'),
    sport: (sport) => tSport(sport as 'football'),
    unnamedAt: (what, place) => tFacility('unnamedAt', { what, place }),
  };
}

const LOZENETS: SessionPlace = {
  facilityName: null,
  facilitySports: ['basketball'],
  facilityQuarter: 'Лозенец',
  facilityMunicipality: 'Столична',
};

describe('sessionPlaceName', () => {
  it('names an unnamed place by its sport and its area, as the map does', () => {
    expect(sessionPlaceName(LOZENETS, 'София', strings('bg'))).toBe('Баскетбол — Лозенец, София');
    expect(sessionPlaceName(LOZENETS, 'Sofia', strings('en'))).toBe('Basketball — Лозенец, Sofia');
  });

  it('uses the facility’s own name whenever it has one', () => {
    const named = { ...LOZENETS, facilityName: 'Южен парк' };
    expect(sessionPlaceName(named, 'София', strings('bg'))).toBe('Южен парк');
  });

  it('falls back to the sport alone, then to the generic noun, never to nothing', () => {
    const nowhere = { ...LOZENETS, facilityQuarter: null, facilityMunicipality: null };
    expect(sessionPlaceName(nowhere, null, strings('bg'))).toBe('Баскетбол');
    expect(sessionPlaceName({ ...nowhere, facilitySports: [] }, null, strings('bg'))).toBe(
      'Спортно съоръжение',
    );
  });
});

describe('sessionPlaceNamer', () => {
  it('says София for «Столична» on the Bulgarian site, without the city catalogue', async () => {
    const name = await sessionPlaceNamer([LOZENETS], 'bg');
    expect(name(LOZENETS)).toBe('Баскетбол — Лозенец, София');
    expect(loadCityCatalog).not.toHaveBeenCalled();
  });

  it('names the municipality in English on the English site', async () => {
    const haskovo = { ...LOZENETS, facilityQuarter: null, facilityMunicipality: 'Хасково' };
    const name = await sessionPlaceNamer([LOZENETS, haskovo], 'en');
    expect(name(LOZENETS)).toBe('Basketball — Лозенец, Sofia');
    expect(name(haskovo)).toBe('Basketball — Haskovo');
  });

  it('resolves each municipality once per list, not once per card', async () => {
    const again = { ...LOZENETS, facilityQuarter: 'Младост' };
    await sessionPlaceNamer([LOZENETS, again, LOZENETS], 'en');
    expect(loadCityCatalog).toHaveBeenCalledTimes(1);
  });

  it('keeps the Bulgarian name rather than failing the page when the area cannot be named', async () => {
    loadCityCatalog.mockRejectedValue(new Error('catalogue down'));
    const haskovo = { ...LOZENETS, facilityQuarter: null, facilityMunicipality: 'Хасково' };
    const name = await sessionPlaceNamer([haskovo], 'en');
    expect(name(haskovo)).toBe('Basketball — Хасково');
  });
});

describe('sessionPlaceWhere', () => {
  it('is the facility’s own name when it has one', async () => {
    expect(await sessionPlaceWhere({ ...LOZENETS, facilityName: 'Южен парк' }, 'bg')).toBe(
      'Южен парк',
    );
  });

  it('is the area of an unnamed place — what reads right after «в»', async () => {
    expect(await sessionPlaceWhere(LOZENETS, 'bg')).toBe('Лозенец, София');
    expect(await sessionPlaceWhere(LOZENETS, 'en')).toBe('Лозенец, Sofia');
  });

  it('is null when there is neither, so the sentence drops the place', async () => {
    const nowhere = { ...LOZENETS, facilityQuarter: null, facilityMunicipality: null };
    expect(await sessionPlaceWhere(nowhere, 'bg')).toBeNull();
  });
});

describe('every surface that names a game’s place', () => {
  const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');
  const surfaces = {
    'home rail': '../components/home/games-section.tsx',
    'member «Следва»': '../components/home/personal-strip.tsx',
    '/igri': '../app/[locale]/igri/page.tsx',
    '/igra': '../app/[locale]/igra/[occurrenceId]/page.tsx',
    '/sedmitsata': '../app/[locale]/sedmitsata/[city]/page.tsx',
    '/otmetka': '../app/[locale]/otmetka/[token]/page.tsx',
    'calendar file': '../app/kalendar/igra/[name]/route.ts',
    'calendar feed': '../app/kalendar/[token]/route.ts',
    'link card': '../app/og/[locale]/[kind]/[slug]/card.png/route.tsx',
    'story card': '../app/og/[locale]/story/[kind]/[slug]/story.png/route.tsx',
  };

  it.each(Object.entries(surfaces))(
    '%s names it through the namer, never from the bare facility name',
    (_, path) => {
      const text = source(path);
      // A bare `facilityName` prints «—», a blank or the game's sport for the
      // 91% of places OSM never named.
      expect(text).not.toMatch(/\.facilityName\b/);
      expect(text).toMatch(/sessionPlaceNamer\(/);
    },
  );

  it('/igra describes itself with the place a sentence can hold', () => {
    expect(source(surfaces['/igra'])).toMatch(/sessionPlaceWhere\(view, locale\)/);
  });
});
