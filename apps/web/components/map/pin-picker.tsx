'use client';

import maplibregl from 'maplibre-gl';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

import { ensurePmtilesProtocol } from '@/lib/map/pmtiles';
import { buildMapStyle, mapAssetUrls } from '@/lib/map/style';

import 'maplibre-gl/dist/maplibre-gl.css';

interface PinPickerProps {
  /** Starting centre — Sofia, until the browser offers something better. */
  initialLon: number;
  initialLat: number;
}

/**
 * Coordinate picker for adding a facility: the map centres on the device
 * location when permission is given, and the pin is draggable so the member can
 * correct it. Phone GPS is routinely tens of metres out and often lands you on
 * the pavement rather than the pitch — the manual adjustment is the point, not
 * a fallback.
 *
 * The chosen coordinates are mirrored into hidden inputs, so the surrounding
 * server-action form posts them with no client-side fetch of its own. They are
 * re-validated server-side (bbox + duplicate check) regardless.
 */
export function PinPicker({ initialLon, initialLat }: PinPickerProps) {
  const t = useTranslations('AddFacility');
  const containerRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ lon: initialLon, lat: initialLat });
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState(false);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    ensurePmtilesProtocol();

    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: buildMapStyle(mapAssetUrls(window.location.origin)),
        center: [initialLon, initialLat],
        zoom: 16,
        attributionControl: { compact: true },
      });
    } catch (error) {
      // No WebGL: the numeric readout and manual entry still work.
      console.error('MapLibre pin picker init failed', error);
      return;
    }
    mapRef.current = map;

    const marker = new maplibregl.Marker({ draggable: true, color: '#0f766e' })
      .setLngLat([initialLon, initialLat])
      .addTo(map);
    markerRef.current = marker;

    marker.on('dragend', () => {
      const { lng, lat } = marker.getLngLat();
      setPosition({ lon: Number(lng.toFixed(6)), lat: Number(lat.toFixed(6)) });
    });

    // Tapping the map is faster than dragging on a phone.
    map.on('click', (event) => {
      marker.setLngLat(event.lngLat);
      setPosition({
        lon: Number(event.lngLat.lng.toFixed(6)),
        lat: Number(event.lngLat.lat.toFixed(6)),
      });
    });

    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, [initialLon, initialLat]);

  function locateMe(): void {
    if (!navigator.geolocation) {
      setLocationError(true);
      return;
    }
    setLocating(true);
    setLocationError(false);
    navigator.geolocation.getCurrentPosition(
      (found) => {
        const lon = Number(found.coords.longitude.toFixed(6));
        const lat = Number(found.coords.latitude.toFixed(6));
        setPosition({ lon, lat });
        markerRef.current?.setLngLat([lon, lat]);
        mapRef.current?.flyTo({ center: [lon, lat], zoom: 17 });
        setLocating(false);
      },
      () => {
        // Denied or unavailable — the pin stays where it is and can be dragged.
        setLocationError(true);
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }

  return (
    <div className="space-y-2">
      <div
        ref={containerRef}
        role="application"
        aria-label={t('mapLabel')}
        className="h-72 w-full rounded border border-neutral-300 bg-neutral-100"
      />
      <input type="hidden" name="lon" value={position.lon} />
      <input type="hidden" name="lat" value={position.lat} />

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <button
          type="button"
          onClick={locateMe}
          disabled={locating}
          className="rounded border border-neutral-300 px-3 py-1 disabled:opacity-50"
        >
          {locating ? t('locating') : t('useMyLocation')}
        </button>
        <span className="text-neutral-600">
          {t('coordinates', { lat: position.lat.toFixed(5), lon: position.lon.toFixed(5) })}
        </span>
      </div>

      <p className="text-xs text-neutral-500">{t('pinHint')}</p>
      {locationError && (
        <p role="alert" className="text-xs text-amber-700">
          {t('locationUnavailable')}
        </p>
      )}
    </div>
  );
}
