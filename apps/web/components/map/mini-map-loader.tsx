'use client';

import dynamic from 'next/dynamic';

// Client boundary so the server facility page can embed the MapLibre mini-map:
// next/dynamic({ ssr:false }) is only allowed inside a client component.
const MiniMap = dynamic(() => import('./mini-map'), {
  ssr: false,
  loading: () => <div className="h-56 w-full animate-pulse rounded-lg bg-paper-sunk" />,
});

export function MiniMapLoader(props: { lon: number; lat: number; label: string }) {
  return <MiniMap {...props} />;
}
