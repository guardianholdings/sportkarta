import { cityDisplayName, loadCityCatalog, MIN_LISTING_FACILITIES } from '@/lib/places';

import type { DotLayer } from './dots';

/**
 * Names for the dot map's municipalities, and the «most places» line under it.
 *
 * A municipality gets a city-page slug only when its free places reach the city
 * page's own floor (MIN_LISTING_FACILITIES) — every link the front page draws
 * must land on a page that exists, not a 404.
 */

export interface NamedPlace {
  name: string;
  slug: string | null;
}

export interface TopPlace {
  slug: string;
  name: string;
  count: number;
}

export async function dotPlaces(layer: DotLayer, locale: string): Promise<Map<number, NamedPlace>> {
  const { byId } = await loadCityCatalog();
  const places = new Map<number, NamedPlace>();
  for (const [id, count] of layer.municipalities) {
    const city = byId.get(id);
    if (!city) continue;
    places.set(id, {
      name: cityDisplayName(city.nameBg, city.nameEn, locale),
      slug: count >= MIN_LISTING_FACILITIES ? city.slug : null,
    });
  }
  return places;
}

export async function topPlaces(layer: DotLayer, locale: string, limit = 5): Promise<TopPlace[]> {
  const { byId } = await loadCityCatalog();
  return [...layer.municipalities]
    .sort((a, b) => b[1] - a[1])
    .flatMap(([id, count]) => {
      const city = byId.get(id);
      return city && count >= MIN_LISTING_FACILITIES
        ? [{ slug: city.slug, name: cityDisplayName(city.nameBg, city.nameEn, locale), count }]
        : [];
    })
    .slice(0, limit);
}
