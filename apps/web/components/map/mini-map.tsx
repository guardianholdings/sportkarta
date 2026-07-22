'use client';

import maplibregl from 'maplibre-gl';
import { useEffect, useRef } from 'react';

import { ensurePmtilesProtocol } from '@/lib/map/pmtiles';
import { buildMapStyle, mapAssetUrls } from '@/lib/map/style';

import 'maplibre-gl/dist/maplibre-gl.css';

interface MiniMapProps {
  lon: number;
  lat: number;
  label: string;
}

// A small, non-interactive locator map for the facility page: one marker,
// no pan/zoom. Shares the pmtiles basemap + attribution; degrades to a plain
// background when tiles are absent.
export default function MiniMap({ lon, lat, label }: MiniMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    ensurePmtilesProtocol();

    // Degrade gracefully if WebGL is unavailable — the rest of the page stays up.
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: buildMapStyle(mapAssetUrls(window.location.origin)),
        center: [lon, lat],
        zoom: 15,
        interactive: false,
        attributionControl: { compact: true },
      });
    } catch (error) {
      console.error('MapLibre mini-map init failed', error);
      return;
    }
    const marker = new maplibregl.Marker({ color: '#059669' }).setLngLat([lon, lat]).addTo(map);
    map.getCanvas().setAttribute('aria-label', label);

    return () => {
      marker.remove();
      map.remove();
    };
  }, [lon, lat, label]);

  return <div ref={containerRef} className="h-56 w-full overflow-hidden rounded-lg" />;
}
