import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';

// The pmtiles Protocol is process-global; register it exactly once, shared by
// every MapLibre instance (main map + facility mini-maps). Imports maplibre,
// so this module is only ever pulled into client-only (ssr:false) chunks.
let registered = false;

export function ensurePmtilesProtocol(): void {
  if (registered) return;
  const protocol = new Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);
  registered = true;
}
