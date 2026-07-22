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
    background_color: '#f6f5f2',
    theme_color: '#0f766e',
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
