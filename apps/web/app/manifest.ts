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
    // The installed app opens on the map, as it always has: the front page at
    // "/" is for visitors arriving from a link or a search. `id` is pinned to
    // the OLD start_url because a manifest without one is identified BY its
    // start_url — moving it to /karta would otherwise turn every installed copy
    // into a different app that no longer receives updates.
    id: '/',
    start_url: '/karta',
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
