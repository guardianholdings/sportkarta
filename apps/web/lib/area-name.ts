import { cityDisplayName, loadCityCatalog } from '@/lib/places';

/**
 * A facility's municipality, named the way the city pages name it.
 *
 * The facility row carries the municipality's BULGARIAN name only, so the
 * English facility page printed „Хасково" in its <title>, its area line and its
 * share card — while /en/igrishta/haskovo said "Haskovo" — and every Sofia
 * facility said „Столична", the municipality's formal name, where the city
 * pages say „София". Resolved through the same overrides and city catalogue
 * the /igrishta pages use, so a place is named identically on both.
 *
 * The catalogue is loaded once per process (lib/places.ts), and only the
 * English site needs it at all: the Bulgarian name is already on the row.
 */
export async function municipalityDisplayName(nameBg: string, locale: string): Promise<string> {
  if (locale !== 'en') return cityDisplayName(nameBg, nameBg, locale);
  const { all } = await loadCityCatalog();
  // City.nameBg is the name AFTER overrides, so an overridden municipality
  // („Столична") is not found here — cityDisplayName then supplies its English
  // name from the same override table.
  const nameEn = all.find((c) => c.nameBg === nameBg)?.nameEn ?? nameBg;
  return cityDisplayName(nameBg, nameEn, locale);
}

/** The same row with its municipality named for `locale`. */
export async function withLocalizedArea<T extends { municipalityName: string | null }>(
  facility: T,
  locale: string,
): Promise<T> {
  const nameBg = facility.municipalityName;
  if (!nameBg) return facility;
  return { ...facility, municipalityName: await municipalityDisplayName(nameBg, locale) };
}
