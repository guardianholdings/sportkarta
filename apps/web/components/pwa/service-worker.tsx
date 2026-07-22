'use client';

import { useEffect } from 'react';

// Registers the PWA service worker (public/sw.js) in production only — in dev it
// would fight Next's HMR. Renders nothing.
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
      console.error('Service worker registration failed', error);
    });
  }, []);

  return null;
}
