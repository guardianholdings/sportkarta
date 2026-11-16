import type {
  LayerSpecification,
  StyleSpecification,
  VectorSourceSpecification,
} from 'maplibre-gl';

import type { ExternalMapLayer } from './layers';
import { UNDERLAY_LAYER_MAXZOOM, UNDERLAY_PATH } from './underlay';

// A clean, light MapLibre basemap over our self-hosted Protomaps `.pmtiles`
// (docs/ROADMAP.md Stage 2). Layer names follow the Protomaps basemap flat
// schema; if a build lacks a layer it simply doesn't render — the map still
// works. Labels prefer Bulgarian (`name:bg`), falling back to the default name.
//
// Attribution is mandatory on every map view (CLAUDE.md): the source carries
// "© OpenStreetMap + Protomaps", surfaced by MapLibre's AttributionControl.

export const ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> · <a href="https://protomaps.com" target="_blank" rel="noreferrer">Protomaps</a>';

// Prefer the Bulgarian name, then the local/default name, then English.
const LABEL_FIELD: unknown = ['coalesce', ['get', 'name:bg'], ['get', 'name'], ['get', 'name:en']];

const PARK_KINDS = [
  'park',
  'garden',
  'recreation_ground',
  'pitch',
  'playground',
  'grass',
  'meadow',
  'forest',
  'wood',
  'nature_reserve',
  'golf_course',
];

export interface MapStyleOptions {
  /** pmtiles archive URL, e.g. https://host/tiles/bulgaria.pmtiles */
  tilesUrl: string;
  /** Glyph (font PBF) endpoint template with {fontstack}/{range}. */
  glyphsUrl: string;
  /**
   * Optional regional underlay archive (lib/map/underlay.ts): the countries
   * around Bulgaria at low zoom, drawn UNDER the national basemap with the
   * same layers and paint. Wherever the national tiles exist, their opaque
   * earth and water cover it, so the seam does not show; beyond their edges it
   * is the map there instead of the flat background. Only the main map's
   * desktop layout uses it (`underlayStyle` adds it later if the layout
   * becomes desktop after the map has started).
   */
  underlayUrl?: string;
  /**
   * Optional external raster basemaps (lib/map/layers.ts). Each becomes a
   * raster source + a hidden raster layer placed AFTER every vector layer, so
   * making one visible fully covers the self-hosted basemap — no vector
   * toggling, and the facility hit-layers (added after style load) still land
   * on top. Tiles are only fetched while a layer is visible, so an unused
   * entry costs nothing and no third-party request happens by default.
   */
  externalLayers?: ExternalMapLayer[];
}

/** Style ids for an external layer, shared by the canvas visibility effect. */
export function externalLayerIds(id: string): { source: string; layer: string } {
  return { source: `ext-${id}`, layer: `ext-${id}-raster` };
}

/** The underlay's source id; its layers are the basemap's, prefixed `underlay-`. */
export const UNDERLAY_SOURCE = 'underlay';

/** The underlay's layer ids, for showing and hiding it by layout. */
export const UNDERLAY_LAYER_IDS: readonly string[] = basemapLayers(
  UNDERLAY_SOURCE,
  `${UNDERLAY_SOURCE}-`,
).map((layer) => layer.id);

/**
 * The national basemap's first layer: the underlay's layers go below it, so
 * that every national layer — and everything added later — draws on top.
 */
export const NATIONAL_FIRST_LAYER = 'earth';

/** The underlay's source and layers, for a style or for `map.addSource`/`addLayer`. */
export function underlayStyle(url: string): {
  source: VectorSourceSpecification;
  layers: LayerSpecification[];
} {
  return {
    // The same attribution string as the national source: MapLibre shows
    // identical strings once, so the credit line does not change.
    source: { type: 'vector', url: `pmtiles://${url}`, attribution: ATTRIBUTION },
    // The same layers and paint; drawn only up to UNDERLAY_LAYER_MAXZOOM.
    layers: basemapLayers(UNDERLAY_SOURCE, `${UNDERLAY_SOURCE}-`).map((layer) => ({
      ...layer,
      maxzoom: UNDERLAY_LAYER_MAXZOOM,
    })),
  };
}

