'use client';

import type { Feature, FeatureCollection, Point, Polygon } from 'geojson';
import maplibregl, { type GeoJSONSource } from 'maplibre-gl';
import { useEffect, useRef } from 'react';

import { ensurePmtilesProtocol } from '@/lib/map/pmtiles';
import { buildMapStyle, mapAssetUrls } from '@/lib/map/style';

import { createCluster, createTeardrop } from './markers';

import 'maplibre-gl/dist/maplibre-gl.css';

export interface MapPoint {
  slug: string;
  name: string | null;
  sports: string[];
  lon: number;
  lat: number;
}

export interface MapView {
  lng: number;
  lat: number;
  zoom: number;
}

export interface NearMe {
  center: { lon: number; lat: number };
  radiusKm: number;
}

interface MapCanvasProps {
  points: MapPoint[];
  userLocation: { lon: number; lat: number } | null;
  selectedSlug: string | null;
  initialView: MapView;
  myLocationLabel: string;
  onSelect: (slug: string) => void;
  onMoveEnd: (view: MapView) => void;
  /** Card the user is hovering — its marker grows + lifts (hover-sync). */
  hoveredSlug?: string | null;
  nearMe?: NearMe | null;
  unnamedLabel?: string;
  /** A marker was hovered (slug) or left (null) — the list highlights + scrolls. */
  onHoverMarker?: (slug: string | null) => void;
}

const SOURCE_ID = 'facilities';
const NEARME_ID = 'nearme';

function toFeatureCollection(points: MapPoint[]): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: points.map((p) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      // sports rides along so an unclustered point can be drawn in its family
      // colour + glyph; joined to a string because queryRenderedFeatures does not
      // round-trip array-valued properties reliably.
      properties: { slug: p.slug, name: p.name, sports: p.sports.join(',') },
    })),
  };
}

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** A geographic circle as a polygon (equirectangular; fine at city radii). */
function circlePolygon(center: { lon: number; lat: number }, radiusKm: number): Feature<Polygon> {
  const steps = 72;
  const latR = radiusKm / 110.574;
  const lonR = radiusKm / (111.32 * Math.cos((center.lat * Math.PI) / 180));
  const ring: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push([center.lon + lonR * Math.cos(a), center.lat + latR * Math.sin(a)]);
  }
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} };
}

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

