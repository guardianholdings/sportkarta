import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Font buffers for `next/og`, read once per process.
 *
 * THREE THINGS HERE ARE LOAD-BEARING, and each has a prod-only failure mode.
 *
 * 1. `.woff`, NEVER `.woff2`. satori cannot decode woff2 without an extra wasm
 *    build. @fontsource ships both, and the woff2 is the one every other part of
 *    the app uses (app/fonts.css), so picking the wrong one is easy and fails
 *    at render rather than at build.
 *
 * 2. THE CYRILLIC SUBSET. The vendored fallback inside @vercel/og is Latin-only
 *    Noto Sans, so a card built with the latin subset renders every Bulgarian
 *    title as tofu — while passing on a developer's machine if any system font
 *    happens to cover it. This is the exact failure docs/ENGAGEMENT.md §4 warns
 *    about, and why apps/web/tests/og-render.test.ts asserts on a Cyrillic
 *    string rather than a Latin one.
 *
 * 3. READ FROM `public/`, NOT node_modules. The Docker web target copies only
 *    `.next/standalone`, `.next/static` and `public/` (Dockerfile:29). A buffer
 *    read from node_modules works in dev and throws ENOENT in the container
 *    unless nft traced it — and nft following pnpm's symlinked store, from an
 *    app in a workspace with no `outputFileTracingRoot`, is precisely the
 *    fragile case. `public/` is copied verbatim and already carries binary font
 *    assets (the MapLibre .pbf glyphs), so this is the established path.
 *
 * `process.cwd()` resolves to `apps/web` in BOTH environments: under `next dev`
 * because that is where it is started, and in the container because the
 * generated standalone `server.js` calls `process.chdir(__dirname)`. The tiles
 * route already depends on this same fact.
 */

const FONT_DIR = join(process.cwd(), 'public', 'fonts', 'og');

export const OG_FONT_FILES = {
  manrope400: 'manrope-cyrillic-400-normal.woff',
  manrope600: 'manrope-cyrillic-600-normal.woff',
  manrope800: 'manrope-cyrillic-800-normal.woff',
  mono500: 'jetbrains-mono-cyrillic-500-normal.woff',
} as const;

export const OG_FONT_DIR = FONT_DIR;

/** Satori's font descriptor list. Read at module scope — a 1200×630 render must
 *  not re-read four files per request. */
let cached: OgFont[] | null = null;

export interface OgFont {
  name: string;
  data: Buffer;
  weight: 400 | 500 | 600 | 800;
  style: 'normal';
}

export function ogFonts(): OgFont[] {
  if (cached) return cached;
  const read = (file: string): Buffer => readFileSync(join(FONT_DIR, file));
  cached = [
    { name: 'Manrope', data: read(OG_FONT_FILES.manrope400), weight: 400, style: 'normal' },
    { name: 'Manrope', data: read(OG_FONT_FILES.manrope600), weight: 600, style: 'normal' },
    { name: 'Manrope', data: read(OG_FONT_FILES.manrope800), weight: 800, style: 'normal' },
    { name: 'JetBrains Mono', data: read(OG_FONT_FILES.mono500), weight: 500, style: 'normal' },
  ];
  return cached;
}
