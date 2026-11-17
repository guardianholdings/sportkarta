/**
 * The heading font's two files at their fixed addresses: Unbounded 800, the
 * face of every page's <h1>, one file per alphabet.
 *
 * Fixed, because a file can only be preloaded by a name known before the
 * build; the fonts bundled through CSS are renamed with a content hash. The
 * files in public/fonts/ui are copies of the @fontsource package's, declared
 * in app/fonts.css and preloaded by app/[locale]/layout.tsx. Three places
 * that must agree — tests/fonts.test.ts holds them together, and fails when a
 * package upgrade changes the bytes and the copies are not refreshed.
 */
export const HEADING_FONT = {
  bg: '/fonts/ui/unbounded-cyrillic-800-normal.woff2',
  en: '/fonts/ui/unbounded-latin-800-normal.woff2',
} as const;