export default function MapCanvas({
  points,
  userLocation,
  selectedSlug,
  hoveredSlug = null,
  nearMe = null,
  initialView,
  myLocationLabel,
  unnamedLabel = '',
  onSelect,
  onHoverMarker = () => undefined,
  onMoveEnd,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef(new Map<string, maplibregl.Marker>());
  const userMarkerRef = useRef<maplibregl.Marker | null>(null);
  const loadedRef = useRef(false);
  const rafRef = useRef(0);

  // Latest props for the map's long-lived handlers, without re-init.
  const pointsRef = useRef(points);
  pointsRef.current = points;
  const selectedRef = useRef(selectedSlug);
  selectedRef.current = selectedSlug;
  const hoveredRef = useRef(hoveredSlug);
  hoveredRef.current = hoveredSlug;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onHoverRef = useRef(onHoverMarker);
  onHoverRef.current = onHoverMarker;
  const onMoveEndRef = useRef(onMoveEnd);
  onMoveEndRef.current = onMoveEnd;
  const unnamedRef = useRef(unnamedLabel);
  unnamedRef.current = unnamedLabel;

  function applyStates() {
    for (const [id, marker] of markersRef.current) {
      if (!id.startsWith('pt_')) continue;
      const slug = id.slice(3);
      const el = marker.getElement();
      el.classList.toggle('is-selected', slug === selectedRef.current);
      el.classList.toggle('is-hover', slug === hoveredRef.current && slug !== selectedRef.current);
    }
  }

  // Reconcile HTML markers with the clustered features currently in view. Bounded
  // to the viewport by queryRenderedFeatures, so the count stays small even on
  // the national dataset.
  function syncMarkers() {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    const features = map.queryRenderedFeatures({ layers: ['facilities-clusters', 'facilities-points'] });
    const next = new Set<string>();

    for (const f of features) {
      if (f.geometry.type !== 'Point') continue;
      const coords = f.geometry.coordinates as [number, number];
      const props = f.properties ?? {};
      const isCluster = props.cluster === true || typeof props.point_count === 'number';
      const id = isCluster ? `cluster_${String(props.cluster_id)}` : `pt_${String(props.slug)}`;
      if (next.has(id)) continue;
      next.add(id);
      if (markersRef.current.has(id)) continue;

      let el: HTMLElement;
      if (isCluster) {
        const count = Number(props.point_count);
        el = createCluster(count);
        const clusterId = props.cluster_id as number;
        el.addEventListener('click', () => {
          const src = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
          src
            ?.getClusterExpansionZoom(clusterId)
            .then((zoom) => map.easeTo({ center: coords, zoom }))
            .catch(() => undefined);
        });
      } else {
        const slug = String(props.slug);
        const sports = typeof props.sports === 'string' && props.sports ? props.sports.split(',') : [];
        el = createTeardrop({
          slug,
          name: (props.name as string | null) ?? unnamedRef.current,
          sports,
        });
        el.addEventListener('click', () => onSelectRef.current(slug));
        el.addEventListener('mouseenter', () => onHoverRef.current(slug));
        el.addEventListener('mouseleave', () => onHoverRef.current(null));
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelectRef.current(slug);
          }
        });
      }
      const marker = new maplibregl.Marker({ element: el, anchor: isCluster ? 'center' : 'bottom' })
        .setLngLat(coords)
        .addTo(map);
      markersRef.current.set(id, marker);
    }

    // Prune stale markers ONLY once the source has settled. During a zoom/pan the
    // clustered source re-tiles in a worker, and queryRenderedFeatures then
    // briefly returns an incomplete (often empty) set; pruning against that would
    // remove every marker mid-gesture — the "facilities vanish when I zoom in"
    // symptom — and re-add them a frame later. Markers are geographically
    // anchored, so holding the stale ones for the frame or two the reload takes
    // keeps the map populated; the next settled sync (moveend / sourcedata / idle)
    // reconciles to the correct set.
    if (map.isSourceLoaded(SOURCE_ID)) {
      for (const [id, marker] of markersRef.current) {
        if (!next.has(id)) {
          marker.remove();
          markersRef.current.delete(id);
        }
      }
    }
    applyStates();
  }

  function scheduleSync() {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(syncMarkers);
  }

  useEffect(() => {
    if (!containerRef.current) return;
    ensurePmtilesProtocol();

    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: buildMapStyle(mapAssetUrls(window.location.origin)),
        center: [initialView.lng, initialView.lat],
        zoom: initialView.zoom,
        attributionControl: { compact: true },
      });
    } catch (error) {
      // WebGL unavailable (headless CI, low-end device): the list + filters keep
      // working without a basemap.
      console.error('MapLibre init failed; continuing without the basemap', error);
      return;
    }
    mapRef.current = map;

    map.on('load', () => {
      const accent = token('--accent');

      map.addSource(SOURCE_ID, {
        type: 'geojson',
        data: toFeatureCollection(pointsRef.current),
        cluster: true,
        clusterRadius: 55,
        clusterMaxZoom: 14,
      });
      // Invisible hit/query layers — the visible markers are HTML (createTeardrop
      // / createCluster), synced from these via queryRenderedFeatures.
      map.addLayer({
        id: 'facilities-clusters',
        type: 'circle',
        source: SOURCE_ID,
        filter: ['has', 'point_count'],
        paint: { 'circle-opacity': 0, 'circle-radius': 22 },
      });
      map.addLayer({
        id: 'facilities-points',
        type: 'circle',
        source: SOURCE_ID,
        filter: ['!', ['has', 'point_count']],
        paint: { 'circle-opacity': 0, 'circle-radius': 16 },
      });

      map.addSource(NEARME_ID, { type: 'geojson', data: EMPTY });
      map.addLayer({
        id: 'nearme-fill',
        type: 'fill',
        source: NEARME_ID,
        paint: { 'fill-color': accent, 'fill-opacity': 0.06 },
      });
      map.addLayer({
        id: 'nearme-line',
        type: 'line',
        source: NEARME_ID,
        paint: { 'line-color': accent, 'line-width': 2, 'line-dasharray': [2, 2], 'line-opacity': 0.9 },
      });

      loadedRef.current = true;
      syncMarkers();
    });

    map.on('moveend', () => {
      const c = map.getCenter();
      onMoveEndRef.current({ lng: c.lng, lat: c.lat, zoom: map.getZoom() });
      scheduleSync();
    });
    map.on('move', scheduleSync);
    // `idle` fires once the map has fully settled and every tile is loaded — the
    // moment isSourceLoaded is reliably true, so the pruning pass runs against a
    // complete feature set and the final markers are always correct.
    map.on('idle', scheduleSync);
    map.on('sourcedata', (e) => {
      if (e.sourceId === SOURCE_ID && e.isSourceLoaded) scheduleSync();
    });

    const markers = markersRef.current; // stable Map instance, for cleanup
    return () => {
      cancelAnimationFrame(rafRef.current);
      loadedRef.current = false;
      for (const m of markers.values()) m.remove();
      markers.clear();
      map.remove();
      mapRef.current = null;
    };
    // Init once; prop changes handled by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    (map.getSource(SOURCE_ID) as GeoJSONSource | undefined)?.setData(toFeatureCollection(points));
    scheduleSync();
    // scheduleSync is a stable ref-based helper; only re-run on new points.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points]);

  useEffect(() => {
    applyStates();
  }, [selectedSlug, hoveredSlug]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    const src = map.getSource(NEARME_ID) as GeoJSONSource | undefined;
    src?.setData(nearMe ? circlePolygon(nearMe.center, nearMe.radiusKm) : EMPTY);
  }, [nearMe]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!userLocation) {
      userMarkerRef.current?.remove();
      userMarkerRef.current = null;
      return;
    }
    const lngLat: [number, number] = [userLocation.lon, userLocation.lat];
    if (userMarkerRef.current) {
      userMarkerRef.current.setLngLat(lngLat);
    } else {
      const el = document.createElement('div');
      el.setAttribute('aria-label', myLocationLabel);
      const brand = token('--brand');
      el.style.cssText = `width:16px;height:16px;border-radius:50%;background:${brand};border:3px solid ${token('--surface')};box-shadow:0 0 0 4px color-mix(in srgb, ${brand} 28%, transparent)`;
      userMarkerRef.current = new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
    }
    map.flyTo({ center: lngLat, zoom: Math.max(map.getZoom(), 13), speed: 1.4 });
  }, [userLocation, myLocationLabel]);

  return <div ref={containerRef} className="h-full w-full" data-testid="map-canvas" />;
}
