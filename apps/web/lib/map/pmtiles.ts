import * as maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';

// Process-global MapLibre setup, done exactly once and shared by every
// MapLibre instance (main map, facility mini-maps, the add-facility pin
// picker), each of which calls this before constructing its map. Imports
// maplibre, so this module is only ever pulled into client-only (ssr:false)
// chunks.
let registered = false;

export function ensurePmtilesProtocol(): void {
  if (registered) return;
  // MapLibre 6 ships its worker as a separate ES module that it cannot locate
  // by itself under a bundler (v5 inlined it as a blob). This exact
  // `new URL(…, import.meta.url)` shape is what webpack and Turbopack
  // recognise: Next.js emits the worker as a hashed, same-origin static asset,
  // so no `blob:` is needed in a CSP. It must run before the first map exists.
  maplibregl.setWorkerUrl(
    new URL('maplibre-gl/dist/maplibre-gl-worker.mjs', import.meta.url).toString(),
  );
  const protocol = new Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);
  registered = true;
}
