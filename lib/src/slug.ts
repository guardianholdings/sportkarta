/**
 * URL slugs for facilities: official Bulgarian transliteration, stable, and
 * collision-suffixed (docs/ROADMAP.md Stage 2).
 *
 * Transliteration follows the Bulgarian Transliteration Law (2009) — the
 * "Streamlined System": each Cyrillic letter maps to a fixed Latin sequence,
 * with the single orthographic exception that a word-final "ия" is rendered
 * "ia" (so София → sofia, България → bulgaria), while a medial "ия" stays
 * "iya" (Диян → diyan).
 *
 * Slugs are assigned once at creation and never regenerated when a name
 * changes, so links stay stable. Collisions get a numeric suffix (-2, -3, …).
 */

/** Streamlined-System letter table (lowercase; input is lowercased first). */
const BG_TO_LATIN: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sht',
  ъ: 'a',
  ь: 'y',
  ю: 'yu',
  я: 'ya',
};

const SLUG_MAX_LENGTH = 80;

function mapLetters(word: string): string {
  let out = '';
  for (const ch of word) {
    out += BG_TO_LATIN[ch] ?? ch;
  }
  return out;
}

/** Transliterate one lowercase letter-run, applying the word-final "ия" rule. */
function transliterateWord(word: string): string {
  if (word.endsWith('ия')) {
    return mapLetters(word.slice(0, -2)) + 'ia';
  }
  return mapLetters(word);
}

/**
 * Transliterate Bulgarian Cyrillic to Latin per the Streamlined System.
 * Non-Cyrillic letters pass through unchanged; case is preserved by mapping
 * on a lowercased copy is *not* done here — callers that need casing should
 * not rely on it, since {@link slugify} lowercases anyway.
 */
export function transliterateBg(input: string): string {
  return input.replace(/\p{L}+/gu, (word) => transliterateWord(word.toLowerCase()));
}

/**
 * Build a URL slug: transliterate, lowercase, and reduce to `[a-z0-9]` words
 * joined by hyphens, truncated to a sane length at a word boundary. Returns
 * "" when the input has no usable characters (caller supplies a fallback).
 */
export function slugify(input: string, maxLength = SLUG_MAX_LENGTH): string {
  const lower = input.toLowerCase();
  // Transliterate Cyrillic → Latin *before* touching diacritics: NFD would
  // otherwise decompose Cyrillic й into и + combining breve and corrupt it.
  const latin = lower.replace(/\p{L}+/gu, transliterateWord);
  // Now strip Latin diacritics only (é → e). NFD (not NFKD) so symbols like №
  // aren't expanded into letters ("No") — they should be dropped, not spelled.
  const stripped = latin.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const cleaned = stripped.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!cleaned) return '';

  const words = cleaned.split('-');
  let out = words[0] ?? '';
  for (let i = 1; i < words.length; i++) {
    const word = words[i] as string;
    if (out.length + 1 + word.length > maxLength) break;
    out += '-' + word;
  }
  if (out.length > maxLength) {
    out = out.slice(0, maxLength).replace(/-+$/, '');
  }
  return out;
}

/**
 * Return `base` if free, else the first free `base-2`, `base-3`, … . `isTaken`
 * is queried against each candidate. Throws only on a pathological run of
 * collisions (never expected in practice) so a bug can't spin forever.
 */
export function resolveSlugCollision(
  base: string,
  isTaken: (candidate: string) => boolean,
): string {
  if (!isTaken(base)) return base;
  for (let n = 2; n < 100_000; n++) {
    const candidate = `${base}-${String(n)}`;
    if (!isTaken(candidate)) return candidate;
  }
  throw new Error(`Could not resolve a unique slug for "${base}"`);
}

/**
 * Slug for a facility from its name, with a stable fallback when the name is
 * missing or transliterates to nothing (e.g. a numeric-only name). The
 * fallback keeps every facility linkable even before it is named.
 */
export function facilitySlug(
  name: string | null | undefined,
  fallback: string,
  isTaken: (candidate: string) => boolean,
): string {
  const base = (name ? slugify(name) : '') || slugify(fallback) || 'obekt';
  return resolveSlugCollision(base, isTaken);
}
