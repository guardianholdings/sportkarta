'use client';

import { useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Link, usePathname, useRouter } from '@/i18n/navigation';
import {
  ACCESS_OPTIONS,
  filtersToSearchParams,
  isDefaultAccess,
  type PublicFilters,
} from '@/lib/filters';
import { distanceKm, formatKm } from '@/lib/geo';
// ./sports subpath (not the barrel) — keeps the storage adapter's node:fs out
// of the client bundle.
import { CANONICAL_SPORTS, CANONICAL_SURFACES } from '@sportkarta/lib/sports';

import type { FacilityFeatureCollection } from '@/lib/public-data';

import type { MapPoint, MapView } from './map-canvas';

// MapLibre touches `window`, so the canvas is client-only. Everything else in
// this component (filters, list, sheet) still server-renders for SEO / no-JS.
const MapCanvas = dynamic(() => import('./map-canvas'), {
  ssr: false,
  loading: () => <div className="h-full w-full animate-pulse bg-neutral-100" />,
});

interface MapExplorerProps {
  filters: PublicFilters;
  initialFacilities: MapPoint[];
  initialView: MapView;
}

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export function MapExplorer({ filters, initialFacilities, initialView }: MapExplorerProps) {
  const t = useTranslations('Map');
  const tSport = useTranslations('Sport');
  const tSurface = useTranslations('Surface');
  const tAccess = useTranslations('Access');
  const tFacility = useTranslations('Facility');
  const router = useRouter();
  const pathname = usePathname();

  const [points, setPoints] = useState<MapPoint[]>(initialFacilities);
  const [userLocation, setUserLocation] = useState<{ lon: number; lat: number } | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState(false);

  const filterKey = filtersToSearchParams(filters).toString();

  // Fetch the full filtered set for the map whenever filters change. The SSR
  // list (initialFacilities) covers the first paint until this resolves.
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/facilities?${filterKey}`, { signal: controller.signal })
      .then((r) => r.json() as Promise<FacilityFeatureCollection>)
      .then((fc) => {
        setPoints(
          fc.features.map((f) => ({
            slug: f.properties.slug,
            name: f.properties.name,
            sports: f.properties.sports,
            lon: f.geometry.coordinates[0],
            lat: f.geometry.coordinates[1],
          })),
        );
      })
      .catch(() => {
        /* aborted or offline — keep the current points */
      });
    return () => controller.abort();
  }, [filterKey]);

  // Preserve viewport params (written by onMoveEnd) across filter navigations.
  function viewportParams(): [string, string][] {
    if (typeof window === 'undefined') return [];
    const sp = new URLSearchParams(window.location.search);
    return (['z', 'lat', 'lng'] as const)
      .map((k) => [k, sp.get(k)] as [string, string | null])
      .filter((e): e is [string, string] => e[1] !== null);
  }

  function applyFilters(next: PublicFilters) {
    const params = filtersToSearchParams(next);
    for (const [k, v] of viewportParams()) params.set(k, v);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  // While a facility sheet is open the user is about to navigate; suppress
  // viewport URL writes so a late map moveend (e.g. the geolocate flyTo ending)
  // can't clobber that client-side navigation with a replaceState.
  const suppressViewportUrl = useRef(false);
  useEffect(() => {
    suppressViewportUrl.current = selectedSlug !== null;
  }, [selectedSlug]);

  const onMoveEndRef = useRef((view: MapView) => {
    if (typeof window === 'undefined' || suppressViewportUrl.current) return;
    const sp = new URLSearchParams(window.location.search);
    sp.set('z', view.zoom.toFixed(2));
    sp.set('lat', view.lat.toFixed(5));
    sp.set('lng', view.lng.toFixed(5));
    window.history.replaceState(null, '', `${window.location.pathname}?${sp.toString()}`);
  });

  function locate() {
    if (!('geolocation' in navigator)) {
      setLocateError(true);
      return;
    }
    setLocating(true);
    setLocateError(false);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setUserLocation({ lon: pos.coords.longitude, lat: pos.coords.latitude });
        setLocating(false);
      },
      () => {
        setLocateError(true);
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }

  // Distance-sorted nearest set once located; otherwise the SSR list order.
  const listItems = useMemo(() => {
    if (userLocation) {
      return points
        .map((p) => ({ point: p, km: distanceKm(userLocation, { lon: p.lon, lat: p.lat }) }))
        .sort((a, b) => a.km - b.km)
        .slice(0, 50);
    }
    return initialFacilities.slice(0, 50).map((p) => ({ point: p, km: null as number | null }));
  }, [userLocation, points, initialFacilities]);

  const selected = useMemo(
    () => (selectedSlug ? (points.find((p) => p.slug === selectedSlug) ?? null) : null),
    [selectedSlug, points],
  );

  function sportLabels(sports: string[]): string {
    return sports
      .slice(0, 3)
      .map((s) => tSport(s))
      .join(' · ');
  }

  return (
    <div className="flex h-[100dvh] flex-col">
      <a
        href="#facility-list"
        className="sr-only focus:not-sr-only focus:block focus:bg-neutral-900 focus:p-2 focus:text-white"
      >
        {t('skipToList')}
      </a>

      {/* Filters */}
      <div className="border-b border-neutral-200 bg-white">
        <div className="flex flex-wrap items-center gap-2 p-2 text-sm">
          <button
            type="button"
            onClick={locate}
            className="rounded-md bg-neutral-900 px-3 py-1.5 font-medium text-white"
          >
            {locating ? t('locating') : t('locate')}
          </button>
          {locateError && <span className="text-red-600">{t('locateError')}</span>}

          <fieldset className="flex flex-wrap items-center gap-2">
            <legend className="sr-only">{t('access')}</legend>
            {ACCESS_OPTIONS.map((a) => (
              <label key={a} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={filters.access.includes(a)}
                  onChange={() => {
                    applyFilters({ ...filters, access: toggle(filters.access, a) });
                  }}
                />
                {tAccess(a)}
              </label>
            ))}
          </fieldset>

          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={filters.onlyLit}
              onChange={() => {
                applyFilters({ ...filters, onlyLit: !filters.onlyLit });
              }}
            />
            {t('onlyLit')}
          </label>

          <details className="relative">
            <summary className="cursor-pointer rounded-md border border-neutral-300 px-3 py-1.5">
              {t('sport')}
              {filters.sports.length > 0 ? ` (${String(filters.sports.length)})` : ''}
            </summary>
            <div className="absolute z-10 mt-1 grid max-h-72 w-64 grid-cols-2 gap-1 overflow-auto rounded-md border border-neutral-200 bg-white p-2 shadow-lg">
              {CANONICAL_SPORTS.map((s) => (
                <label key={s} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={filters.sports.includes(s)}
                    onChange={() => {
                      applyFilters({ ...filters, sports: toggle(filters.sports, s) });
                    }}
                  />
                  {tSport(s)}
                </label>
              ))}
            </div>
          </details>

          <details className="relative">
            <summary className="cursor-pointer rounded-md border border-neutral-300 px-3 py-1.5">
              {t('surface')}
              {filters.surfaces.length > 0 ? ` (${String(filters.surfaces.length)})` : ''}
            </summary>
            <div className="absolute z-10 mt-1 grid max-h-72 w-56 grid-cols-2 gap-1 overflow-auto rounded-md border border-neutral-200 bg-white p-2 shadow-lg">
              {CANONICAL_SURFACES.map((s) => (
                <label key={s} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={filters.surfaces.includes(s)}
                    onChange={() => {
                      applyFilters({ ...filters, surfaces: toggle(filters.surfaces, s) });
                    }}
                  />
                  {tSurface(s)}
                </label>
              ))}
            </div>
          </details>

          {(filters.sports.length > 0 ||
            filters.surfaces.length > 0 ||
            filters.onlyLit ||
            !isDefaultAccess(filters.access)) && (
            <button
              type="button"
              onClick={() => {
                applyFilters({ sports: [], access: ['free'], onlyLit: false, surfaces: [] });
              }}
              className="text-neutral-600 underline"
            >
              {t('reset')}
            </button>
          )}
        </div>
      </div>

      {/* Map + list */}
      <div className="relative flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="relative h-[55vh] w-full md:h-auto md:flex-1">
          <MapCanvas
            points={points}
            userLocation={userLocation}
            selectedSlug={selectedSlug}
            initialView={initialView}
            myLocationLabel={t('myLocation')}
            onSelect={setSelectedSlug}
            onMoveEnd={(v) => onMoveEndRef.current(v)}
          />

          {selected && (
            <div
              role="dialog"
              aria-label={selected.name ?? tFacility('unnamed')}
              className="absolute inset-x-2 bottom-2 z-20 rounded-xl border border-neutral-200 bg-white p-4 shadow-xl md:inset-x-auto md:right-4 md:w-80"
              data-testid="facility-sheet"
            >
              <button
                type="button"
                onClick={() => {
                  setSelectedSlug(null);
                }}
                aria-label={t('close')}
                className="absolute right-3 top-3 text-neutral-400 hover:text-neutral-700"
              >
                ✕
              </button>
              <h2 className="pr-6 font-semibold">{selected.name ?? tFacility('unnamed')}</h2>
              {selected.sports.length > 0 && (
                <p className="mt-1 text-sm text-neutral-600">{sportLabels(selected.sports)}</p>
              )}
              <Link
                href={`/obekt/${selected.slug}`}
                className="mt-3 inline-block rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white"
              >
                {t('viewDetails')}
              </Link>
            </div>
          )}
        </div>

        <aside
          id="facility-list"
          className="min-h-0 w-full overflow-auto border-t border-neutral-200 md:w-96 md:border-l md:border-t-0"
        >
          <h2 className="sticky top-0 border-b border-neutral-100 bg-white px-4 py-2 text-sm font-medium">
            {t('results')} · {t('resultsCount', { count: points.length })}
          </h2>
          {listItems.length === 0 ? (
            <p className="p-4 text-sm text-neutral-500">{t('empty')}</p>
          ) : (
            <ul>
              {listItems.map(({ point, km }) => (
                <li key={point.slug} className="border-b border-neutral-100">
                  <Link
                    href={`/obekt/${point.slug}`}
                    onClick={(e) => {
                      e.preventDefault();
                      setSelectedSlug(point.slug);
                    }}
                    className="block px-4 py-3 hover:bg-neutral-50"
                    data-facility-slug={point.slug}
                  >
                    <span className="font-medium">{point.name ?? tFacility('unnamed')}</span>
                    {km !== null && (
                      <span className="ml-2 text-xs text-neutral-500">
                        {t('distanceKm', { km: formatKm(km) })}
                      </span>
                    )}
                    {point.sports.length > 0 && (
                      <span className="block text-xs text-neutral-500">
                        {sportLabels(point.sports)}
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}
