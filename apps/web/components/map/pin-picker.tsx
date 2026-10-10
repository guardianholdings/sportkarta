'use client';

import { BULGARIA_BOUNDS } from '@sportkarta/lib/geo';
import maplibregl from 'maplibre-gl';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';

import { createStaticPin } from '@/components/map/markers';
import { ensurePmtilesProtocol } from '@/lib/map/pmtiles';
import { buildMapStyle, mapAssetUrls } from '@/lib/map/style';

import 'maplibre-gl/dist/maplibre-gl.css';

export interface PinPickerHandle {
  /**
   * Put the pin where the device says the member is standing — unless they have
   * already placed it themselves, which always wins over a GPS guess.
   */
  offerFix(lon: number, lat: number): void;
}

interface PinPickerProps {
  /** Starting centre — Sofia, until the member or their device says otherwise. */
  initialLon: number;
  initialLat: number;
  /** The start came from the map ("add a facility here"): it already IS a choice. */
  initiallyPlaced?: boolean;
  /** Told whenever the pin is placed — by the member's hand or by their device. */
  onPlaced?: () => void;
  ref?: Ref<PinPickerHandle>;
}

function round6(value: number): number {
  return Number(value.toFixed(6));
}

/**
 * Coordinate picker for adding a facility: the pin starts where the device says
 * the member is when it can, and is draggable so the member can correct it.
 * Phone GPS is routinely tens of metres out and often lands you on the pavement
 * rather than the pitch — the manual adjustment is the point, not a fallback.
 *
 * AN UNTOUCHED PIN IS NOT A LOCATION. The pin used to start in central Sofia and
 * post from there as if chosen, so a member in Varna who never looked at the
 * map filed their pitch at the National Palace of Culture. The picker now knows
 * whether the pin has been PLACED — by a drag, a tap, «Моето местоположение» or
 * a fix the device offered — and posts no coordinates until it has; the form
 * says what is missing instead of submitting (UX audit 2026-10-10). A fix only
 * ever moves a pin the member has not touched.
 *
 * The chosen coordinates are mirrored into hidden inputs, so the surrounding
 * server-action form posts them with no client-side fetch of its own. They are
 * re-validated server-side (bbox + duplicate check) regardless.
 */
export function PinPicker({
  initialLon,
  initialLat,
  initiallyPlaced = false,
  onPlaced,
  ref,
}: PinPickerProps) {
  const t = useTranslations('AddFacility');
  const containerRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ lon: initialLon, lat: initialLat });
  const [placed, setPlaced] = useState(initiallyPlaced);
  // Placed from a GPS fix rather than by eye: the hint says so, because the
  // member may well be adding a pitch they are not standing on.
  const [fromDevice, setFromDevice] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState(false);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  // A deliberate choice (drag, tap, the button) that a later fix must not undo.
  const chosenRef = useRef(initiallyPlaced);
  const onPlacedRef = useRef(onPlaced);
  useEffect(() => {
    onPlacedRef.current = onPlaced;
  });

  const place = useCallback((lon: number, lat: number, how: 'hand' | 'device') => {
    setPosition({ lon: round6(lon), lat: round6(lat) });
    setPlaced(true);
    setFromDevice(how === 'device');
    onPlacedRef.current?.();
  }, []);

  const moveTo = useCallback((lon: number, lat: number) => {
    markerRef.current?.setLngLat([lon, lat]);
    mapRef.current?.flyTo({ center: [lon, lat], zoom: 17 });
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      offerFix(lon, lat) {
        if (chosenRef.current) return;
        moveTo(lon, lat);
        place(lon, lat, 'device');
      },
    }),
    [moveTo, place],
  );

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
        // The pan limit matters MORE here than on the explorer. `addFacility`
        // rejects any coordinate outside this same box with `outside_bulgaria`,
        // so without it a member can pan into Greece, drop a pin, fill in the
        // whole form and only then be told no. Constraining the picker makes
        // that rejection unreachable rather than a trap — the validator stays,
        // because a form field is not a guarantee, but nobody should ever meet
        // it. Both now read the box from the same constant.
        maxBounds: BULGARIA_BOUNDS as unknown as maplibregl.LngLatBoundsLike,
        attributionControl: { compact: true },
      });
    } catch (error) {
      // No WebGL: «Моето местоположение» still places the pin.
      console.error('MapLibre pin picker init failed', error);
      return;
    }
    mapRef.current = map;

    const marker = new maplibregl.Marker({
      draggable: true,
      element: createStaticPin(44),
      anchor: 'bottom',
    })
      .setLngLat([initialLon, initialLat])
      .addTo(map);
    markerRef.current = marker;

    marker.on('dragend', () => {
      const { lng, lat } = marker.getLngLat();
      chosenRef.current = true;
      place(lng, lat, 'hand');
    });

    // Tapping the map is faster than dragging on a phone.
    map.on('click', (event) => {
      marker.setLngLat(event.lngLat);
      chosenRef.current = true;
      place(event.lngLat.lng, event.lngLat.lat, 'hand');
    });

    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, [initialLon, initialLat, place]);

  function locateMe(): void {
    if (!navigator.geolocation) {
      setLocationError(true);
      return;
    }
    setLocating(true);
    setLocationError(false);
    navigator.geolocation.getCurrentPosition(
      (found) => {
        const { longitude: lon, latitude: lat } = found.coords;
        // Asked for by the member, so it is their choice — a later fix from
        // the form's own location request must not move it again.
        chosenRef.current = true;
        moveTo(lon, lat);
        place(lon, lat, 'device');
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
        className="h-72 w-full overflow-hidden rounded-lg border border-line-strong bg-paper-sunk"
      />
      {/* Empty until placed: an untouched pin never posts as a choice — the
          server answers `invalid_coordinates` even if the client check is
          bypassed. */}
      <input type="hidden" name="lon" value={placed ? position.lon : ''} />
      <input type="hidden" name="lat" value={placed ? position.lat : ''} />

      <div className="flex flex-wrap items-center gap-3 text-body-sm">
        <button
          type="button"
          onClick={locateMe}
          disabled={locating}
          className="min-h-11 rounded-pill border border-line-strong bg-surface px-4 py-1.5 font-semibold text-ink-soft hover:bg-surface-2 disabled:opacity-50"
        >
          {locating ? t('locating') : t('useMyLocation')}
        </button>
        {placed && (
          <span className="text-ink-soft">
            {t('coordinates', { lat: position.lat.toFixed(5), lon: position.lon.toFixed(5) })}
          </span>
        )}
      </div>

      <p className="text-caption text-text-muted">
        {!placed ? t('pinChoose') : fromDevice ? t('pinAtYourLocation') : t('pinHint')}
      </p>
      {locationError && (
        <p role="alert" className="text-caption text-warning">
          {t('locationUnavailable')}
        </p>
      )}
    </div>
  );
}
