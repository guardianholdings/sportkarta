import { capitalizeFirst, takesVav } from '@/lib/grammar';
import type { City, SegmentScope } from '@/lib/places';

/**
 * The heading and the metadata of a place listing — a city, or a sport or a
 * quarter inside it — built in ONE place for its page 1 and its pages 2..n.
 *
 * WHY THIS EXISTS. Page 1 and the paginated routes each assembled these
 * strings themselves, and only page 1 kept up when the catalogue learnt
 * «във Варна» (`cityVav`/`quarterVav`, lib/grammar.ts) and the capitalised
 * sport. The paginated routes went on calling `cityH1` with `{ city }` alone;
 * ICU cannot format a `select` without its argument, next-intl falls back to
 * the key, and every page 2+ of every listing went live with the heading
 * «Places.cityH1 — страница 2 от 27» (UX audit 2026-10-10). With one builder
 * there is no second set of arguments to forget, and
 * tests/place-headings.test.ts renders every Places key with exactly the
 * arguments the routes pass.
 *
 * Pure: the caller hands in its translators, so the server routes and the test
 * share the same code path.
 */

/** A next-intl translator scoped to one namespace (`getTranslations(…)`). */
export type Translate = (key: string, values?: Record<string, string | number>) => string;

export interface ListingStrings {
  locale: string;
  /** The `Places` namespace. */
  t: Translate;
  /** The `Sport` namespace. */
  tSport: (sport: string) => string;
}

export interface Listing {
  city: City;
  /** Null for the city itself; a sport or a quarter for /igrishta/<city>/<segment>. */
  scope: SegmentScope | null;
  /** Facilities in the scope — the WHOLE scope, not the page. */
  count: number;
}

export interface ListingCopy {
  /** The listing's own <h1>, as page 1 shows it; page n names it in its back link. */
  heading: string;
  /** The <title>; on page n it carries «— страница 2 от 9». */
  metaTitle: string;
  metaDescription: string;
}

/** The municipality's name in the reader's language. */
export function cityName(city: City, locale: string): string {
  return locale === 'en' ? city.nameEn : city.nameBg;
}

export function listingCopy(
  { locale, t, tSport }: ListingStrings,
  { city, scope, count }: Listing,
  paging?: { page: number; pages: number },
): ListingCopy {
  const name = cityName(city, locale);
  // „във Варна", not „в Варна" — the catalogue branches on it.
  const cityVav = takesVav(name);

  let copy: ListingCopy;
  if (scope === null) {
    copy = {
      heading: t('cityH1', { city: name, cityVav }),
      metaTitle: t('cityMetaTitle', { city: name, cityVav }),
      metaDescription: t('cityMetaDescription', { city: name, cityVav, count }),
    };
  } else if (scope.kind === 'sport') {
    const sport = tSport(scope.sport);
    // The sport OPENS the heading and the title, so it is capitalised there
    // and only there; mid-sentence it stays «места за футбол».
    const opening = capitalizeFirst(sport, locale);
    copy = {
      heading: t('sportH1', { sport: opening, city: name, cityVav }),
      metaTitle: t('sportMetaTitle', { sport: opening, city: name, cityVav }),
      metaDescription: t('sportMetaDescription', { sport, city: name, cityVav, count }),
    };
  } else {
    const quarterVav = takesVav(scope.quarter);
    copy = {
      heading: t('quarterH1', { quarter: scope.quarter, quarterVav, city: name }),
      metaTitle: t('quarterMetaTitle', { quarter: scope.quarter, quarterVav, city: name }),
      metaDescription: t('quarterMetaDescription', {
        quarter: scope.quarter,
        quarterVav,
        city: name,
        count,
      }),
    };
  }

  if (!paging) return copy;
  return {
    ...copy,
    metaTitle: t('pagedHeading', {
      heading: copy.metaTitle,
      page: paging.page,
      pages: paging.pages,
    }),
  };
}
