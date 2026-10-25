import { slugify } from '../slug.js';

/**
 * Club slugs — the `/klub/<slug>` URL segment.
 *
 * Derived once, at application time, from the club's Bulgarian name with the
 * official transliteration (lib/src/slug.ts), and never regenerated when the
 * name changes, so printed QR codes and shared links keep working. The shape
 * matches clubs_slug_shape (0039).
 *
 * RESERVED: words that are, or may become, routes under /klub and /klubove.
 * A club called "Киоск" must not shadow the kiosk path. The application
 * suffixes a reserved or taken slug (-2, -3, …) rather than refusing the name.
 */
export const RESERVED_CLUB_SLUGS: ReadonlySet<string> = new Set([
  'az',
  'admin',
  'api',
  'eksport',
  'kiosk',
  'klub',
  'klubove',
  'nov',
  'nova',
  'novo',
  'otmetka',
  'otpisvane',
  'pokana',
  'proba',
  'skan',
  'svarzhi',
  'trenirovka',
  'zayavka',
]);

const SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const CLUB_SLUG_MAX = 60;
export const CLUB_SLUG_MIN = 3;

export function isUsableClubSlug(slug: string): boolean {
  return (
    SHAPE.test(slug) &&
    slug.length >= CLUB_SLUG_MIN &&
    slug.length <= CLUB_SLUG_MAX &&
    !RESERVED_CLUB_SLUGS.has(slug)
  );
}

/**
 * The base slug for a club name, before collision suffixing. Short or empty
 * results (a name of symbols, a two-letter name) fall back to "klub-<name>"
 * so every club gets a readable, valid slug.
 */
export function clubSlugFrom(name: string): string {
  const base = slugify(name, CLUB_SLUG_MAX - 4);
  if (base.length >= CLUB_SLUG_MIN && !RESERVED_CLUB_SLUGS.has(base)) return base;
  const padded = slugify(`klub ${name}`, CLUB_SLUG_MAX - 4);
  return padded.length >= CLUB_SLUG_MIN ? padded : 'klub';
}

/** `base`, then `base-2`, `base-3`… — the first candidate not in `taken`. */
export function nextFreeClubSlug(base: string, taken: ReadonlySet<string>): string {
  if (isUsableClubSlug(base) && !taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${String(n)}`;
    if (isUsableClubSlug(candidate) && !taken.has(candidate)) return candidate;
  }
  throw new Error('no free club slug');
}
