'use client';

// The SUBPATH, never the barrel: this is a client component, and the barrel
// re-exports the mailer, which drags nodemailer and node:fs into the browser
// bundle (tests/client-imports.test.ts fails the build on it).
import { BULGARIA_BOUNDS } from '@sportkarta/lib/geo';
import type { Feature, FeatureCollection, Point, Polygon } from 'geojson';
import maplibregl, { type GeoJSONSource } from 'maplibre-gl';
import { useEffect, useRef } from 'react';

import { DEFAULT_LAYER, type ExternalMapLayer } from '@/lib/map/layers';
import { ensurePmtilesProtocol } from '@/lib/map/pmtiles';
import { buildMapStyle, externalLayerIds, mapAssetUrls } from '@/lib/map/style';

import { createCluster, createPin } from './markers';

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

/** The viewport's geographic extent — what "currently on screen" means. */
export interface MapBounds {
  west: number;
  south: number;
  east: number;
  north: number;
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
  /** External raster basemaps to offer (lib/map/layers.ts). Style-time only. */
  externalLayers?: ExternalMapLayer[];
  /** Which basemap is showing: DEFAULT_LAYER or an external layer id. */
  activeLayer?: string;
  /** Fires on load and after every gesture with the visible extent. */
  onBoundsChange?: (bounds: MapBounds) => void;
  /**
   * How much of the canvas is covered by UI, in CSS pixels.
   *
   * THE CANVAS IS FULL-BLEED (`absolute inset-0`) and the list panel sits ON TOP
   * of it — 76px of nav rail plus a 384px opaque aside on desktop, a 52dvh sheet
   * on mobile. Without telling MapLibre that, every camera operation aims at the
   * centre of the WHOLE viewport, which is a point the member cannot see: the
   * zoom floor fits Bulgaria into the full width and hides a third of it behind
   * the panel, `flyTo` on geolocate drops the member under the list, and the
   * pan clamp is computed against a rectangle that is 36% invisible.
   *
   * `map.setPadding` is the supported way to say "the viewport is this, but the
   * VISIBLE part is that", and every built-in camera method then respects it.
   */
  padding?: { top?: number; right?: number; bottom?: number; left?: number };
  /**
   * Lift the national zoom-out frame (operator request 2026-08-07, for mobile).
   *
   * WHAT WAS WRONG. On a phone the country could not be pulled back into view.
   * Two things caused it and only one was obvious. The zoom floor is "fit
   * Bulgaria into the part of the canvas you can SEE", and the sheet plus the
   * tab bar leave a ~390x420 strip, so the floor sat near z6.4 against a default
   * view of z6.8. But the binding constraint was `maxBounds`: MapLibre refuses
   * any zoom whose viewport would show area outside the box, so even requesting
   * z5.4 in the URL rendered identically to z6.8. Lifting the floor alone
   * changes nothing — verified.
   *
   * WHY IT CANNOT BE FIXED WITHOUT SHOWING EMPTY MARGINS. Bulgaria is landscape
   * (about 6.3° by 3°) and a phone is portrait. Fitting the country's WIDTH into
   * 390px needs roughly z5.4, at which an 844px-tall viewport spans about 12° of
   * latitude — four times the country's height. Seeing the whole country side to
   * side therefore REQUIRES showing a lot of non-Bulgaria above and below it,
   * and the basemap is a Bulgaria-only pmtiles archive bounded at lon 22–29,
   * lat 41–44.5. So those margins are the style's background colour, not map.
   * That is a property of the shape of the country and the shape of the device,
   * not something a camera setting can avoid.
   *
   * WHAT THIS DOES. On mobile the pan box is dropped and the floor becomes the
   * width-fit of the national bounds — far enough to see the whole country at
   * once, and no further. It deliberately does NOT go to z0: the archive would
   * render as a speck on a blank page, which reads as a broken map rather than
   * as freedom. Desktop keeps the frame, where the panel sits beside the map and
   * the floor already fits the country comfortably.
   */
  unrestricted?: boolean;
}

const SOURCE_ID = 'facilities';
const NEARME_ID = 'nearme';

/**
 * Bulgaria, from the ONE place it is defined (`@sportkarta/lib/geo`), which in
 * turn matches the `facilities_geom_in_bulgaria` CHECK the database enforces.
 * This used to be a local literal — one of five identical copies that agreed
 * only by coincidence.
 *
 * It does two jobs here, and they are different: it is the furthest permitted
 * ZOOM-OUT (the camera that fits this box), and it is the PAN limit
 * (`maxBounds`). Without the second, a member at the zoom floor could still drag
 * the country off screen and sit looking at Greece.
 */
