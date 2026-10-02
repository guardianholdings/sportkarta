import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A facility's municipality is named the way the city pages name it: in
 * English on the English site („Хасково" read as "Haskovo" there), and as
 * „София" rather than the formal „Столична" in both languages. The catalogue
 * is the real override table plus a mocked municipality list — the database
 * part of lib/places.ts is all that is replaced.
 */

const loadCityCatalog = vi.fn();

vi.mock('@/lib/places', async () => {
  const { cityDisplayName } = await import('@sportkarta/lib/cities');
  return { cityDisplayName, loadCityCatalog: () => loadCityCatalog() as unknown };
});

const CATALOG = {
  all: [
    { id: 1, slug: 'haskovo', nameBg: 'Хасково', nameEn: 'Haskovo' },
    // assignCitySlugs stores the name AFTER overrides, so Sofia's row reads
    // „София", never „Столична".
    { id: 2, slug: 'sofia', nameBg: 'София', nameEn: 'Sofia' },
  ],
};

beforeEach(() => {
  loadCityCatalog.mockReset();
  loadCityCatalog.mockResolvedValue(CATALOG);
});

describe('municipalityDisplayName', () => {
  it('names a municipality in English on the English site', async () => {
    const { municipalityDisplayName } = await import('../lib/area-name');
    expect(await municipalityDisplayName('Хасково', 'en')).toBe('Haskovo');
  });

  it('says Sofia, not the formal municipality name, in both languages', async () => {
    const { municipalityDisplayName } = await import('../lib/area-name');
    expect(await municipalityDisplayName('Столична', 'en')).toBe('Sofia');
    expect(await municipalityDisplayName('Столична', 'bg')).toBe('София');
  });

  it('keeps the Bulgarian name on the Bulgarian site without loading the catalogue', async () => {
    const { municipalityDisplayName } = await import('../lib/area-name');
    expect(await municipalityDisplayName('Хасково', 'bg')).toBe('Хасково');
    expect(loadCityCatalog).not.toHaveBeenCalled();
  });

  it('falls back to the name it was given for a municipality it does not know', async () => {
    const { municipalityDisplayName } = await import('../lib/area-name');
    expect(await municipalityDisplayName('Непозната', 'en')).toBe('Непозната');
  });
});

describe('withLocalizedArea', () => {
  it('renames only the municipality and leaves a row without one alone', async () => {
    const { withLocalizedArea } = await import('../lib/area-name');
    const row = { slug: 'x', quarter: 'Лозенец', municipalityName: 'Столична' };
    expect(await withLocalizedArea(row, 'en')).toEqual({ ...row, municipalityName: 'Sofia' });
    const none = { slug: 'y', quarter: null, municipalityName: null };
    expect(await withLocalizedArea(none, 'en')).toBe(none);
  });
});