export function buildMapStyle({
  tilesUrl,
  glyphsUrl,
  underlayUrl,
  externalLayers = [],
}: MapStyleOptions): StyleSpecification {
  const style = baseStyle(tilesUrl, glyphsUrl, underlayUrl);
  for (const ext of externalLayers) {
    const ids = externalLayerIds(ext.id);
    style.sources[ids.source] = {
      type: 'raster',
      tiles: ext.tiles,
      tileSize: 256,
      maxzoom: ext.maxzoom,
      attribution: ext.attribution,
    };
    style.layers.push({
      id: ids.layer,
      type: 'raster',
      source: ids.source,
      layout: { visibility: 'none' },
    });
  }
  return style;
}

function baseStyle(tilesUrl: string, glyphsUrl: string, underlayUrl?: string): StyleSpecification {
  const sources: StyleSpecification['sources'] = {
    protomaps: {
      type: 'vector',
      // The `pmtiles://` prefix is handled by the pmtiles Protocol we
      // register on the MapLibre instance before creating the map.
      url: `pmtiles://${tilesUrl}`,
      attribution: ATTRIBUTION,
    },
  };
  const layers: LayerSpecification[] = [
    { id: 'background', type: 'background', paint: { 'background-color': '#f6f5f2' } },
  ];
  if (underlayUrl) {
    const underlay = underlayStyle(underlayUrl);
    sources[UNDERLAY_SOURCE] = underlay.source;
    layers.push(...underlay.layers);
  }
  layers.push(...basemapLayers('protomaps', ''));
  return { version: 8, glyphs: glyphsUrl, sources, layers };
}

/**
 * The basemap's layers over one vector source. The national archive and the
 * regional underlay are drawn by the same list, ids prefixed for the
 * underlay, so the two can never drift apart in paint.
 */
