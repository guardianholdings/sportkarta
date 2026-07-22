import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

// Regenerate the PWA icons: `node scripts/gen-icons.mjs` from apps/web.
// A simple location-pin mark on the brand teal — recognizable for a map app.
const TEAL = '#0f766e';
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(webRoot, 'public/icons');
const appDir = path.join(webRoot, 'app');
mkdirSync(dir, { recursive: true });

const pin = (cx, cy, scale) => `
  <path transform="translate(${cx} ${cy}) scale(${scale}) translate(-256 -256)"
        d="M256 96 C 188 96 132 152 132 220 C 132 300 256 420 256 420 C 256 420 380 300 380 220 C 380 152 324 96 256 96 Z"
        fill="#ffffff"/>
  <circle transform="translate(${cx} ${cy}) scale(${scale}) translate(-256 -256)"
          cx="256" cy="220" r="50" fill="${TEAL}"/>`;

// `any` icon: rounded square + centered pin. Maskable: full-bleed + pin kept
// inside the ~80% safe zone (smaller scale).
const svg = (
  maskable,
) => `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${maskable ? 0 : 96}" fill="${TEAL}"/>
  ${pin(256, 256, maskable ? 0.62 : 0.82)}
</svg>`;

async function render(svgStr, size, file) {
  await sharp(Buffer.from(svgStr)).resize(size, size).png().toFile(file);
  console.log('wrote', path.relative(webRoot, file));
}

await render(svg(false), 192, path.join(dir, 'icon-192.png'));
await render(svg(false), 512, path.join(dir, 'icon-512.png'));
await render(svg(true), 512, path.join(dir, 'icon-maskable-512.png'));
// Next's file convention: app/apple-icon.png auto-emits <link rel="apple-touch-icon">.
await render(svg(false), 180, path.join(appDir, 'apple-icon.png'));
