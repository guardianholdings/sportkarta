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
        minzoom: 8,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#ffffff',
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 16, 5],
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
