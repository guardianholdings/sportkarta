import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

// Regenerate the app icons from the POPS brand artwork:
//   node scripts/gen-icons.mjs   (from apps/web)
//
// Outputs (the full set of raster icon slots):
//   app/icon1.png                 192  favicon PNG fallback (app/icon0.svg is
//                                      the primary, served as-is)
//   app/apple-icon.png            180  apple-touch-icon — FULL-BLEED: iOS masks
//                                      it itself; transparent corners go black
//   public/icons/icon-192.png     192  manifest "any" + SW precache
//   public/icons/icon-512.png     512  manifest "any"
//   public/icons/icon-maskable-512.png 512 manifest "maskable" — full-bleed,
//                                      mark inside the ~80% safe zone
//
// The rounded artwork is public/brand/favicon.svg (compact mark, 22% radius,
// coral) — the brand package's own favicon. The full-bleed variant is the same
// geometry as public/brand/icon-app.svg with the corner radius removed.
// After changing icon pixels, bump VERSION in public/sw.js — /icons/* is
// served cache-first with no revalidation, so installed PWAs keep old pixels
// until the cache name changes.

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iconsDir = path.join(webRoot, 'public/icons');
const appDir = path.join(webRoot, 'app');

const rounded = readFileSync(path.join(webRoot, 'public/brand/favicon.svg'));

// Full mark, white on coral, full-bleed (mark spans ~56% width — inside the
// maskable safe zone). Colours: --coral-500 / white; a raw hex is fine here,
// this is an asset generator, not product code.
const fullBleed = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024"><rect width="1024" height="1024" fill="#FF4A2B"></rect><g transform="translate(512 512) scale(5.9) translate(-50 -50)"><circle cx="31" cy="22" r="9" fill="#FFFFFF"></circle><circle cx="69" cy="22" r="9" fill="#FFFFFF"></circle><path d="M8 44 A42 42 0 0 0 92 44" fill="none" stroke="#FFFFFF" stroke-width="11" stroke-linecap="round"></path><path d="M24 44 A26 26 0 0 0 76 44" fill="none" stroke="#FFFFFF" stroke-width="11" stroke-linecap="round"></path></g></svg>`,
);

const jobs = [
  { src: rounded, size: 192, out: path.join(appDir, 'icon1.png') },
  { src: fullBleed, size: 180, out: path.join(appDir, 'apple-icon.png') },
  { src: rounded, size: 192, out: path.join(iconsDir, 'icon-192.png') },
  { src: rounded, size: 512, out: path.join(iconsDir, 'icon-512.png') },
  { src: fullBleed, size: 512, out: path.join(iconsDir, 'icon-maskable-512.png') },
];

for (const { src, size, out } of jobs) {
  const buf = await sharp(src, { density: 72 * (size / 100) * 2 })
    .resize(size, size)
    .png()
    .toBuffer();
  writeFileSync(out, buf);
  console.log(path.relative(webRoot, out), buf.length, 'bytes');
}
