import type { StyleSpecification } from 'maplibre-gl';

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
}

export function buildMapStyle({ tilesUrl, glyphsUrl }: MapStyleOptions): StyleSpecification {
  return {
    version: 8,
    glyphs: glyphsUrl,
    sources: {
      protomaps: {
        type: 'vector',
        // The `pmtiles://` prefix is handled by the pmtiles Protocol we
        // register on the MapLibre instance before creating the map.
        url: `pmtiles://${tilesUrl}`,
        attribution: ATTRIBUTION,
      },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#f6f5f2' } },
      {
        id: 'earth',
        type: 'fill',
        source: 'protomaps',
        'source-layer': 'earth',
        paint: { 'fill-color': '#eceae4' },
      },
      {
        id: 'landcover',
        type: 'fill',
        source: 'protomaps',
        'source-layer': 'landcover',
        paint: { 'fill-color': '#e2e9da', 'fill-opacity': 0.7 },
      },
      {
        id: 'parks',
        type: 'fill',
        source: 'protomaps',
        'source-layer': 'landuse',
        filter: ['in', ['get', 'kind'], ['literal', PARK_KINDS]],
        paint: { 'fill-color': '#d6e8cc' },
      },
      {
        id: 'water',
        type: 'fill',
        source: 'protomaps',
        'source-layer': 'water',
        paint: { 'fill-color': '#a9d1e0' },
      },
      {
        id: 'roads-casing',
        type: 'line',
        source: 'protomaps',
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
        id: 'roads',
        type: 'line',
        source: 'protomaps',
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
        id: 'trails',
        type: 'line',
        source: 'protomaps',
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
        id: 'buildings',
        type: 'fill',
        source: 'protomaps',
        'source-layer': 'buildings',
        minzoom: 14,
        paint: { 'fill-color': '#e6e2d8', 'fill-opacity': 0.6 },
      },
      {
        id: 'boundaries',
        type: 'line',
        source: 'protomaps',
        'source-layer': 'boundaries',
        paint: {
          'line-color': '#9a97a0',
          'line-dasharray': [2, 2],
          'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.5, 10, 1.5],
        },
      },
      {
        id: 'places',
        type: 'symbol',
        source: 'protomaps',
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
        id: 'road-labels',
        type: 'symbol',
        source: 'protomaps',
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
        id: 'trail-labels',
        type: 'symbol',
        source: 'protomaps',
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
    ],
  } as StyleSpecification;
}

/** Build the tile + glyph URLs from the browser origin (same-origin serving). */
export function mapAssetUrls(origin: string): MapStyleOptions {
  return {
    tilesUrl: `${origin}/tiles/bulgaria.pmtiles`,
    glyphsUrl: `${origin}/fonts/{fontstack}/{range}.pbf`,
  };
}