const BG_BOUNDS: maplibregl.LngLatBoundsLike = BULGARIA_BOUNDS as unknown as maplibregl.LngLatBoundsLike;

function toFeatureCollection(points: MapPoint[]): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: points.map((p) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      // Only what syncMarkers reads. The POPS pin is state-coloured, not
      // family-coloured, so sports stays on MapPoint (the list uses it) but no
      // longer rides in the feature. If a property must return, keep it scalar:
      // queryRenderedFeatures does not round-trip array values reliably.
      properties: { slug: p.slug, name: p.name },
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
  externalLayers = [],
  activeLayer = DEFAULT_LAYER,
  onBoundsChange = () => undefined,
  padding = {},
  unrestricted = false,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef(new Map<string, maplibregl.Marker>());
  const userMarkerRef = useRef<maplibregl.Marker | null>(null);
  const loadedRef = useRef(false);
  const rafRef = useRef(0);
  /** Set by the init effect so a padding change can re-run it without re-init. */
  const paddingApplyRef = useRef<(() => void) | null>(null);

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
  const externalLayersRef = useRef(externalLayers);
  externalLayersRef.current = externalLayers;
  const activeLayerRef = useRef(activeLayer);
  activeLayerRef.current = activeLayer;
  const onBoundsChangeRef = useRef(onBoundsChange);
  onBoundsChangeRef.current = onBoundsChange;
  const paddingRef = useRef(padding);
  paddingRef.current = padding;
  const unrestrictedRef = useRef(unrestricted);
  unrestrictedRef.current = unrestricted;

  function reportBounds() {
    const map = mapRef.current;
    if (!map) return;
    const b = map.getBounds();
    onBoundsChangeRef.current({
      west: b.getWest(),
      south: b.getSouth(),
      east: b.getEast(),
      north: b.getNorth(),
    });
  }

  // Show the chosen external raster, hide the rest. The rasters sit above
  // every vector layer in the style, so a visible one fully covers the
  // self-hosted basemap; DEFAULT_LAYER hides them all. Tiles are only
  // requested while a layer is visible — the third-party request happens on
  // the visitor's explicit choice, never by default.
  function applyLayerVisibility() {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    for (const ext of externalLayersRef.current) {
      const { layer } = externalLayerIds(ext.id);
      if (!map.getLayer(layer)) continue;
      map.setLayoutProperty(
        layer,
        'visibility',
        ext.id === activeLayerRef.current ? 'visible' : 'none',
      );
    }
  }

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
        el = createPin({
          slug,
          name: (props.name as string | null) ?? unnamedRef.current,
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
        style: buildMapStyle({
          ...mapAssetUrls(window.location.origin),
          externalLayers: externalLayersRef.current,
        }),
        center: [initialView.lng, initialView.lat],
        zoom: initialView.zoom,
        // THE PAN LIMIT. This platform is a national map of Bulgarian public
        // facilities: there is nothing to see outside the country, the basemap
        // tiles stop at the border, and panning into Greece shows an empty grey
        // field that reads as a broken map rather than as "no data here".
        //
        // maxBounds constrains the VIEWPORT rather than the centre, so at the
        // zoom floor — where the viewport is already larger than the box — the
        // map simply cannot be dragged at all, which is the behaviour asked
        // for. Zoomed in, panning stays free inside the box.
        maxBounds: BG_BOUNDS,
        attributionControl: { compact: true },
      });
    } catch (error) {
      // WebGL unavailable (headless CI, low-end device): the list + filters keep
      // working without a basemap.
      console.error('MapLibre init failed; continuing without the basemap', error);
      return;
    }
    mapRef.current = map;

    /**
     * The padding, clamped so it can never swallow the viewport.
     *
     * At the mobile sheet's `full` snap the panel is nearly the whole screen,
     * and handing MapLibre a padding taller than the canvas makes every camera
     * calculation degenerate — `cameraForBounds` returns nonsense and the map
     * can end up unable to move at all. 55% per axis leaves a real rectangle in
     * every state; at `full` the member is reading the list rather than the
     * map, so the cap costs nothing.
     */
    const framePadding = () => {
      const { clientWidth: w, clientHeight: h } = map.getCanvas();
      const capX = Math.max(0, w * 0.55);
      const capY = Math.max(0, h * 0.55);
      const p = paddingRef.current;
      return {
        top: Math.min(p.top ?? 0, capY),
        bottom: Math.min(p.bottom ?? 0, capY),
        left: Math.min(p.left ?? 0, capX),
        right: Math.min(p.right ?? 0, capX),
      };
    };

    // Zoom-out floor: the platform is national, so the furthest view is "all
    // of Bulgaria on screen". A fixed number can't do that — a phone needs a
    // lower zoom than a desktop to fit the same bbox — so the floor is the
    // fit-Bulgaria camera for THIS viewport, refreshed on every resize. The
    // small epsilon keeps the floor itself showing the whole territory with
    // room to spare rather than clipping an edge.
    //
    // The frame padding is added to the 16px breathing room, so the floor fits
    // Bulgaria into the part of the canvas the member can actually SEE. Fitting
    // it into the full canvas is what put a third of the country behind the
    // list panel.
    const applyPadding = () => {
      const p = framePadding();
      map.setPadding(p);

      if (unrestrictedRef.current) {
        // The pan box has to go, and it is the reason not the extra: while it is
        // set, MapLibre clamps the zoom so the viewport never exceeds it, which
        // silently re-imposes the floor this flag exists to lift.
        map.setMaxBounds(null);
        // The floor is the WIDTH-fit of the country: measured against the canvas
        // width alone, ignoring both the sheet and the height, because the
        // height is what cannot be satisfied on a portrait screen. `zoom - 0.1`
        // keeps a hair of margin at the limit, as the framed branch does.
        const { clientWidth } = map.getCanvas();
        // [[minLon, minLat], [maxLon, maxLat]] — nested pairs, not a flat tuple.
        const span = BULGARIA_BOUNDS[1][0] - BULGARIA_BOUNDS[0][0];
        // Web-mercator zoom for a longitude span across a pixel width: at zoom z
        // the world is 512 * 2^z px wide and spans 360°.
        const widthFit = Math.log2(((clientWidth - 32) * 360) / (512 * span));
        // Clamp to maxZoom as well: setMinZoom THROWS above it, and on a small
        // canvas the fit math can legitimately land there.
        map.setMinZoom(Math.min(Math.max(0, widthFit - 0.1), map.getMaxZoom()));
        return;
      }

      map.setMaxBounds(BG_BOUNDS);
      const cam = map.cameraForBounds(BG_BOUNDS, {
        padding: { top: p.top + 16, bottom: p.bottom + 16, left: p.left + 16, right: p.right + 16 },
      });
      // On a phone-sized canvas the padding can exceed the viewport and
      // cameraForBounds then reports a zoom past maxZoom — setMinZoom throws
      // ("minZoom must be between -2 and the current maxZoom") instead of
      // clamping, so clamp here.
      if (cam?.zoom !== undefined) {
        map.setMinZoom(Math.min(Math.max(0, cam.zoom - 0.1), map.getMaxZoom()));
      }
    };
    applyPadding();
    paddingApplyRef.current = applyPadding;
    map.on('resize', applyPadding);

    map.on('load', () => {
      const accent = token('--accent');

      map.addSource(SOURCE_ID, {
        type: 'geojson',
        data: toFeatureCollection(pointsRef.current),
        cluster: true,
        clusterRadius: 55,
        clusterMaxZoom: 14,
      });
      // Invisible hit/query layers — the visible markers are HTML (createPin
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
      applyLayerVisibility();
      reportBounds();
      syncMarkers();
    });

    map.on('moveend', () => {
      const c = map.getCenter();
      onMoveEndRef.current({ lng: c.lng, lat: c.lat, zoom: map.getZoom() });
      reportBounds();
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

  /**
   * Re-apply the frame when the covered area changes — the member collapsing
   * the desktop list, or cycling the mobile sheet's snap.
   *
   * The zoom FLOOR moves with it, and that is the point: with the list open,
   * "all of Bulgaria on screen" needs a lower zoom than with it closed, so a
   * fixed floor would either clip the country or leave dead space. Keyed on the
   * four numbers rather than the object, since the parent rebuilds the literal
   * on every render.
   */
  useEffect(() => {
    paddingApplyRef.current?.();
  }, [padding.top, padding.right, padding.bottom, padding.left, unrestricted]);

  useEffect(() => {
    applyLayerVisibility();
    // Ref-based helper; re-run only when the choice changes.
     
  }, [activeLayer]);

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