function basemapLayers(source: string, prefix: string): LayerSpecification[] {
  return [
    {
      id: `${prefix}earth`,
      type: 'fill',
      source,
      'source-layer': 'earth',
      paint: { 'fill-color': '#eceae4' },
    },
    {
      id: `${prefix}landcover`,
      type: 'fill',
      source,
      'source-layer': 'landcover',
      paint: { 'fill-color': '#e2e9da', 'fill-opacity': 0.7 },
    },
    {
      id: `${prefix}parks`,
      type: 'fill',
      source,
      'source-layer': 'landuse',
      filter: ['in', ['get', 'kind'], ['literal', PARK_KINDS]],
      paint: { 'fill-color': '#d6e8cc' },
    },
    // The Protomaps `water` source-layer mixes POLYGONS (lakes, riverbanks,
    // pools) with LINESTRINGS (river/stream/canal centerlines, in tiles from
    // each feature's min_zoom). A fill layer given a LineString implicitly
    // closes it into a ring and fills it — every mountain stream became a
    // large false blue blob the moment its centerline entered the tiles
    // (z14+). Polygons fill; lines get the dedicated layer below.
    {
      id: `${prefix}water`,
      type: 'fill',
      source,
      'source-layer': 'water',
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': '#a9d1e0' },
    },
    {
      id: `${prefix}water-lines`,
      type: 'line',
      source,
      'source-layer': 'water',
      filter: ['==', ['geometry-type'], 'LineString'],
      minzoom: 9,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#8ec4d8',
        // Rivers read as rivers, streams stay hairlines; both grow with zoom.
        'line-width': [
          'interpolate',
          ['linear'],
          ['zoom'],
          9,
          ['match', ['get', 'kind'], 'river', 1.2, 0.5],
          14,
          ['match', ['get', 'kind'], 'river', 2.4, 1],
          17,
          ['match', ['get', 'kind'], 'river', 5, 2],
        ],
      },
    },
    {
      id: `${prefix}roads-casing`,
      type: 'line',
      source,
      'source-layer': 'roads',
      // Paths are drawn by the dedicated `trails` layer below, not as roads.
      filter: ['!=', ['get', 'kind'], 'path'],
      minzoom: 8,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#e3e0d8',
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1, 16, 8],
      },
    },
    {
      id: `${prefix}roads`,
      type: 'line',
      source,
      'source-layer': 'roads',
      filter: ['!=', ['get', 'kind'], 'path'],
      minzoom: 8,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#ffffff',
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 16, 5],
      },
    },
    // Trails: the mountain and park paths of OpenStreetMap, rendered verbatim
    // from the basemap tiles (no import). Restricted to highway=path and
    // highway=track — the tags nature trails use — and deliberately NOT
    // footway/sidewalk/crossing/steps, which are the city's pedestrian
    // network. Empirically that keeps Vitosha and the parks dense while
    // clearing urban streets, since green areas are path/track and cities are
    // footway/sidewalk. A dashed warm line, from z11, below the facility
    // clusters (added later) so the spots always sit on top.
    {
      id: `${prefix}trails`,
      type: 'line',
      source,
      'source-layer': 'roads',
      filter: ['in', ['get', 'kind_detail'], ['literal', ['path', 'track']]],
      minzoom: 11,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#9a5b26',
        'line-dasharray': [1.5, 1.5],
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.8, 14, 1.6, 17, 3],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0.55, 13, 0.9],
      },
    },
    {
      id: `${prefix}buildings`,
      type: 'fill',
      source,
      'source-layer': 'buildings',
      minzoom: 14,
      paint: { 'fill-color': '#e6e2d8', 'fill-opacity': 0.6 },
    },
    {
      id: `${prefix}boundaries`,
      type: 'line',
      source,
      'source-layer': 'boundaries',
      paint: {
        'line-color': '#9a97a0',
        'line-dasharray': [2, 2],
        'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.5, 10, 1.5],
      },
    },
    {
      id: `${prefix}places`,
      type: 'symbol',
      source,
      'source-layer': 'places',
      layout: {
        'text-field': LABEL_FIELD as [string, ...unknown[]],
        'text-font': ['Noto Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 6, 11, 12, 15],
        'text-max-width': 7,
      },
      paint: {
        'text-color': '#3a3a3a',
        'text-halo-color': '#f6f5f2',
        'text-halo-width': 1.4,
      },
    },
    // Street names along the road line — the layer the map was missing.
    // Named roads only, paths excluded (those get trail-labels below). From
    // z13 so a city does not fill with labels at a glance. Renders with the
    // self-hosted Noto Sans glyphs (public/fonts); without them MapLibre
    // cannot draw a line label at all, which is why streets were blank.
    {
      id: `${prefix}road-labels`,
      type: 'symbol',
      source,
      'source-layer': 'roads',
      filter: ['all', ['has', 'name'], ['!=', ['get', 'kind'], 'path']],
      minzoom: 13,
      layout: {
        'symbol-placement': 'line',
        'text-field': LABEL_FIELD as [string, ...unknown[]],
        'text-font': ['Noto Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 16, 12.5],
        'text-max-angle': 40,
        'symbol-spacing': 260,
      },
      paint: {
        'text-color': '#5a5a5a',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.6,
      },
    },
    // Trail names along the line (e.g. "Драгалевци – х. Алеко – Черни връх").
    // After `places`, so a city label wins the collision over a trail label.
    {
      id: `${prefix}trail-labels`,
      type: 'symbol',
      source,
      'source-layer': 'roads',
      filter: ['all', ['==', ['get', 'kind'], 'path'], ['has', 'name']],
      minzoom: 13,
      layout: {
        'symbol-placement': 'line',
        'text-field': LABEL_FIELD as [string, ...unknown[]],
        'text-font': ['Noto Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 16, 12],
        'text-max-angle': 40,
        'symbol-spacing': 350,
      },
      paint: {
        'text-color': '#7a4413',
        'text-halo-color': '#f6f5f2',
        'text-halo-width': 1.4,
      },
    },
  ] as LayerSpecification[];
}

/** The regional underlay's URL, same-origin like the national archive. */
export function underlayUrl(origin: string): string {
  return `${origin}${UNDERLAY_PATH}`;
}

/** Build the tile + glyph URLs from the browser origin (same-origin serving). */
export function mapAssetUrls(origin: string): MapStyleOptions {
  return {
    tilesUrl: `${origin}/tiles/bulgaria.pmtiles`,
    glyphsUrl: `${origin}/fonts/{fontstack}/{range}.pbf`,
  };
}
