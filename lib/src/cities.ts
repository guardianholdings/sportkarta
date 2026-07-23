import cityOverrides from './city-overrides.json' with { type: 'json' };
import { slugify } from './slug.js';

/**
 * City identity — slugs and display names (docs/ROADMAP.md §4, §6).
 *
 * A "city" is a municipality; its URL slug is derived from the Bulgarian name
 * because municipalities have no slug column. This lives in the shared package
 * because BOTH the web app and the worker now need it: the app serves
 * /sedmitsata/[city] and the Monday digest email links to it, and a second
 * implementation of the collision rule would drift the moment two
 * municipalities collide (two "Бяла" municipalities exist).
 *
 * The overrides stay in JSON on purpose — place names like "Столична" → "София"
 * are data, not translatable UI copy, and keeping them out of .ts source keeps
 * them out of source scans.
 */

const CITY_OVERRIDES = cityOverrides as Record<
  string,
  { slug: string; nameBg: string; nameEn: string }
>;

export interface City {
  id: number;
  slug: string;
  nameBg: string;
  nameEn: string;
}

/** The shape the municipalities table returns. */
export interface MunicipalityRow {
  id: number;
  name_bg: string;
  name_en: string;
}

/**
 * Pure slug assignment: transliterate each municipality's name, apply
 * overrides, and resolve collisions deterministically by input order — so the
 * caller must pass a stable ordering (`ORDER BY id`) or slugs would move
 * between deployments and break every link already published.
 */
export function assignCitySlugs(rows: MunicipalityRow[]): City[] {
  const taken = new Set<string>();
  const out: City[] = [];
  for (const row of rows) {
    const override = CITY_OVERRIDES[row.name_bg];
    let slug = override?.slug ?? (slugify(row.name_bg) || `obshtina-${String(row.id)}`);
    if (taken.has(slug)) {
      let n = 2;
      while (taken.has(`${slug}-${String(n)}`)) n++;
      slug = `${slug}-${String(n)}`;
    }
    taken.add(slug);
    out.push({
      id: Number(row.id),
      slug,
      nameBg: override?.nameBg ?? row.name_bg,
      nameEn: override?.nameEn ?? row.name_en,
    });
  }
  return out;
}

/**
 * Display name for a municipality in one locale. Client-safe: no database, no
 * node built-ins — only the overrides table.
 */
export function cityDisplayName(nameBg: string, nameEn: string, locale: string): string {
  const override = CITY_OVERRIDES[nameBg];
  const bg = override?.nameBg ?? nameBg;
  const en = override?.nameEn ?? nameEn;
  return locale === 'en' ? en : bg;
}
