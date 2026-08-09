import type { MetadataRoute } from 'next';

import messages from '@/messages/bg.json';

// PWA manifest → /manifest.webmanifest. Bulgarian-first (the app defaults to bg
// at "/"). Standalone install; the service worker (public/sw.js) provides the
// offline fallback + last-viewport tile cache. Strings come from messages/bg.json
// to keep the single-source-of-truth invariant the i18n gate enforces.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: messages.Metadata.title,
    short_name: messages.Manifest.shortName,
    description: messages.Metadata.description,
    lang: 'bg',
    dir: 'ltr',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    // = --paper and --accent in app/design-tokens/colors.css. The install
    // splash is brand paper; the chrome is the MARK's coral so the installed
    // app matches its own icon (docs/design/pops-brand/HANDOFF.md). Pinned
    // against the token layer by tests/theme-color-drift.test.ts so they
    // cannot go stale again.
    background_color: '#F5F3EE',
    theme_color: '#FF4A2B',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
