/**
 * External raster basemap layers (operator request, 2026-07-25): CyclOSM,
 * Thunderforest Transport, Tracestrack Topo — the OSM-ecosystem renderings a
 * cyclist, a commuter or a hiker actually wants under the facility pins.
 *
 * Client-safe TYPES ONLY in this file. The catalogue itself is built
 * server-side (`external-layers.ts`) because two of the three need API keys
 * read from env at request time — never NEXT_PUBLIC, never baked into the
 * client bundle at build (the key still appears in tile URLs, which is how
 * these providers work; restrict the keys by domain in their dashboards).
 *
 * PRIVACY NOTE, stated where the code is: choosing an external layer makes
 * the BROWSER fetch tiles directly from that provider — the visitor's IP and
 * viewport reach OSM France / Thunderforest / Tracestrack. That is a
 * deliberate departure from the fully self-hosted default basemap, it only
 * happens on the visitor's explicit choice, and the privacy page says so.
 * The default remains the self-hosted pmtiles basemap.
 */

export type ExternalLayerId = 'cyclosm' | 'transport' | 'topo';

export interface ExternalMapLayer {
  id: ExternalLayerId;
  /** Raster tile URL templates ({z}/{x}/{y}); keys already interpolated. */
  tiles: string[];
  /** Shown by MapLibre's attribution control while the layer is visible. */
  attribution: string;
  maxzoom: number;
}

/** The switcher's "no external layer" value — the self-hosted basemap. */
export const DEFAULT_LAYER = 'default';
