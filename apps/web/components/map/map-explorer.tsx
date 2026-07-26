'use client';

import {
  ArrowLeft,
  Layers,
  LocateFixed,
  MapPin,
  Navigation,
  Plus,
  Search,
  SlidersHorizontal,
  WifiOff,
  X,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';
import { useEffect, useMemo, useRef, useState } from 'react';

import { AdCreative } from '@/components/ads/ad-creative';
import { BottomNav, NavRail } from '@/components/shell/app-nav';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { facilityFamily, FAMILY_COLOR } from '@/lib/design/families';
import { SPORT_VISUALS } from '@/lib/design/sport-visuals';
import {
  ACCESS_OPTIONS,
  filtersToSearchParams,
  isDefaultAccess,
  type PublicFilters,
} from '@/lib/filters';
import { distanceKm, formatKm } from '@/lib/geo';
import { DEFAULT_LAYER, type ExternalMapLayer } from '@/lib/map/layers';
import { Link, usePathname, useRouter } from '@/i18n/navigation';
import { CANONICAL_SPORTS, CANONICAL_SURFACES, type CanonicalSport } from '@sportkarta/lib/sports';

import type { FacilityFeatureCollection } from '@/lib/public-data';

import type { MapBounds, MapPoint, MapView, NearMe } from './map-canvas';

const MapCanvas = dynamic(() => import('./map-canvas'), {
  ssr: false,
  loading: () => <div className="h-full w-full bg-paper-sunk" />,
});

// Quick chips shown inline; the full 29 live in the filter sheet.
const QUICK_SPORTS: CanonicalSport[] = [
  'football',
  'basketball',
  'volleyball',
  'tennis',
  'swimming',
  'running',
  'fitness',
];

type Snap = 'peek' | 'half' | 'full';
const SNAP_H: Record<Snap, string> = {
  peek: 'h-[128px]',
  half: 'h-[52dvh]',
  full: 'h-[calc(100dvh-3.5rem)]',
};
const SNAP_ORDER: Snap[] = ['peek', 'half', 'full'];

interface MapExplorerProps {
  filters: PublicFilters;
  initialFacilities: MapPoint[];
  initialView: MapView;
  initialSelected: string | null;
  /** External raster basemaps the server configured (lib/map/external-layers.ts). */
  externalLayers?: ExternalMapLayer[];
  /**
   * The `map_panel` ad placement, already resolved and localised by the server
   * page (components/ads/ad-slot.tsx → `adSlotProps`). Three strings and an id:
   * deliberately NOT the row, so no ad logic and no db import cross into the
   * client bundle. Null/absent = unsold = nothing rendered.
   */
  ad?: { id: number; url: string; alt: string } | null;
}

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function primaryVisual(sports: string[]) {
  const s = sports.find((x): x is CanonicalSport => x in SPORT_VISUALS);
  if (s) return SPORT_VISUALS[s];
  const family = facilityFamily(sports);
  return { color: FAMILY_COLOR[family], Icon: SPORT_VISUALS.multi.Icon, family };
}

export function MapExplorer({
  filters,
  initialFacilities,
  initialView,
  initialSelected,
  externalLayers = [],
  ad = null,
}: MapExplorerProps) {
  const t = useTranslations('Map');
  const tAds = useTranslations('Ads');
  const tNav = useTranslations('Nav');
  const tSport = useTranslations('Sport');
  const tFacility = useTranslations('Facility');
  const router = useRouter();
  const pathname = usePathname();

  const [points, setPoints] = useState<MapPoint[]>(initialFacilities);
  const [userLocation, setUserLocation] = useState<{ lon: number; lat: number } | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(initialSelected);
  const [hoveredSlug, setHoveredSlug] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState(false);
  const [nearMeOn, setNearMeOn] = useState(false);
  const [radiusKm, setRadiusKm] = useState(8);
  const [query, setQuery] = useState('');
  const [snap, setSnap] = useState<Snap>('half');
  const [filterOpen, setFilterOpen] = useState(false);
  const [activeLayer, setActiveLayer] = useState<string>(DEFAULT_LAYER);
  const [layerMenuOpen, setLayerMenuOpen] = useState(false);
  const [viewBounds, setViewBounds] = useState<MapBounds | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const filterKey = filtersToSearchParams(filters).toString();

  // Offline awareness for the "your connection dropped" state.
  useEffect(() => {
    const on = () => setOffline(!navigator.onLine);
    on();
    window.addEventListener('online', on);
    window.addEventListener('offline', on);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', on);
    };
  }, []);

  // Full filtered set for the map + list whenever the structured filters change.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(false);
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
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setLoadError(true);
        setLoading(false);
      });
    return () => controller.abort();
  }, [filterKey]);

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
    if (selectedSlug) params.set('selected', selectedSlug);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  // Keep the map mounted: selection rides a search param, not a route change.
  function select(slug: string | null) {
    setSelectedSlug(slug);
    const params = filtersToSearchParams(filters);
    for (const [k, v] of viewportParams()) params.set(k, v);
    if (slug) params.set('selected', slug);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    if (slug) setSnap((s) => (s === 'peek' ? 'half' : s));
  }

  const onMoveEndRef = useRef((view: MapView) => {
    if (typeof window === 'undefined') return;
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

  function toggleNearMe() {
    if (!nearMeOn && !userLocation) {
      locate();
    }
    setNearMeOn((v) => !v);
  }

  const nearMe = useMemo<NearMe | null>(
    () => (nearMeOn && userLocation ? { center: userLocation, radiusKm } : null),
    [nearMeOn, userLocation, radiusKm],
  );

  // Distance-sort + near-me radius + name search, all composing — then a
  // stable partition so whatever is CURRENTLY ON THE MAP leads the list
  // (operator request 2026-07-25): pan to Варна and the thread starts with
  // Варна, while relative order within each half is untouched.
  const listItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    let rows = points.map((p) => ({
      point: p,
      km: userLocation ? distanceKm(userLocation, { lon: p.lon, lat: p.lat }) : null,
    }));
    if (q) rows = rows.filter((r) => (r.point.name ?? '').toLowerCase().includes(q));
    if (nearMe) rows = rows.filter((r) => r.km !== null && r.km <= radiusKm);
    if (userLocation) rows.sort((a, b) => (a.km ?? 0) - (b.km ?? 0));
    if (viewBounds) {
      const visible = (p: MapPoint) =>
        p.lon >= viewBounds.west &&
        p.lon <= viewBounds.east &&
        p.lat >= viewBounds.south &&
        p.lat <= viewBounds.north;
      rows = [...rows.filter((r) => visible(r.point)), ...rows.filter((r) => !visible(r.point))];
    }
    return rows.slice(0, 60);
  }, [points, userLocation, nearMe, radiusKm, query, viewBounds]);

  const selected = useMemo(
    () => (selectedSlug ? (points.find((p) => p.slug === selectedSlug) ?? null) : null),
    [selectedSlug, points],
  );

  // Marker hover → highlight the card AND scroll it into view by computed
  // scrollTop (the seed explicitly rejects scrollIntoView).
  function onHoverMarker(slug: string | null) {
    setHoveredSlug(slug);
    if (!slug) return;
    const box = listRef.current;
    const el = box?.querySelector<HTMLElement>(`[data-slug="${slug}"]`);
    if (box && el) {
      box.scrollTo({ top: el.offsetTop - box.offsetTop - 12, behavior: 'smooth' });
    }
  }

  const activeCount =
    filters.sports.length +
    filters.surfaces.length +
    (filters.onlyLit ? 1 : 0) +
    (isDefaultAccess(filters.access) ? 0 : 1) +
    (nearMeOn ? 1 : 0);

  function sportLabels(sports: string[]): string {
    return sports
      .slice(0, 3)
      .map((s) => tSport(s))
      .join(' · ');
  }

  // ── shared building blocks ────────────────────────────────────────────────

  const chipRow = (
    <div className="flex gap-2 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {QUICK_SPORTS.map((s) => {
        const v = SPORT_VISUALS[s];
        const on = filters.sports.includes(s);
        return (
          <Chip
            key={s}
            color={v.color}
            selected={on}
            icon={<v.Icon size={16} />}
            onClick={() => applyFilters({ ...filters, sports: toggle(filters.sports, s) })}
            className="shrink-0"
          >
            {tSport(s)}
          </Chip>
        );
      })}
    </div>
  );

  const countLine = (
    <span className="font-mono text-caption text-ink-soft">
      {t('resultsCount', { count: points.length })}
    </span>
  );

  function ResultCard({ point, km }: { point: MapPoint; km: number | null }) {
    const v = primaryVisual(point.sports);
    const isSel = point.slug === selectedSlug;
    return (
      <button
        type="button"
        data-slug={point.slug}
        onMouseEnter={() => setHoveredSlug(point.slug)}
        onMouseLeave={() => setHoveredSlug((h) => (h === point.slug ? null : h))}
        onClick={() => select(point.slug)}
        className={`flex w-full items-center gap-3 rounded-card border bg-surface p-2.5 text-left transition-[box-shadow,border-color,transform] duration-150 ease-standard ${
          isSel
            ? 'border-brand shadow-md -translate-y-px'
            : hoveredSlug === point.slug
              ? 'border-brand-border shadow-lg -translate-y-0.5'
              : 'border-line shadow-sm hover:border-brand-border'
        }`}
      >
        <span
          className="grid size-12 shrink-0 place-items-center rounded-md text-on-brand"
          style={{ background: `color-mix(in srgb, ${v.color} 16%, var(--surface))`, color: v.color }}
        >
          <v.Icon size={22} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body-sm font-bold text-ink">
            {point.name ?? tFacility('unnamed')}
          </span>
          {point.sports.length > 0 && (
            <span className="block truncate text-caption text-text-muted">
              {sportLabels(point.sports)}
            </span>
          )}
        </span>
        {km !== null && (
          <span className="shrink-0 font-mono text-caption text-ink-soft">{formatKm(km)}</span>
        )}
      </button>
    );
  }

  const resultsBody = (
    <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-4 pb-24 lg:pb-4">
      {loadError ? (
        <EmptyState
          icon={<WifiOff size={22} />}
          title={t('loadErrorTitle')}
          body={t('loadErrorBody')}
          action={
            <Button size="sm" variant="secondary" onClick={() => applyFilters({ ...filters })}>
              {t('retry')}
            </Button>
          }
        />
      ) : loading && points.length === 0 ? (
        <ul className="space-y-2.5 pt-1">
          {[0, 1, 2, 3, 4].map((i) => (
            <li key={i} className="h-16 animate-pulse rounded-card bg-paper-sunk" />
          ))}
        </ul>
      ) : listItems.length === 0 ? (
        <EmptyState
          icon={<Search size={22} />}
          title={t('emptyTitle')}
          body={query || activeCount > 0 ? t('emptyFiltered') : t('emptyArea')}
          action={
            activeCount > 0 || query ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setQuery('');
                  setNearMeOn(false);
                  applyFilters({ sports: [], access: ['free'], onlyLit: false, surfaces: [] });
                }}
              >
                {t('reset')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="space-y-2.5 pt-1">
          {listItems.map(({ point, km }) => (
            <li key={point.slug}>
              <ResultCard point={point} km={km} />
            </li>
          ))}
        </ul>
      )}
      {/*
        The `map_panel` ad slot (MONETISATION §S5). It sits at the FOOT of the
        results list, inside the panel BESIDE the map — the map canvas itself
        stays ad-free forever. Its data was fetched and localised by the server
        page (`adSlotProps`) and arrives as three plain strings, so this client
        component gains no database import and no ad logic. Absent = unsold =
        nothing rendered, never a placeholder.
      */}
      {ad && (
        <div className="pt-4">
          <AdCreative id={ad.id} url={ad.url} alt={ad.alt} label={tAds('label')} />
        </div>
      )}
    </div>
  );

  const detailPanel = selected && (
    <FacilityPreview
      point={selected}
      onClose={() => select(null)}
      labels={{
        unnamed: tFacility('unnamed'),
        directions: t('directions'),
        viewDetails: t('viewDetails'),
        close: t('close'),
      }}
      sportLabels={sportLabels}
    />
  );

  return (
    <div className="relative h-[100dvh] w-full overflow-hidden bg-paper">
      <a
        href="#facility-list"
        className="sr-only rounded-pill bg-brand px-3 py-2 text-on-brand focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50"
      >
        {t('skipToList')}
      </a>

      {offline && (
        <div className="absolute inset-x-0 top-0 z-40 flex items-center justify-center gap-2 bg-warning-bg py-1.5 text-caption font-medium text-warning">
          <WifiOff size={14} /> {t('offline')}
        </div>
      )}

      {/* ── Map (fills the screen; behind the panels) ── */}
      <div className="absolute inset-0">
        <MapCanvas
          points={points}
          userLocation={userLocation}
          selectedSlug={selectedSlug}
          hoveredSlug={hoveredSlug}
          nearMe={nearMe}
          initialView={initialView}
          myLocationLabel={t('myLocation')}
          unnamedLabel={tFacility('unnamed')}
          onSelect={select}
          onHoverMarker={onHoverMarker}
          onMoveEnd={(v) => onMoveEndRef.current(v)}
          externalLayers={externalLayers}
          activeLayer={activeLayer}
          onBoundsChange={setViewBounds}
        />
      </div>

      {/* Floating map controls — top-right on mobile so the bottom sheet can
          never occlude them (audit P1); bottom-right on desktop, no sheet there. */}
      <div className="absolute right-3 top-3 z-20 flex flex-col gap-2 lg:top-auto lg:bottom-6">
        <IconButton
          aria-label={locating ? t('locating') : t('locate')}
          variant="floating"
          round
          onClick={locate}
          className={locating ? 'animate-pulse' : ''}
        >
          <LocateFixed size={20} className={userLocation ? 'text-brand' : ''} />
        </IconButton>
        {externalLayers.length > 0 && (
          <div className="relative">
            <IconButton
              aria-label={t('layers')}
              aria-expanded={layerMenuOpen}
              variant="floating"
              round
              onClick={() => setLayerMenuOpen((open) => !open)}
            >
              <Layers size={20} className={activeLayer !== DEFAULT_LAYER ? 'text-brand' : ''} />
            </IconButton>
            {layerMenuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-12 z-30 w-48 rounded-card border border-line bg-surface p-1 shadow-lg lg:top-auto lg:bottom-12"
              >
                {[DEFAULT_LAYER, ...externalLayers.map((l) => l.id)].map((id) => (
                  <button
                    key={id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={activeLayer === id}
                    onClick={() => {
                      setActiveLayer(id);
                      setLayerMenuOpen(false);
                    }}
                    className={`block w-full rounded-md px-3 py-2 text-left text-body-sm ${
                      activeLayer === id
                        ? 'bg-brand-subtle font-semibold text-ink'
                        : 'text-ink-soft hover:bg-surface-2'
                    }`}
                  >
                    {t(`layer_${id}`)}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ═══ DESKTOP: left rail + list panel + right detail ═══ */}
      <div className="pointer-events-none absolute inset-0 z-20 hidden lg:flex">
        {/* The add-facility FAB lives on the map itself here (bottom-left of
            the visible map, below), so the rail's copy is off. */}
        <NavRail active="/" labelFor={(k) => tNav(k)} className="pointer-events-auto" showAdd={false} />

        <aside
          id="facility-list"
          className="pointer-events-auto flex w-[384px] shrink-0 flex-col border-r border-line bg-paper"
        >
          <div className="border-b border-line bg-surface px-4 py-3">
            <h2 className="text-h4 font-bold text-ink">{t('discoverTitle')}</h2>
            <div className="mt-3 flex items-center gap-2">
              <Input
                iconLeft={<Search size={18} />}
                placeholder={t('searchPlaceholder')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label={t('searchPlaceholder')}
              />
              <Button
                variant="secondary"
                iconLeft={<SlidersHorizontal size={18} />}
                onClick={() => setFilterOpen(true)}
                className="shrink-0"
              >
                {activeCount > 0 ? String(activeCount) : t('filters')}
              </Button>
            </div>
            <div className="mt-3">{chipRow}</div>
            <div className="mt-3 flex items-center justify-between">
              {countLine}
              <Button variant="ghost" size="sm" onClick={() => applyFilters({ ...filters })}>
                {t('sort')}
              </Button>
            </div>
          </div>
          {resultsBody}
        </aside>

        {/* The visible map region (right of the list). The add-facility FAB
            anchors to ITS bottom-left, so it sits on the map, not under the
            panel — operator request 2026-07-25. Mobile keeps the BottomNav
            center FAB. */}
        <div className="relative min-w-0 flex-1">
          <Link
            href="/dobavi"
            aria-label={tNav('navAdd')}
            className="pointer-events-auto absolute bottom-6 left-6 grid size-[54px] place-items-center rounded-full border-[3px] border-surface bg-accent text-on-accent shadow-lg transition-transform hover:scale-105 active:scale-[0.97]"
          >
            <Plus size={26} />
          </Link>
        </div>

        {selected && (
          <aside className="pointer-events-auto absolute right-4 top-4 w-[380px] rounded-sheet border border-line bg-surface shadow-float">
            {detailPanel}
          </aside>
        )}
      </div>

      {/* ═══ MOBILE: bottom sheet + tab bar + FAB ═══ */}
      <div className="lg:hidden">
        {selected ? (
          <div
            className="absolute inset-x-0 bottom-14 z-30 flex h-[calc(100dvh-3.5rem)] flex-col rounded-t-[20px] border-t border-line-strong bg-surface shadow-float"
            role="dialog"
            aria-label={selected.name ?? tFacility('unnamed')}
          >
            {detailPanel}
          </div>
        ) : (
          <section
            id="facility-list"
            className={`absolute inset-x-0 bottom-14 z-30 flex flex-col rounded-t-[20px] border-t border-line-strong bg-surface shadow-float transition-[height] duration-200 ease-standard ${SNAP_H[snap]}`}
          >
            <button
              type="button"
              aria-label={t('resize')}
              onClick={() => setSnap((s) => SNAP_ORDER[(SNAP_ORDER.indexOf(s) + 1) % 3] ?? 'half')}
              className="flex justify-center pt-2.5 pb-1.5"
            >
              <span className="h-1 w-10 rounded-full bg-line-strong" />
            </button>
            <div className="flex items-center justify-between px-4 pb-2">
              {countLine}
              <button
                type="button"
                onClick={() => setFilterOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-pill bg-paper-sunk px-3 py-1.5 text-caption font-medium text-ink-soft"
              >
                <SlidersHorizontal size={15} />
                {t('filters')}
                {activeCount > 0 && (
                  <Badge tone="brand" variant="solid" className="ml-0.5">
                    {activeCount}
                  </Badge>
                )}
              </button>
            </div>
            <div className="px-4 pb-3">
              <Input
                iconLeft={<Search size={18} />}
                placeholder={t('searchPlaceholder')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label={t('searchPlaceholder')}
              />
            </div>
            <div className="px-4 pb-3">{chipRow}</div>
            {resultsBody}
          </section>
        )}

        <BottomNav active="/" labelFor={(k) => tNav(k)} className="absolute inset-x-0 bottom-0 z-40" />
      </div>

      {/* ── Filter sheet (shared) ── */}
      {filterOpen && (
        <FilterSheet
          filters={filters}
          nearMeOn={nearMeOn}
          radiusKm={radiusKm}
          count={points.length}
          onApply={applyFilters}
          onToggleNearMe={toggleNearMe}
          onRadius={setRadiusKm}
          onClose={() => setFilterOpen(false)}
          onReset={() => {
            setNearMeOn(false);
            applyFilters({ sports: [], access: ['free'], onlyLit: false, surfaces: [] });
          }}
        />
      )}

      {locateError && (
        <div
          role="alert"
          className="absolute inset-x-4 bottom-20 z-40 rounded-md bg-danger-bg px-3 py-2 text-caption text-danger lg:inset-x-auto lg:left-24 lg:bottom-6"
        >
          {t('locateError')}
        </div>
      )}
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────

function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      <span className="grid size-12 place-items-center rounded-full bg-paper-sunk text-text-muted">
        {icon}
      </span>
      <div>
        <p className="text-body-sm font-bold text-ink">{title}</p>
        <p className="mx-auto mt-1 max-w-xs text-caption text-text-muted">{body}</p>
      </div>
      {action}
    </div>
  );
}

// ── Facility preview (map selection) ──────────────────────────────────────

function FacilityPreview({
  point,
  onClose,
  labels,
  sportLabels,
}: {
  point: MapPoint;
  onClose: () => void;
  labels: { unnamed: string; directions: string; viewDetails: string; close: string };
  sportLabels: (s: string[]) => string;
}) {
  const v = primaryVisual(point.sports);
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-t-[20px] lg:rounded-sheet">
      <div
        className="relative flex h-36 items-center justify-center"
        style={{
          background: `radial-gradient(circle at 50% 42%, color-mix(in srgb, ${v.color} 18%, var(--surface)), var(--surface) 72%)`,
          color: v.color,
        }}
      >
        <v.Icon size={64} className="opacity-25" />
        <div className="absolute left-3 top-3 flex gap-2">
          <IconButton aria-label={labels.close} variant="floating" round onClick={onClose}>
            <ArrowLeft size={19} />
          </IconButton>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
        <h2 className="text-h3 font-extrabold tracking-tight text-ink">
          {point.name ?? labels.unnamed}
        </h2>
        {point.sports.length > 0 && (
          <p className="mt-1 text-body-sm text-text-muted">{sportLabels(point.sports)}</p>
        )}
      </div>
      <div className="flex items-center gap-2.5 border-t border-line p-3">
        <Button
          block
          iconLeft={<Navigation size={19} />}
          onClick={() => {
            window.open(
              `https://www.openstreetmap.org/directions?to=${String(point.lat)},${String(point.lon)}`,
              '_blank',
              'noopener',
            );
          }}
        >
          {labels.directions}
        </Button>
        <Button variant="secondary" asChild className="shrink-0">
          <Link href={`/obekt/${point.slug}`}>{labels.viewDetails}</Link>
        </Button>
      </div>
    </div>
  );
}

// ── Filter sheet ──────────────────────────────────────────────────────────

function FilterSheet({
  filters,
  nearMeOn,
  radiusKm,
  count,
  onApply,
  onToggleNearMe,
  onRadius,
  onClose,
  onReset,
}: {
  filters: PublicFilters;
  nearMeOn: boolean;
  radiusKm: number;
  count: number;
  onApply: (f: PublicFilters) => void;
  onToggleNearMe: () => void;
  onRadius: (km: number) => void;
  onClose: () => void;
  onReset: () => void;
}) {
  const t = useTranslations('Map');
  const tSport = useTranslations('Sport');
  const tSurface = useTranslations('Surface');
  const tAccess = useTranslations('Access');

  return (
    <div className="absolute inset-0 z-50 flex items-end justify-center lg:items-center">
      <button
        type="button"
        aria-label={t('close')}
        onClick={onClose}
        className="absolute inset-0 bg-overlay-scrim"
      />
      <div className="relative flex max-h-[86dvh] w-full flex-col rounded-t-[20px] bg-surface shadow-float lg:max-w-md lg:rounded-sheet">
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <h2 className="text-h3 font-extrabold tracking-tight text-ink">{t('filters')}</h2>
          <IconButton aria-label={t('close')} variant="surface" round onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5">
          <FilterGroup label={t('sport')}>
            <div className="flex flex-wrap gap-2">
              {CANONICAL_SPORTS.map((s) => {
                const v = SPORT_VISUALS[s];
                return (
                  <Chip
                    key={s}
                    color={v.color}
                    selected={filters.sports.includes(s)}
                    icon={<v.Icon size={15} />}
                    onClick={() => onApply({ ...filters, sports: toggle(filters.sports, s) })}
                  >
                    {tSport(s)}
                  </Chip>
                );
              })}
            </div>
          </FilterGroup>

          <FilterGroup label={t('nearby')}>
            <div className="flex items-center gap-3">
              <Chip color="var(--accent)" selected={nearMeOn} icon={<MapPin size={15} />} onClick={onToggleNearMe}>
                {t('nearMe')}
              </Chip>
              <span className="font-mono text-caption text-ink-soft">
                {t('radiusKm', { km: radiusKm })}
              </span>
              <input
                type="range"
                min={3}
                max={30}
                step={1}
                value={radiusKm}
                onChange={(e) => onRadius(Number(e.target.value))}
                aria-label={t('nearby')}
                className="flex-1 accent-[var(--accent)]"
              />
            </div>
          </FilterGroup>

          <FilterGroup label={t('access')}>
            <div className="flex flex-wrap gap-2">
              {ACCESS_OPTIONS.map((a) => (
                <Chip
                  key={a}
                  selected={filters.access.includes(a)}
                  onClick={() => {
                    const next = toggle(filters.access, a);
                    onApply({ ...filters, access: next.length ? next : ['free'] });
                  }}
                >
                  {tAccess(a)}
                </Chip>
              ))}
            </div>
          </FilterGroup>

          <FilterGroup label={t('lighting')}>
            <Switch
              checked={filters.onlyLit}
              onChange={() => onApply({ ...filters, onlyLit: !filters.onlyLit })}
              label={t('onlyLit')}
            />
          </FilterGroup>

          <FilterGroup label={t('surface')}>
            <div className="flex flex-wrap gap-2">
              {CANONICAL_SURFACES.map((s) => (
                <Chip
                  key={s}
                  selected={filters.surfaces.includes(s)}
                  onClick={() => onApply({ ...filters, surfaces: toggle(filters.surfaces, s) })}
                >
                  {tSurface(s)}
                </Chip>
              ))}
            </div>
          </FilterGroup>
        </div>

        <div className="flex items-center gap-2.5 border-t border-line px-5 py-3">
          <Button block onClick={onClose}>
            {t('showCount', { count })}
          </Button>
          <Button variant="secondary" onClick={onReset} className="shrink-0">
            {t('reset')}
          </Button>
        </div>
      </div>
    </div>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-line py-4 last:border-0">
      <p className="mb-2.5 font-mono text-overline uppercase tracking-overline text-text-muted">
        {label}
      </p>
      {children}
    </div>
  );
}
